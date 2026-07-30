// check-postings — verifies that tracked jobs' postings are still live, so a
// role that was quietly taken down never sits on the board looking healthy.
// Two-rung ladder (ported from santifer/career-ops check-liveness):
//   rung 1: the ATS's own public API (greenhouse/lever/ashby/workday) — free,
//           authoritative; 404/410 = removed, 200 = live.
//   rung 2: plain fetch of the posting page + deterministic soft-404
//           classification (src/lib/liveness.js) for everything else.
// Conservative on purpose: ambiguity is 'uncertain', never 'gone'. Results are
// written to jobs.posting_state for the UI to surface — nothing is archived
// or moved automatically.
import { requireUser, json, errorResponse } from './lib/auth.mjs';
import { stripHtml } from './lib/html.mjs';
import { resolveAtsApi, classifyAshbyBoard, classifyLiveness, livenessToState } from '../../apps/runway/src/lib/liveness.js';
import { BLOCKED_HOSTS } from '../../apps/runway/src/lib/jobsource.js';

const ACTIVE_STAGES = ['saved', 'researching', 'applied', 'phone_screen', 'interview'];
const BATCH_LIMIT = 8;          // client loops until remaining = 0
const TIME_BUDGET_MS = 7000;    // stop starting new checks near the function timeout
const FETCH_TIMEOUT_MS = 6000;
const INTER_CHECK_DELAY_MS = 250; // never hammer one ATS host (career-ops hard rule: sequential only)

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// SSRF guard on user-entered job URLs (upstream carries the same guard):
// never fetch private/link-local/literal-IP hosts, and only http(s).
const PRIVATE_HOST_RE = /^(localhost|.*\.local|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?fe80:|\[?f[cd])/i;
const IP_LITERAL_RE = /^\[|^\d{1,3}(\.\d{1,3}){3}$/;
function fetchableJobUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  if (PRIVATE_HOST_RE.test(host) || IP_LITERAL_RE.test(host)) return null;
  return u;
}

// clamp every fetch to what's left of the function's hard budget, so a check
// that has already started can't push the function past Netlify's ~10s limit
const timeLeft = (deadlineAt) => Math.max(0, deadlineAt - Date.now());
const clampTimeout = (deadlineAt) => Math.min(FETCH_TIMEOUT_MS, Math.max(500, timeLeft(deadlineAt)));

async function apiRung(ats, deadlineAt) {
  // Workday's CXS 500s/429s bare server requests — the browser-like header
  // set is the same ported fix fetchWorkday uses.
  const wdOrigin = ats.ats === 'workday' ? new URL(ats.apiUrl).origin : null;
  const headers = wdOrigin
    ? { accept: 'application/json', 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', origin: wdOrigin, referer: `${wdOrigin}/` }
    : { accept: 'application/json', 'user-agent': 'runway-liveness/1.0' };
  let res;
  try {
    res = await fetch(ats.apiUrl, {
      headers,
      redirect: 'error', // a redirected board slug is uncertain, not dead
      signal: AbortSignal.timeout(clampTimeout(deadlineAt)),
    });
  } catch { return null; } // network/timeout/redirect → inconclusive
  if (res.status === 404 || res.status === 410) {
    return { result: 'expired', code: `${ats.ats}_api_gone`, reason: `ATS API ${res.status} — posting removed` };
  }
  if (res.status === 200) {
    if (ats.ats === 'ashby') {
      try { return classifyAshbyBoard(await res.json(), ats.jobId); } catch { return null; }
    }
    return { result: 'active', code: `${ats.ats}_api_ok`, reason: 'live on the ATS API' };
  }
  return null; // 429/5xx/anything else — never mark expired on a rate limit
}

const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
const MAX_REDIRECTS = 5;

async function htmlRung(url, deadlineAt) {
  let res, body;
  // Redirects are followed BY HAND so the guard applies to every hop. With
  // `redirect: 'follow'` the runtime walked straight out of fetchableJobUrl,
  // which only ever saw the URL stored on the job: a posting on a public host
  // that 302s to 169.254.169.254 or an RFC1918 address was fetched anyway.
  let current = url;
  try {
    for (let hop = 0; ; hop += 1) {
      res = await fetch(current, {
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
        redirect: 'manual',
        signal: AbortSignal.timeout(clampTimeout(deadlineAt)),
      });
      const location = REDIRECT_STATUSES.includes(res.status) ? res.headers.get('location') : null;
      if (!location) break;
      if (hop >= MAX_REDIRECTS) {
        return { result: 'uncertain', code: 'too_many_redirects', reason: `more than ${MAX_REDIRECTS} redirects` };
      }
      const next = fetchableJobUrl(new URL(location, current).href);
      if (!next) {
        return { result: 'uncertain', code: 'unfetchable_redirect', reason: 'redirected to an address that is not a public http(s) host' };
      }
      current = next.href;
    }
    body = await res.text();
  } catch (ex) {
    return { result: 'uncertain', code: 'fetch_failed', reason: String(ex.message || ex) };
  }
  return classifyLiveness({
    status: res.status,
    requestedUrl: url,
    finalUrl: current,
    bodyText: stripHtml(body), // MIN_CONTENT check must see stripped text, not raw HTML
  });
}

async function checkOne(url, deadlineAt) {
  const ats = resolveAtsApi(url);
  if (ats) {
    const verdict = await apiRung(ats, deadlineAt);
    if (verdict) return verdict;
    // Ashby and Workday posting pages are JS-rendered — a static HTML check
    // false-reports live postings as dead, so the API rung is authoritative.
    if (ats.ats === 'ashby' || ats.ats === 'workday') {
      return { result: 'uncertain', code: `${ats.ats}_api_inconclusive`, reason: `${ats.ats} API did not answer definitively` };
    }
  }
  const u = fetchableJobUrl(url);
  if (!u) {
    return { result: 'uncertain', code: 'unfetchable_url', reason: 'not a fetchable public http(s) URL' };
  }
  const host = u.hostname.toLowerCase();
  if (BLOCKED_HOSTS.some((b) => host === b || host.endsWith(`.${b}`))) {
    return { result: 'uncertain', code: 'blocked_host', reason: `${host} can't be checked automatically (ToS)` };
  }
  return htmlRung(u.href, deadlineAt);
}

export const handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
    const { supa } = await requireUser(event);
    const started = Date.now();
    const deadlineAt = started + 8500; // hard fetch deadline inside Netlify's ~10s

    // due = never checked, or last checked over an hour ago — so the client's
    // batch loop terminates once everything has a fresh verdict
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { data: jobs, error } = await supa
      .from('jobs')
      .select('id, url, posting_checked_at')
      .in('status', ACTIVE_STAGES)
      .not('url', 'is', null)
      .or(`posting_checked_at.is.null,posting_checked_at.lt.${cutoff}`)
      .order('posting_checked_at', { ascending: true, nullsFirst: true })
      .limit(BATCH_LIMIT + 1); // +1 so `remaining` can signal another pass
    if (error) throw new Error(`jobs read failed: ${error.message}`);

    const batch = (jobs || []).slice(0, BATCH_LIMIT);
    const summary = { checked: 0, live: 0, gone: 0, uncertain: 0, remaining: Math.max(0, (jobs || []).length - BATCH_LIMIT), results: [] };

    for (const job of batch) {
      if (Date.now() - started > TIME_BUDGET_MS) { summary.remaining += batch.length - summary.checked; break; }
      if (summary.checked > 0) await sleep(INTER_CHECK_DELAY_MS);
      const verdict = await checkOne(job.url, deadlineAt);
      const state = livenessToState(verdict.result);
      summary.checked += 1;
      summary[state === 'live' ? 'live' : state === 'gone' ? 'gone' : 'uncertain'] += 1;
      summary.results.push({ id: job.id, state, code: verdict.code });
      const { error: upErr } = await supa
        .from('jobs')
        .update({
          posting_state: state,
          posting_checked_at: new Date().toISOString(),
          posting_note: [verdict.code, verdict.reason].filter(Boolean).join(': ').slice(0, 500),
        })
        .eq('id', job.id);
      if (upErr) summary.results[summary.results.length - 1].write_error = upErr.message;
    }

    return json(200, summary);
  } catch (ex) {
    return errorResponse(ex);
  }
};

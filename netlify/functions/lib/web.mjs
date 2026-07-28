// ═══════════════════════════════════════════════════════════════════════════
// WEB — letting the engines look things up.
//
// Every AI call in The Pentagon has been one blind completion. outbound-engine
// writes to a prospect using `website_context` scraped once, at prospecting
// time, possibly weeks ago. content-engine picks a topic knowing only the
// titles it has already written. Neither can check whether anything it is about
// to assert is still true.
//
// This gives them the web — through Anthropic's SERVER-SIDE tools, not a
// scraper of our own. That choice is the whole security story: the search and
// the fetch happen on Anthropic's infrastructure, so this repo gains no new
// vendor, no new API key, no outbound HTTP to attacker-influenced URLs from our
// own functions, and therefore no SSRF surface. netlify/functions/lib/
// scan-core and check-postings each had to grow their own private-IP guard for
// exactly that reason; this path does not need one.
//
// TOOL VERSIONS ARE MODEL-GATED. The `_20260209` variants carry dynamic
// filtering and require Opus 4.6+/Sonnet 4.6+; older models get the basic
// variants. DEFAULT_MODEL is claude-sonnet-4-6, so the engines get the good
// ones — but the Haiku paths do not, and picking the wrong pair is a 400 rather
// than a downgrade. toolsFor() resolves it from the model id instead of hoping.
//
// THREE THINGS THIS FILE EXISTS TO GET RIGHT, all of them silent if wrong:
//
//   1. SERVER-TOOL ERRORS DO NOT THROW. A failed search returns HTTP 200 with
//      an error object where the results should be. On web_search a SUCCESS
//      carries a list and an ERROR carries an object — code that iterates
//      `.content` without checking gets a character-by-character walk over an
//      object's keys and reports zero results from a broken search. Every
//      failure is collected and returned; the caller can tell "found nothing"
//      from "could not look".
//   2. `pause_turn` IS NOT AN ANSWER. The server-side loop caps at 10
//      iterations and hands back a partial turn. Treating it as final silently
//      truncates the research. It is resumed, up to a bounded number of times.
//   3. THE CHARTER REQUIRES A CITATION. @cc/mind's governance says every claim
//      names the signal it came from. A model that searched and then wrote from
//      memory satisfies nothing, so the sources are extracted and returned
//      alongside the text — the caller can refuse a draft that cites none.
//
// BUDGET. Scheduled functions get 30 seconds total. Search costs seconds and
// its own per-search fee on top of tokens, so `deadlineMs` bounds the WHOLE
// loop rather than each request, and `maxSearches` bounds the spend. A pass
// that runs out of clock returns what it has with `timedOut: true` — partial
// and labelled beats nothing and silent.
// ═══════════════════════════════════════════════════════════════════════════
import { estimateCost } from '@cc/ai';

const API = 'https://api.anthropic.com/v1/messages';
const VERSION = '2023-06-01';

/** Models that support the dynamic-filtering tool variants. Anything else gets
 *  the basic ones; pairing a new tool type with an old model is a 400. */
const DYNAMIC_FILTERING = /^claude-(opus-(4-6|4-7|4-8|5)|sonnet-(4-6|5)|fable-5|mythos-5)$/;

export function toolsFor(model, { maxSearches = 5, allowedDomains = null, blockedDomains = null, fetch: allowFetch = true } = {}) {
  const modern = DYNAMIC_FILTERING.test(String(model));
  const search = {
    type: modern ? 'web_search_20260209' : 'web_search_20250305',
    name: 'web_search',
    max_uses: maxSearches,
  };
  // Domain scoping is the cheapest correctness lever available: an engine told
  // to research a prospect has no business reading a forum. Only one of the two
  // lists may be set — sending both is rejected.
  if (allowedDomains?.length) search.allowed_domains = allowedDomains;
  else if (blockedDomains?.length) search.blocked_domains = blockedDomains;

  if (!allowFetch) return [search];

  const fetchTool = {
    type: modern ? 'web_fetch_20260209' : 'web_fetch_20250910',
    name: 'web_fetch',
    max_uses: maxSearches,
    // Bounded so one enormous page cannot eat the context the draft needs.
    max_content_tokens: 20_000,
  };
  if (allowedDomains?.length) fetchTool.allowed_domains = allowedDomains;
  else if (blockedDomains?.length) fetchTool.blocked_domains = blockedDomains;

  // NOTE: do NOT also declare code_execution here. The _20260209 tools run it
  // under the hood for dynamic filtering, and a second execution environment
  // confuses the model about which one it is in.
  return [search, fetchTool];
}

export function anthropicKey() {
  const key = process.env.ANTHROPIC_API_KEY || process.env.VITE_ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_ENV_MISSING: ANTHROPIC_API_KEY — web research stays off until set');
  return key;
}

/** One request in the loop. Named throws for every failure class, matching
 *  lib/anthropic.mjs — an engine that cannot tell "rate limited" from "bad key"
 *  cannot decide whether retrying is sane. */
async function post(body, key, signal) {
  let res;
  try {
    res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': VERSION },
      body: JSON.stringify(body),
      signal,
    });
  } catch (ex) {
    if (ex.name === 'AbortError') throw new Error('WEB_TIMEOUT: deadline reached mid-request');
    throw new Error(`ANTHROPIC_UNREACHABLE: ${ex.message}`);
  }
  if (res.status === 401) throw new Error('ANTHROPIC_UNAUTHORIZED: key rejected');
  if (res.status === 429) throw new Error('ANTHROPIC_RATE_LIMITED');
  if (res.status === 529) throw new Error('ANTHROPIC_OVERLOADED');
  if (!res.ok) throw new Error(`ANTHROPIC_HTTP_${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

/**
 * Pull results, sources and FAILURES out of one response's content blocks.
 *
 * The shape rule that makes this necessary: on a `web_search_tool_result`,
 * `.content` is an ARRAY of results when the search worked and an OBJECT
 * carrying `error_code` when it did not. Branch on that before iterating, or a
 * failed search reads as an empty one.
 */
export function readBlocks(content = []) {
  const text = [];
  const sources = [];
  const errors = [];
  let searches = 0;
  let fetches = 0;

  for (const block of content) {
    if (block?.type === 'text' && block.text) { text.push(block.text); continue; }

    if (block?.type === 'web_search_tool_result') {
      searches += 1;
      const c = block.content;
      if (Array.isArray(c)) {
        for (const r of c) {
          if (r?.url) sources.push({ kind: 'search', url: r.url, title: r.title || null, age: r.page_age || null });
        }
      } else if (c && typeof c === 'object') {
        errors.push({ tool: 'web_search', code: c.error_code || 'unknown' });
      }
      continue;
    }

    if (block?.type === 'web_fetch_tool_result') {
      fetches += 1;
      const c = block.content;
      // A fetch success is a single object carrying a document; an error is an
      // object carrying error_code. Same container, different key — so test for
      // the failure marker rather than for the shape.
      if (c && typeof c === 'object' && c.error_code) {
        errors.push({ tool: 'web_fetch', code: c.error_code });
      } else if (c?.url) {
        sources.push({ kind: 'fetch', url: c.url, title: c.content?.title || null, age: c.retrieved_at || null });
      }
    }
  }

  return { text: text.join('').trim(), sources, errors, searches, fetches };
}

/**
 * A completion that may search and read the web before answering.
 *
 * @returns {Promise<{text, model, usage, costUsd, sources, errors, searches,
 *                    fetches, turns, timedOut, stopReason}>}
 *
 * `sources` is the citation trail the charter demands. `errors` is non-empty
 * when a lookup failed — an empty `sources` with a non-empty `errors` means the
 * model wrote WITHOUT the research it asked for, which the caller should treat
 * as a failed pass rather than a thin one.
 */
export async function researchComplete({
  system,
  prompt,
  model = 'claude-sonnet-4-6',
  maxTokens = 4000,
  maxSearches = 5,
  allowedDomains = null,
  blockedDomains = null,
  allowFetch = true,
  deadlineMs = 22_000,
  maxTurns = 4,
}, key = anthropicKey()) {
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('ANTHROPIC_PROMPT_EMPTY');

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deadlineMs);

  const messages = [{ role: 'user', content: prompt }];
  const tools = toolsFor(model, { maxSearches, allowedDomains, blockedDomains, fetch: allowFetch });

  const all = { text: [], sources: [], errors: [], searches: 0, fetches: 0 };
  let inTok = 0, outTok = 0, turns = 0, timedOut = false, stopReason = null, resolvedModel = model;

  try {
    for (turns = 1; turns <= maxTurns; turns++) {
      const body = await post({
        model, max_tokens: maxTokens, tools, messages,
        ...(system ? { system } : {}),
      }, key, ctl.signal);

      resolvedModel = body.model || model;
      stopReason = body.stop_reason || null;
      inTok += body.usage?.input_tokens || 0;
      outTok += body.usage?.output_tokens || 0;

      const read = readBlocks(body.content || []);
      if (read.text) all.text.push(read.text);
      all.sources.push(...read.sources);
      all.errors.push(...read.errors);
      all.searches += read.searches;
      all.fetches += read.fetches;

      // `pause_turn` means the server-side loop hit its iteration cap mid-task.
      // Resume by echoing the assistant turn back with NO extra user message —
      // the API sees the trailing server_tool_use and continues on its own. A
      // "please continue" here would be read as a new instruction.
      if (stopReason !== 'pause_turn') break;
      messages.push({ role: 'assistant', content: body.content });
    }
  } catch (ex) {
    // A deadline hit after at least one turn is a partial result, not a
    // failure: the sources gathered so far are still worth returning, clearly
    // labelled. A deadline hit on the FIRST turn has nothing to return.
    if (/WEB_TIMEOUT/.test(ex.message) && all.text.length) timedOut = true;
    else { clearTimeout(timer); throw ex; }
  } finally {
    clearTimeout(timer);
  }

  if (turns > maxTurns && stopReason === 'pause_turn') timedOut = true;

  // Dedupe sources by URL, keeping first sight — the same page fetched twice is
  // one citation, and a citation list padded with repeats reads as thorough
  // research when it is one source read twice.
  const seen = new Set();
  const sources = all.sources.filter((s) => !seen.has(s.url) && seen.add(s.url));

  const text = all.text.join('\n').trim();
  if (!text && !timedOut) throw new Error('ANTHROPIC_EMPTY_RESPONSE');

  return {
    text,
    model: resolvedModel,
    usage: { inputTokens: inTok, outputTokens: outTok },
    // Token cost only. Web search carries a per-search fee on top of this, so
    // this figure UNDER-states a researching pass — callers feeding a spend cap
    // must add a per-search allowance rather than trusting it whole.
    costUsd: estimateCost(model, inTok, outTok),
    sources,
    errors: all.errors,
    searches: all.searches,
    fetches: all.fetches,
    turns: Math.min(turns, maxTurns),
    timedOut,
    stopReason,
  };
}

/**
 * Did the research actually happen?
 *
 * The check a caller should run before trusting a researched draft. Searching
 * and then writing from memory is the failure this guards: it looks like
 * research, costs like research, and cites nothing.
 */
export function researchQuality({ sources = [], errors = [], searches = 0, timedOut = false }) {
  if (!searches) return { ok: false, reason: 'no search was performed' };
  if (!sources.length) {
    return {
      ok: false,
      reason: errors.length
        ? `every lookup failed (${errors.map((e) => e.code).join(', ')}) — the draft was written blind`
        : 'searched but cited nothing',
    };
  }
  if (timedOut) return { ok: true, reason: `partial — ran out of clock after ${sources.length} source(s)`, partial: true };
  return { ok: true, reason: `${sources.length} source(s) across ${searches} search(es)` };
}

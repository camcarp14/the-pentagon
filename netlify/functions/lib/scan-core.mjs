// Board scan engine. Fetches each watched board's PUBLIC feed (every provider
// in lib/providers.mjs publishes one for exactly this purpose), dedupes
// against seen_postings, runs each posting through the role matcher, and QUEUES
// scored matches into the discovery inbox for triage (it never writes to the
// board directly — the user Accepts each one). Deterministic extraction only —
// no model calls during scans (a scan can touch hundreds of postings).
// Discovery only: nothing is ever submitted anywhere.
//
// ── MATCHING, AND THE TWO-PHASE COST RULE ───────────────────────────────────
// Matching used to be one line — a substring test on the title — and it is now
// matcher.js: synonym expansion, exclusions, must-haves, seniority distance,
// and a written reason for every verdict. That is strictly more work per
// posting, and a scan touches hundreds, so the ORDER it runs in is load-bearing:
//
//   Phase 1 (free): match against the TITLE, plus whatever body text the feed
//     already handed us. Most providers ship a description inline; Greenhouse
//     does not, and its detail endpoint is one HTTP call per posting.
//   Phase 2 (paid): only for postings that already look promising, fetch the
//     detail and re-score with the full text.
//
// The cost of that ordering, stated plainly: a Greenhouse posting whose title
// says nothing about your terms but whose BODY does will not be found. Fixing
// it would mean an HTTP request per posting per board per scan. The trade is
// deliberate; every other provider gets full body matching for free.
//
// ── HUNTS vs THE PROFILE ────────────────────────────────────────────────────
// When hunts exist, each posting is run against all active ones and attributed
// to the best-scoring match, so the inbox can say which search found it. With
// no hunts defined the profile is projected into an equivalent criteria set —
// so an account that never opens the hunt editor behaves exactly as before,
// only with better matching.
import { scoreJob } from '../../../apps/runway/src/lib/score.js';
import { extractCompRange, detectRemote, detectSeniority } from '../../../apps/runway/src/lib/quickparse.js';
import { detectRepost } from '../../../apps/runway/src/lib/rolematch.js';
import { matchPosting, criteriaFromProfile, criteriaFromHunt } from '../../../apps/runway/src/lib/matcher.js';
import { skillsForPosting } from '../../../apps/runway/src/lib/skills.js';
import { fetchBoard, greenhouseDetail } from './providers.mjs';

const QUEUE_CAP_PER_SCAN = 60; // queuing is non-destructive; a bigger cap than the old import path
const MAX_BOARDS_PER_SCAN = 12; // stay well inside the function timeout; client loops for the rest

// Phase-1 tiers worth paying a detail fetch for. A body-only hit on the feed's
// own summary text is already a real match and needs no upgrade; a title hit on
// a Greenhouse posting has no body at all yet and does.
const PROMISING = new Set(['title-exact', 'title-related', 'open']);

// Run one posting against every active hunt (or the profile, when there are
// none) and keep the strongest verdict. Returns { result, hunt } — hunt is null
// for the profile path. A kill in one hunt never suppresses a match in another:
// hunts are independent searches, and "excluded from my agency hunt" says
// nothing about my in-house hunt.
function evaluate(posting, hunts, profileCriteria) {
  if (!hunts.length) return { result: matchPosting(posting, profileCriteria), hunt: null };
  let best = null;
  for (const hunt of hunts) {
    const result = matchPosting(posting, criteriaFromHunt(hunt));
    if (!best) best = { result, hunt };
    // a matched result always beats an unmatched one; between two matched
    // results the higher score wins, and min_fit is the hunt's own floor
    const better =
      (result.matched && !best.result.matched) ||
      (result.matched === best.result.matched && result.score > best.result.score);
    if (better) best = { result, hunt };
  }
  if (best?.result.matched && best.result.score < (best.hunt?.min_fit || 0)) {
    return { result: { ...best.result, matched: false }, hunt: best.hunt };
  }
  return best;
}

// db: a Supabase client (user-scoped or service-role); userId set explicitly
// on every insert so both paths write identical rows.
export async function scanBoards({ db, userId }) {
  const [{ data: profile }, { data: boards, error: bErr }, { data: seenRows, error: sErr }, { data: huntRows }] = await Promise.all([
    db.from('target_profile').select('*').maybeSingle(),
    db.from('watch_boards').select('*').eq('user_id', userId),
    db.from('seen_postings').select('provider, board, external_id, status, company, title, first_seen_at').eq('user_id', userId),
    // A hunts table that does not exist yet (migration not applied) must not
    // take the scanner down — the profile path is a complete fallback.
    db.from('hunts').select('*').eq('user_id', userId).eq('active', true),
  ]);
  if (bErr) throw new Error(`watch_boards read failed: ${bErr.message}`);
  if (sErr) throw new Error(`seen_postings read failed: ${sErr.message}`);

  // collapse duplicate postings of the SAME role (boards list one per location):
  // only the first (company,title) gets queued; the rest are dedupe-logged.
  // Seed from every DECIDED status — queued, dismissed, or imported — so a role
  // you already dismissed doesn't come back when the board re-lists it under a
  // fresh id. Internal whitespace is collapsed so "Senior  Manager" == "Senior Manager".
  const titleKey = (company, title) =>
    `${company}|${String(title || '').trim().replace(/\s+/g, ' ').toLowerCase()}`;
  const knownTitles = new Set(
    (seenRows || [])
      .filter((r) => r.status === 'queued' || r.status === 'dismissed' || r.status === 'imported')
      .map((r) => titleKey(r.company, r.title)),
  );

  const hunts = Array.isArray(huntRows) ? huntRows : [];
  const profileCriteria = criteriaFromProfile(profile);
  // Nothing to match against at all. Only true when there are NO active hunts
  // AND the profile carries no keywords — a hunt with no role terms is a
  // deliberate "everything on my watched boards" search, not a misconfiguration,
  // and warning about it would be telling the user to fix something they meant.
  const noCriteria = hunts.length === 0 && profileCriteria.include.length === 0;

  const summary = {
    boards_scanned: 0, boards_total: (boards || []).length, boards_remaining: 0,
    postings_checked: 0, new_seen: 0, matched: 0, queued: 0, reposts_flagged: 0,
    hunts_active: hunts.length,
    queued_items: [], board_errors: [], keywords_missing: noCriteria,
  };
  if (!boards?.length) return summary;

  // least-recently-scanned first (never-scanned lead), so repeated scans
  // round-robin across every board without one big timeout-prone pass
  const ordered = [...boards].sort((a, b) => {
    const ta = a.last_scanned_at ? new Date(a.last_scanned_at).getTime() : 0;
    const tb = b.last_scanned_at ? new Date(b.last_scanned_at).getTime() : 0;
    return ta - tb;
  });
  const batch = ordered.slice(0, MAX_BOARDS_PER_SCAN);
  summary.boards_remaining = Math.max(0, ordered.length - batch.length);

  const seen = new Set((seenRows || []).map((r) => `${r.provider}|${r.board}|${r.external_id}`));

  // per-board history for repost (ghost-job) detection: prior rows only — the
  // DB snapshot from before this scan, so same-day multi-location siblings
  // never flag each other
  const priorByBoard = new Map();
  for (const r of seenRows || []) {
    const k = `${r.provider}|${r.board}`;
    if (!priorByBoard.has(k)) priorByBoard.set(k, []);
    priorByBoard.get(k).push(r);
  }

  for (const wb of batch) {
    let postings;
    try {
      postings = await fetchBoard(wb.provider, wb.board);
    } catch (ex) {
      summary.board_errors.push({ board: `${wb.provider}/${wb.board}`, error: String(ex.message || ex) });
      // dead-board streak: 3+ consecutive hard failures surfaces a warning on
      // the watchlist (an empty-but-reachable board resets — that's healthy).
      // last_scanned_at also moves so the failing board rotates to the back of
      // the round-robin — otherwise one "Scan now" loop re-tries it every
      // batch and inflates the streak in a single click.
      await db.from('watch_boards')
        .update({ last_scanned_at: new Date().toISOString(), consecutive_failures: (wb.consecutive_failures || 0) + 1 })
        .eq('id', wb.id);
      continue;
    }
    summary.boards_scanned += 1;
    summary.postings_checked += postings.length;

    const seenBatch = [];
    for (const p of postings) {
      const key = `${wb.provider}|${wb.board}|${p.external_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      summary.new_seen += 1;

      // flags is NOT NULL: every row in a bulk insert MUST carry the key, or
      // PostgREST unions the columns and writes NULL for the omitted ones,
      // failing the whole batch. So seed flags: [] on every seen row.
      const ignoredRow = () => ({
        user_id: userId, provider: wb.provider, board: wb.board,
        external_id: p.external_id, url: p.url, title: p.title,
        matched: false, status: 'ignored', flags: [], match_why: [], skills: [],
      });

      // ---- phase 1: title + whatever text the feed already gave us, free
      const candidate = {
        title: p.title,
        location: p.location,
        text: p.text || '',
        remote_type: detectRemote(`${p.title}\n${p.location || ''}\n${p.text || ''}`),
        seniority: detectSeniority(p.title),
        comp_min: null, comp_max: null,
      };
      const phase1 = evaluate(candidate, hunts, profileCriteria);
      const worthDetail = p.needsDetail && PROMISING.has(phase1.result.tier);
      if (!phase1.result.matched && !worthDetail) {
        // logged for dedupe only, never resurfaced
        seenBatch.push(ignoredRow());
        continue;
      }

      const company = wb.company_label || wb.board;
      const tkey = titleKey(company, p.title);
      // already decided on this role (another location, or a prior scan)? mark
      // this posting seen and move on — one card per role
      if (knownTitles.has(tkey)) {
        seenBatch.push({ ...ignoredRow(), matched: true });
        continue;
      }
      // over this pass's queue cap: do NOT mark it seen, so the next scan (once
      // the inbox drains) can still surface it — a match is never lost
      if (summary.queued >= QUEUE_CAP_PER_SCAN) continue;

      // repost (ghost-job) check against the board's pre-scan history: the
      // same role re-listed under a fresh posting id within 90 days
      const rep = detectRepost({ title: p.title, external_id: p.external_id },
        priorByBoard.get(`${wb.provider}|${wb.board}`) || []);

      let row = {
        user_id: userId, provider: wb.provider, board: wb.board,
        external_id: p.external_id, url: p.url, title: p.title,
        matched: true, status: 'queued', flags: rep.reposted ? ['reposted'] : [],
        company,
        location: p.location, seniority: candidate.seniority,
        remote_type: candidate.remote_type,
        hunt_id: phase1.hunt?.id ?? null,
        match_score: phase1.result.score,
        match_why: phase1.result.why,
        skills: [],
      };

      let verdict = phase1;
      try {
        // ---- phase 2: pay for the detail only where phase 1 earned it
        let text = p.text;
        if (worthDetail) text = await greenhouseDetail(wb.board, p.external_id);
        const hay = `${p.title}\n${p.location || ''}\n${text || ''}`;
        const { comp_min, comp_max } = extractCompRange(text || '');
        row.remote_type = detectRemote(hay);
        row.comp_min = comp_min;
        row.comp_max = comp_max;
        row.raw_description = (text || '').slice(0, 8000) || null;

        if (worthDetail) {
          verdict = evaluate({ ...candidate, text: text || '', remote_type: row.remote_type, comp_min, comp_max }, hunts, profileCriteria);
          row.hunt_id = verdict.hunt?.id ?? null;
          row.match_score = verdict.result.score;
          row.match_why = verdict.result.why;
          // The body can disqualify what the title promised — an exclusion term
          // or a comp ceiling under the floor only shows up down here. Logging
          // it as an ignored row rather than queuing it is the entire point of
          // paying for the detail fetch.
          if (!verdict.result.matched) {
            seenBatch.push({ ...ignoredRow(), matched: true });
            continue;
          }
        }

        row.skills = skillsForPosting({ title: p.title, raw_description: text || '' });
        const scored = scoreJob(row, profile); // row.flags carries 'reposted' into the penalty
        if (scored.score != null) {
          row.fit_score = scored.score;
          row.fit_rationale = scored.rationale;
          row.fit_breakdown = scored.breakdown;
          row.flags = scored.flags;
        }
      } catch (ex) {
        // detail fetch/scoring failed — queue the title-level card anyway
        row.remote_type = row.remote_type || 'unknown';
        summary.board_errors.push({ board: `${wb.provider}/${wb.board}`, error: `detail failed: ${String(ex.message || ex)}` });
      }

      if (rep.reposted) summary.reposts_flagged += 1;
      summary.matched += 1;
      summary.queued += 1;
      knownTitles.add(tkey);
      summary.queued_items.push({ company: row.company, title: row.title, fit_score: row.fit_score ?? null, match_score: row.match_score });
      seenBatch.push(row);
    }

    if (seenBatch.length) {
      const { error: insErr } = await db.from('seen_postings').insert(seenBatch);
      if (insErr) summary.board_errors.push({ board: `${wb.provider}/${wb.board}`, error: `discovery write failed: ${insErr.message}` });
    }
    await db.from('watch_boards')
      .update({ last_scanned_at: new Date().toISOString(), consecutive_failures: 0 })
      .eq('id', wb.id);
  }

  if (hunts.length) {
    // stamp the hunts that actually ran, so the editor can say when each last swept
    const ids = hunts.map((h) => h.id);
    await db.from('hunts').update({ last_run_at: new Date().toISOString() }).in('id', ids);
  }

  return summary;
}

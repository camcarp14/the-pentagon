// Board scan engine. Fetches each watched board's PUBLIC feed (every provider
// in lib/providers.mjs publishes one for exactly this purpose), dedupes
// against seen_postings, matches titles against the target profile's keywords,
// and QUEUES scored matches into the discovery inbox for triage (it never
// writes to the board directly — the user Accepts each one). Deterministic
// extraction only — no model calls during scans (a scan can touch hundreds of
// postings). Discovery only: nothing is ever submitted anywhere.
import { hasKeyword, scoreJob } from '../../../apps/runway/src/lib/score.js';
import { extractCompRange, detectRemote, detectSeniority } from '../../../apps/runway/src/lib/quickparse.js';
import { detectRepost } from '../../../apps/runway/src/lib/rolematch.js';
import { fetchBoard, greenhouseDetail } from './providers.mjs';

const QUEUE_CAP_PER_SCAN = 60; // queuing is non-destructive; a bigger cap than the old import path
const MAX_BOARDS_PER_SCAN = 12; // stay well inside the function timeout; client loops for the rest

// db: a Supabase client (user-scoped or service-role); userId set explicitly
// on every insert so both paths write identical rows.
export async function scanBoards({ db, userId }) {
  // Scoped by user_id like its two siblings: the cron path uses the service-role
  // client, which bypasses RLS, so an unscoped maybeSingle() would error on a
  // second profile row and land in the keywordless path below.
  const [{ data: profile, error: pErr }, { data: boards, error: bErr }, { data: seenRows, error: sErr }] = await Promise.all([
    db.from('target_profile').select('*').eq('user_id', userId).maybeSingle(),
    db.from('watch_boards').select('*').eq('user_id', userId),
    db.from('seen_postings').select('provider, board, external_id, status, company, title, first_seen_at').eq('user_id', userId),
  ]);
  // A discarded profile error read as "no keywords", and a keywordless pass used
  // to burn every open posting to 'ignored' permanently. Fail the scan instead.
  if (pErr) throw new Error(`target_profile read failed: ${pErr.message}`);
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

  const keywords = Array.isArray(profile?.title_keywords) ? profile.title_keywords : [];
  const summary = {
    boards_scanned: 0, boards_total: (boards || []).length, boards_remaining: 0,
    postings_checked: 0, new_seen: 0, matched: 0, queued: 0, reposts_flagged: 0,
    queued_items: [], board_errors: [], keywords_missing: keywords.length === 0,
  };
  if (!boards?.length) return summary;

  // With no keywords nothing can match, and every posting fetched would be
  // written as status:'ignored' — a row the scan never re-evaluates, so the
  // roles open on the day the cron first ran before the profile was filled in
  // would never surface again. A scan that cannot match must consume nothing.
  if (keywords.length === 0) return summary;

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
      const matched = keywords.length > 0 && keywords.some((k) => hasKeyword(p.title, k));
      if (!matched) {
        // logged for dedupe only, never resurfaced
        seenBatch.push({
          user_id: userId, provider: wb.provider, board: wb.board,
          external_id: p.external_id, url: p.url, title: p.title,
          matched: false, status: 'ignored', flags: [],
        });
        continue;
      }

      summary.matched += 1;
      const company = wb.company_label || wb.board;
      const tkey = titleKey(company, p.title);
      // already decided on this role (another location, or a prior scan)? mark
      // this posting seen and move on — one card per role
      if (knownTitles.has(tkey)) {
        seenBatch.push({
          user_id: userId, provider: wb.provider, board: wb.board,
          external_id: p.external_id, url: p.url, title: p.title,
          matched: true, status: 'ignored', flags: [],
        });
        continue;
      }
      // over this pass's queue cap: do NOT mark it seen, so the next scan (once
      // the inbox drains) can still surface it — a match is never lost
      if (summary.queued >= QUEUE_CAP_PER_SCAN) continue;
      knownTitles.add(tkey);

      // repost (ghost-job) check against the board's pre-scan history: the
      // same role re-listed under a fresh posting id within 90 days
      const rep = detectRepost({ title: p.title, external_id: p.external_id },
        priorByBoard.get(`${wb.provider}|${wb.board}`) || []);
      if (rep.reposted) summary.reposts_flagged += 1;

      // a title match: fetch detail if needed, score it, and QUEUE it
      let row = {
        user_id: userId, provider: wb.provider, board: wb.board,
        external_id: p.external_id, url: p.url, title: p.title,
        matched: true, status: 'queued', flags: rep.reposted ? ['reposted'] : [],
        company,
        location: p.location, seniority: detectSeniority(p.title),
      };
      try {
        let text = p.text;
        if (p.needsDetail) text = await greenhouseDetail(wb.board, p.external_id);
        const hay = `${p.title}\n${p.location || ''}\n${text || ''}`;
        const { comp_min, comp_max } = extractCompRange(text || '');
        row.remote_type = detectRemote(hay);
        row.comp_min = comp_min;
        row.comp_max = comp_max;
        row.raw_description = (text || '').slice(0, 8000) || null;
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
      summary.queued += 1;
      summary.queued_items.push({ company: row.company, title: row.title, fit_score: row.fit_score ?? null });
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

  return summary;
}

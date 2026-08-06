// discover-companies — the answer to "who else is hiring for what I do?"
//
// THE CEILING THIS LIFTS: everything Runway could find was bounded by the
// companies you had already thought of. Watching is per-company, so the funnel
// started with an act of recall — and you cannot recall an employer you have
// never heard of. The starter packs helped and then stopped helping, because a
// pack is a fixed list that everyone gets.
//
// So this walks a pool of company NAMES (lib/companyUniverse.js), finds each
// one's public board live, fetches it, and runs every posting through the same
// matcher the scanner uses. What comes back is not "companies that exist" — it
// is companies ranked by HOW MANY ROLES THEY HAVE FOR YOU, with the matching
// titles attached as evidence. A company with 400 openings and none of them
// yours ranks below one with three that are.
//
// COST CONTROL, because this is the most expensive thing in the tool:
//   • batched — `offset`/`limit` walk the pool across several calls, the client
//     loops, and each invocation stays inside the function timeout.
//   • two-tier probing — the three providers that host most boards are tried
//     first; the long tail costs 10 more requests per company and is only paid
//     when `deep` is set.
//   • already-watched companies are skipped before any request is made.
//   • boards are fetched ONCE and matched in memory — no per-posting detail
//     fetches here. Discovery works off titles, which is what a ranking needs;
//     the full-text pass happens later, in the scan, for boards you accept.
//
// It writes nothing. Every hit is a suggestion the user accepts or ignores.
import { requireUser, json, errorResponse } from './lib/auth.mjs';
import { probeCompany, COMMON_PROVIDERS, ALL_PROVIDERS } from './lib/boardprobe.mjs';
import { fetchBoard } from './lib/providers.mjs';
import { matchPosting, criteriaFromProfile, criteriaFromHunt } from '../../apps/runway/src/lib/matcher.js';
import { detectSeniority, detectRemote } from '../../apps/runway/src/lib/quickparse.js';
import { orderedCompanies, companyCount } from '../../apps/runway/src/lib/companyUniverse.js';

const BATCH = 8;          // companies probed per invocation
const MAX_BATCH = 14;     // ceiling even if the caller asks for more
const SAMPLE_TITLES = 4;  // matching titles returned as evidence per company

export const handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
    const { user, supa } = await requireUser(event);

    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch { /* handled below */ }
    const offset = Math.max(0, Number(body.offset) || 0);
    const limit = Math.min(MAX_BATCH, Math.max(1, Number(body.limit) || BATCH));
    const deep = body.deep === true;
    const huntId = body.hunt_id ? String(body.hunt_id) : null;
    // A caller-supplied list overrides the pool entirely — this is the "here
    // are 40 companies I care about, go check them" path.
    const custom = Array.isArray(body.companies)
      ? body.companies.map((c) => (typeof c === 'string' ? { name: c, vertical: 'custom' } : c)).filter((c) => c?.name)
      : null;

    const [{ data: profile }, { data: watched }, { data: hunts }] = await Promise.all([
      supa.from('target_profile').select('*').maybeSingle(),
      supa.from('watch_boards').select('provider, board, company_label').eq('user_id', user.id),
      supa.from('hunts').select('*').eq('user_id', user.id).eq('active', true),
    ]);

    // Criteria: the named hunt, else the first active hunt, else the profile.
    // Discovery is only as good as what it is aiming at, so the response says
    // which criteria produced it — a wrong-looking result set is usually a
    // wrong-looking hunt, and the UI can point at it.
    const activeHunts = Array.isArray(hunts) ? hunts : [];
    const hunt = huntId ? activeHunts.find((h) => h.id === huntId) : activeHunts[0];
    const criteria = hunt ? criteriaFromHunt(hunt) : criteriaFromProfile(profile);
    const criteriaLabel = hunt ? hunt.name : 'your target profile';
    if (!criteria.include.length) {
      return json(422, {
        error: 'Nothing to search for yet — add role terms to a hunt (or title keywords on Profile) and run this again.',
      });
    }

    const watchedBoards = new Set((watched || []).map((w) => `${w.provider}|${w.board}`));
    const watchedNames = new Set((watched || []).map((w) => String(w.company_label || '').toLowerCase()).filter(Boolean));

    const pool = custom || orderedCompanies({
      industriesIn: Array.isArray(profile?.industries_in) ? profile.industries_in : [],
    });
    const slice = pool.slice(offset, offset + limit);
    const providers = deep ? ALL_PROVIDERS : COMMON_PROVIDERS;

    const results = await Promise.all(slice.map(async (co) => {
      if (watchedNames.has(co.name.toLowerCase())) return { name: co.name, skipped: 'already watching' };
      let hits;
      try {
        hits = await probeCompany(co.name, { providers, maxSlugs: 2 });
      } catch { return { name: co.name, skipped: 'probe failed' }; }
      if (!hits.length) return { name: co.name, skipped: 'no public board' };

      const hit = hits[0];
      if (watchedBoards.has(`${hit.provider}|${hit.board}`)) return { name: co.name, skipped: 'already watching' };

      let postings;
      try {
        postings = await fetchBoard(hit.provider, hit.board);
      } catch (ex) {
        return { name: co.name, skipped: `board unreadable: ${String(ex.message || ex)}` };
      }

      const matches = [];
      for (const p of postings) {
        const r = matchPosting({
          title: p.title,
          location: p.location,
          text: p.text || '',
          remote_type: detectRemote(`${p.title}\n${p.location || ''}\n${p.text || ''}`),
          seniority: detectSeniority(p.title),
        }, criteria);
        if (r.matched) matches.push({ title: p.title, url: p.url, location: p.location, score: r.score });
      }
      if (!matches.length) return { name: co.name, vertical: co.vertical, open_roles: postings.length, matching_roles: 0, skipped: 'no matching roles' };

      matches.sort((a, b) => b.score - a.score);
      return {
        name: co.name,
        vertical: co.vertical,
        provider: hit.provider,
        board: hit.board,
        open_roles: postings.length,
        matching_roles: matches.length,
        // The ranking signal is not the raw count: two strong matches beat
        // eight weak ones, and a big board with a low hit-rate is usually a
        // company that lists everything rather than one that wants you.
        rank: Math.round(matches.reduce((s, m) => s + m.score, 0) / 10),
        best_score: matches[0].score,
        samples: matches.slice(0, SAMPLE_TITLES),
      };
    }));

    const found = results.filter((r) => r && r.matching_roles > 0).sort((a, b) => b.rank - a.rank);
    const checked = results.filter(Boolean).length;
    const next = offset + limit;

    return json(200, {
      criteria_label: criteriaLabel,
      hunt_id: hunt?.id ?? null,
      deep,
      checked,
      offset,
      next_offset: next < pool.length ? next : null,
      pool_size: pool.length,
      universe_size: companyCount,
      found,
      // Non-hits are returned too, in compact form: "we checked 8 and 5 have no
      // public board" is information, and without it a run that found nothing
      // is indistinguishable from a run that broke.
      passed_over: results.filter((r) => r && !r.matching_roles).map((r) => ({ name: r.name, why: r.skipped || 'no matching roles' })),
    });
  } catch (ex) {
    return errorResponse(ex);
  }
};

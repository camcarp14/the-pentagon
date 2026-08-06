// find-board — turns a typed company NAME into its watchable job board by
// probing the public feed providers for likely slugs. Read-only probes of
// feeds published for public consumption; nothing is scraped. Provider census
// ported from santifer/career-ops. Workday is the one watchable provider that
// can't be name-probed (tenant.instance/site is not derivable from a name) —
// paste its board URL instead.
//
// The probes themselves live in lib/boardprobe.mjs, shared with company
// discovery. One census of providers, two callers.
import { requireUser, json, errorResponse } from './lib/auth.mjs';
import { probeCompany } from './lib/boardprobe.mjs';
import { slugCandidates } from '../../apps/runway/src/lib/jobsource.js';

export const handler = async (event) => {
  try {
    if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });
    await requireUser(event);

    let body = {};
    try { body = JSON.parse(event.body || '{}'); } catch { /* handled below */ }
    const name = String(body.name || '').trim();
    if (!name) return json(400, { error: 'Provide a company name' });

    if (!slugCandidates(name).length) return json(400, { error: 'Could not derive a board name from that input' });

    // A typed name is one company and the user is waiting on it, so this path
    // pays for the full provider sweep and three slug spellings — unlike bulk
    // discovery, which trades depth for breadth.
    const hits = await probeCompany(name, { maxSlugs: 3 });

    return json(200, { name, hits });
  } catch (ex) {
    return errorResponse(ex);
  }
};

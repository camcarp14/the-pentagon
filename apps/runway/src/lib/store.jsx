// Global data layer. Single user, small data — load everything once, keep it
// in memory, mutate optimistically. Finding any job's current stage never
// costs a network round trip.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from './supabase.js';
import { apiPost } from './api.js';
import { scoreJob } from './score.js';
import { computeMetrics } from './metrics.js';
import { discoveryToJob } from './discovery.js';
import { seedFollowUp } from './cadence.js';
import { skillsForPosting } from './skills.js';

export const STAGES = [
  { id: 'saved', label: 'Saved' },
  { id: 'researching', label: 'Researching' },
  { id: 'applied', label: 'Applied' },
  { id: 'phone_screen', label: 'Phone Screen' },
  { id: 'interview', label: 'Interview' },
  { id: 'offer', label: 'Offer' },
  { id: 'closed', label: 'Closed' },
];
export const stageLabel = (id) => STAGES.find((s) => s.id === id)?.label || id;
export const REMOTE_TYPES = ['remote', 'hybrid', 'onsite', 'unknown'];

export const fmtComp = (min, max) => {
  const k = (n) => `$${Math.round(n / 1000)}k`;
  if (min == null && max == null) return null;
  if (min != null && max != null) return min === max ? k(min) : `${k(min)}–${k(max)}`;
  return min != null ? `${k(min)}+` : `up to ${k(max)}`;
};

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

export function AppProvider({ children }) {
  const [session, setSession] = useState(undefined); // undefined = booting, null = signed out
  const [jobs, setJobs] = useState(null);            // null = loading
  const [events, setEvents] = useState(null);
  const [followUps, setFollowUps] = useState(null);
  const [profile, setProfile] = useState(null);
  const [boards, setBoards] = useState(null);        // watched job boards
  const [discoveries, setDiscoveries] = useState(null); // queued scan candidates
  const [hunts, setHunts] = useState(null);          // saved searches
  const [resume, setResume] = useState(null);        // master resume CONTENT (not the row)
  // Compact projection of every posting the scanner has ever MATCHED — the
  // sample the skills read is computed over. Deliberately not the full rows:
  // raw_description is up to 8kB each and none of it is needed here, so this
  // selects the seven columns that are and nothing else.
  const [marketPostings, setMarketPostings] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [checkingPostings, setCheckingPostings] = useState(false);
  const [loadError, setLoadError] = useState(null);

  // updateJob is a stable callback (empty deps) — it reads follow-ups through
  // a ref so the seed-on-Applied idempotency check never sees a stale list
  const followUpsRef = useRef(null);
  useEffect(() => { followUpsRef.current = followUps; }, [followUps]);
  const seedingRef = useRef(new Set()); // job ids with a seed insert in flight

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const refresh = useCallback(async () => {
    setLoadError(null);
    const [j, e, f, p, w, d, h, r, m] = await Promise.all([
      supabase.from('jobs').select('*').order('created_at', { ascending: false }),
      supabase.from('pipeline_events').select('*').order('changed_at', { ascending: true }),
      supabase.from('follow_ups').select('*').order('due_date', { ascending: true }),
      supabase.from('target_profile').select('*').maybeSingle(),
      supabase.from('watch_boards').select('*').order('created_at', { ascending: true }),
      supabase.from('seen_postings').select('*').eq('status', 'queued').order('fit_score', { ascending: false, nullsFirst: false }),
      supabase.from('hunts').select('*').order('created_at', { ascending: true }),
      supabase.from('resume_master').select('content').maybeSingle(),
      supabase.from('seen_postings')
        .select('id, company, title, fit_score, skills, seniority, comp_min, comp_max, status')
        .eq('matched', true).limit(1200),
    ]);
    // Hunts, the resume and the market projection are NOT in the fatal set.
    // The first two are additive features and the third is one page's input;
    // a project that has not run the hunts migration yet must still open the
    // board, not show "couldn't load your data" over a working pipeline.
    const err = j.error || e.error || f.error || p.error || w.error || d.error;
    if (err) { setLoadError(err.message); return; }
    setJobs(j.data); setEvents(e.data); setFollowUps(f.data); setProfile(p.data); setBoards(w.data); setDiscoveries(d.data);
    setHunts(h.error ? [] : (h.data || []));
    setResume(r.error ? {} : (r.data?.content || {}));
    setMarketPostings(m.error ? [] : (m.data || []));
  }, []);

  useEffect(() => {
    if (session) refresh();
    else if (session === null) {
      setJobs(null); setEvents(null); setFollowUps(null); setProfile(null);
      setBoards(null); setDiscoveries(null); setHunts(null); setResume(null); setMarketPostings(null);
    }
  }, [session, refresh]);

  // ---------- jobs ----------
  const addJob = useCallback(async (fields) => {
    const scored = scoreJob(fields, profile);
    const row = {
      ...fields,
      // Extracted once, here, rather than on every render of the Skills page:
      // the same deterministic pass the scanner runs, so a job captured by
      // hand and a job accepted from the inbox carry identical skill arrays.
      skills: Array.isArray(fields.skills) && fields.skills.length ? fields.skills : skillsForPosting(fields),
      ...(scored.score != null
        ? { fit_score: scored.score, fit_rationale: scored.rationale, fit_breakdown: scored.breakdown, flags: scored.flags }
        : {}),
    };
    const { data, error } = await supabase.from('jobs').insert(row).select().single();
    if (error) throw error;
    setJobs((xs) => [data, ...(xs || [])]);
    // the DB trigger logged a 'captured' event; mirror it locally
    setEvents((xs) => [...(xs || []), { id: `local-${data.id}`, job_id: data.id, stage: data.status, note: 'captured', changed_at: data.created_at }]);
    return data;
  }, [profile]);

  const updateJob = useCallback(async (id, patch) => {
    let prev;
    setJobs((xs) => (xs || []).map((x) => (x.id === id ? ((prev = x), { ...x, ...patch }) : x)));
    const { data, error } = await supabase.from('jobs').update(patch).eq('id', id).select().single();
    if (error) {
      if (prev) setJobs((xs) => (xs || []).map((x) => (x.id === id ? prev : x)));
      throw error;
    }
    setJobs((xs) => (xs || []).map((x) => (x.id === id ? data : x)));
    if (prev && patch.status && patch.status !== prev.status) {
      setEvents((xs) => [...(xs || []), { id: `local-${id}-${Date.now()}`, job_id: id, stage: patch.status, note: null, changed_at: new Date().toISOString() }]);
      // seed-on-Applied (career-ops cadence): first follow-up lands at
      // applied+7 automatically. Idempotent — any existing follow-up row for
      // the job makes this a silent no-op, and an in-flight marker covers the
      // window before the insert lands in state (rapid stage toggles).
      // Best-effort: a seed failure must never fail the stage move itself.
      if (patch.status === 'applied' && !seedingRef.current.has(id)) {
        try {
          const seed = seedFollowUp(data, followUpsRef.current);
          if (seed) {
            seedingRef.current.add(id);
            supabase.from('follow_ups').insert(seed).select().single().then(
              ({ data: fu }) => { if (fu) setFollowUps((xs) => [...(xs || []), fu].sort((a, b) => a.due_date.localeCompare(b.due_date))); },
              () => { seedingRef.current.delete(id); }, // failed insert: allow a later retry
            );
          }
        } catch { /* never fail the stage move over a seed */ }
      }
    }
    return data;
  }, []);

  const moveStage = useCallback((id, status) => updateJob(id, { status }), [updateJob]);

  const deleteJob = useCallback(async (id) => {
    const { error } = await supabase.from('jobs').delete().eq('id', id);
    if (error) throw error;
    setJobs((xs) => (xs || []).filter((x) => x.id !== id));
    setEvents((xs) => (xs || []).filter((x) => x.job_id !== id));
    setFollowUps((xs) => (xs || []).filter((x) => x.job_id !== id));
  }, []);

  const rescoreJob = useCallback(async (job, profileRow = profile) => {
    const s = scoreJob(job, profileRow);
    if (s.score == null) return job;
    return updateJob(job.id, { fit_score: s.score, fit_rationale: s.rationale, fit_breakdown: s.breakdown, flags: s.flags });
  }, [profile, updateJob]);

  const rescoreAll = useCallback(async (profileRow = profile) => {
    if (!profileRow) return 0;
    const list = jobs || [];
    await Promise.all(list.map((j) => {
      const s = scoreJob(j, profileRow);
      return supabase.from('jobs')
        .update({ fit_score: s.score, fit_rationale: s.rationale, fit_breakdown: s.breakdown, flags: s.flags })
        .eq('id', j.id);
    }));
    await refresh();
    return list.length;
  }, [jobs, profile, refresh]);

  // ---------- profile ----------
  const saveProfile = useCallback(async (fields) => {
    const row = { ...fields, user_id: session.user.id };
    const { data, error } = await supabase.from('target_profile').upsert(row, { onConflict: 'user_id' }).select().single();
    if (error) throw error;
    setProfile(data);
    return data;
  }, [session]);

  // ---------- master resume ----------
  // Lives on the store rather than inside the Profile page, because four
  // surfaces need it now (Profile edits it, the coverage panel diffs against
  // it, the Skills page scores gaps from it, the Apply desk prefills contact
  // fields from it) and four independent fetches of the same single row is
  // both slower and a way for two of them to disagree.
  const saveResume = useCallback(async (content) => {
    const { error } = await supabase
      .from('resume_master')
      .upsert({ user_id: session.user.id, content }, { onConflict: 'user_id' });
    if (error) throw error;
    setResume(content);
    return content;
  }, [session]);

  // ---------- hunts ----------
  const addHunt = useCallback(async (fields) => {
    const { data, error } = await supabase.from('hunts').insert(fields).select().single();
    if (error) {
      if (/duplicate|unique/i.test(error.message)) throw new Error('You already have a hunt with that name.');
      throw error;
    }
    setHunts((xs) => [...(xs || []), data]);
    return data;
  }, []);

  const saveHunt = useCallback(async (id, patch) => {
    const { data, error } = await supabase.from('hunts').update(patch).eq('id', id).select().single();
    if (error) throw error;
    setHunts((xs) => (xs || []).map((h) => (h.id === id ? data : h)));
    return data;
  }, []);

  const deleteHunt = useCallback(async (id) => {
    const { error } = await supabase.from('hunts').delete().eq('id', id);
    if (error) throw error;
    setHunts((xs) => (xs || []).filter((h) => h.id !== id));
  }, []);

  // ---------- company discovery ----------
  // Walks the company pool in batches; the caller loops until next_offset is
  // null (or until it has seen enough). Returns the raw batch so the page can
  // stream results in as they arrive rather than waiting for the whole sweep —
  // a full pass is ~200 companies and several minutes of probing.
  const discoverCompanies = useCallback(
    (opts) => apiPost('/api/discover-companies', opts || {}),
    [],
  );

  // ---------- follow-ups ----------
  const addFollowUp = useCallback(async (fields) => {
    const { data, error } = await supabase.from('follow_ups').insert(fields).select().single();
    if (error) throw error;
    setFollowUps((xs) => [...(xs || []), data].sort((a, b) => a.due_date.localeCompare(b.due_date)));
    return data;
  }, []);

  const setFollowUpDone = useCallback(async (id, done) => {
    const patch = { done, done_at: done ? new Date().toISOString() : null };
    const { data, error } = await supabase.from('follow_ups').update(patch).eq('id', id).select().single();
    if (error) throw error;
    setFollowUps((xs) => (xs || []).map((x) => (x.id === id ? data : x)));
    return data;
  }, []);

  const deleteFollowUp = useCallback(async (id) => {
    const { error } = await supabase.from('follow_ups').delete().eq('id', id);
    if (error) throw error;
    setFollowUps((xs) => (xs || []).filter((x) => x.id !== id));
  }, []);

  // ---------- watched boards / scanning ----------
  const addWatchBoard = useCallback(async ({ provider, board, company_label }) => {
    const { data, error } = await supabase
      .from('watch_boards')
      .insert({ provider, board, company_label: company_label || board })
      .select().single();
    if (error) {
      if (/duplicate|unique/i.test(error.message)) throw new Error('Already watching that board.');
      throw error;
    }
    setBoards((xs) => [...(xs || []), data]);
    return data;
  }, []);

  const removeWatchBoard = useCallback(async (id) => {
    const { error } = await supabase.from('watch_boards').delete().eq('id', id);
    if (error) throw error;
    setBoards((xs) => (xs || []).filter((x) => x.id !== id));
  }, []);

  // bulk-watch a starter pack; dedupes on (user, provider, board). Returns the
  // number of boards NEWLY added (already-watched ones are silently skipped).
  const addWatchBoards = useCallback(async (items) => {
    if (!session?.user?.id || !items?.length) return 0;
    const rows = items.map((x) => ({
      user_id: session.user.id, provider: x.provider, board: x.board,
      company_label: x.company_label || x.name || x.board,
    }));
    const { data, error } = await supabase
      .from('watch_boards')
      .upsert(rows, { onConflict: 'user_id,provider,board', ignoreDuplicates: true })
      .select();
    if (error) throw error;
    const { data: all } = await supabase.from('watch_boards').select('*').order('created_at', { ascending: true });
    setBoards(all || []);
    return (data || []).length;
  }, [session]);

  // one scan batch (≤12 least-recently-scanned boards); returns the summary
  const runScan = useCallback(async () => {
    setScanning(true);
    try {
      const summary = await apiPost('/api/scan-boards', {});
      await refresh(); // pick up queued discoveries + last_scanned_at
      return summary;
    } finally {
      setScanning(false);
    }
  }, [refresh]);

  // loop scan batches until every board is covered (safety-capped), so one
  // "Scan now" click sweeps a whole pack. onProgress(done,total) for the UI.
  const runFullScan = useCallback(async (onProgress) => {
    setScanning(true);
    const totals = { boards_scanned: 0, new_seen: 0, matched: 0, queued: 0, board_errors: [], keywords_missing: false };
    try {
      for (let i = 0; i < 8; i++) {
        const s = await apiPost('/api/scan-boards', {});
        totals.boards_scanned += s.boards_scanned || 0;
        totals.new_seen += s.new_seen || 0;
        totals.matched += s.matched || 0;
        totals.queued += s.queued || 0;
        totals.keywords_missing = s.keywords_missing;
        if (s.board_errors?.length) totals.board_errors.push(...s.board_errors);
        onProgress?.(s.boards_total - s.boards_remaining, s.boards_total);
        if (!s.boards_remaining) break;
      }
      await refresh();
      return totals;
    } finally {
      setScanning(false);
    }
  }, [refresh]);

  // Sweep active jobs' postings for liveness (batched server-side; loop until
  // everything due has a verdict). Returns totals for the toast.
  const checkPostings = useCallback(async (onProgress) => {
    setCheckingPostings(true);
    const totals = { checked: 0, live: 0, gone: 0, uncertain: 0 };
    try {
      for (let i = 0; i < 8; i++) {
        const s = await apiPost('/api/check-postings', {});
        totals.checked += s.checked || 0;
        totals.live += s.live || 0;
        totals.gone += s.gone || 0;
        totals.uncertain += s.uncertain || 0;
        onProgress?.(totals.checked);
        if (!s.remaining || !s.checked) break;
      }
      await refresh(); // pick up posting_state on the cards
      return totals;
    } finally {
      setCheckingPostings(false);
    }
  }, [refresh]);

  // Accept must never produce a duplicate job. There are no client-side
  // transactions, so we mark the discovery 'imported' FIRST: once it's off the
  // queue, no failure downstream can make it re-acceptable. If the job insert
  // then fails, we roll the marker back to 'queued' so a retry is clean.
  const acceptDiscovery = useCallback(async (d) => {
    const { error: markErr } = await supabase.from('seen_postings').update({ status: 'imported' }).eq('id', d.id);
    if (markErr) throw markErr;
    setDiscoveries((xs) => (xs || []).filter((x) => x.id !== d.id));
    let job;
    try {
      job = await addJob(discoveryToJob(d));
    } catch (ex) {
      await supabase.from('seen_postings').update({ status: 'queued' }).eq('id', d.id);
      setDiscoveries((xs) => [d, ...(xs || []).filter((x) => x.id !== d.id)]
        .sort((a, b) => (b.fit_score ?? -1) - (a.fit_score ?? -1)));
      throw ex;
    }
    // best-effort link — the job already exists, so never fail the accept over it
    supabase.from('seen_postings').update({ job_id: job.id }).eq('id', d.id).then(() => {}, () => {});
    return job;
  }, [addJob]);

  // takes the full row so an error restores exactly one item (not a whole-list
  // snapshot that could clobber a concurrent dismiss)
  const dismissDiscovery = useCallback(async (d) => {
    setDiscoveries((xs) => (xs || []).filter((x) => x.id !== d.id));
    const { error } = await supabase.from('seen_postings').update({ status: 'dismissed' }).eq('id', d.id);
    if (error) {
      setDiscoveries((xs) => [d, ...(xs || []).filter((x) => x.id !== d.id)]
        .sort((a, b) => (b.fit_score ?? -1) - (a.fit_score ?? -1)));
      throw error;
    }
  }, []);

  const requeueDiscovery = useCallback(async (d) => {
    const { error } = await supabase.from('seen_postings').update({ status: 'queued' }).eq('id', d.id);
    if (error) throw error;
    setDiscoveries((xs) => [d, ...(xs || []).filter((x) => x.id !== d.id)]
      .sort((a, b) => (b.fit_score ?? -1) - (a.fit_score ?? -1)));
  }, []);

  // NOTE: auto-scan-on-open lives in the Shell (App.jsx) so it can toast; it
  // calls runScan, which drives the `scanning` flag the inbox reads.

  // Nothing in Runway's chrome calls this any more: the shell's left rail owns
  // identity and the sign-out beside it, and the sub-nav that used to duplicate
  // both now carries neither. It stays on the store because the session is
  // shared — the shell's sign-out ends THIS client's session too — and because
  // an auth surface with no way out is a worse default than an unused export.
  const signOut = useCallback(() => supabase.auth.signOut(), []);

  const metrics = useMemo(
    () => computeMetrics(jobs, events, followUps, profile),
    [jobs, events, followUps, profile],
  );

  const loading = session && (jobs === null || events === null || followUps === null) && !loadError;

  const value = {
    session, jobs, events, followUps, profile, boards, discoveries, hunts, resume, marketPostings,
    scanning, checkingPostings, metrics, loading, loadError,
    refresh, addJob, updateJob, moveStage, deleteJob, rescoreJob, rescoreAll,
    saveProfile, saveResume, addFollowUp, setFollowUpDone, deleteFollowUp,
    addHunt, saveHunt, deleteHunt, discoverCompanies,
    addWatchBoard, addWatchBoards, removeWatchBoard, runScan, runFullScan, checkPostings,
    acceptDiscovery, dismissDiscovery, requeueDiscovery, signOut,
  };
  return <AppCtx.Provider value={value}>{children}</AppCtx.Provider>;
}

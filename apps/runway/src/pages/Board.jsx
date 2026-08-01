import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApp, STAGES, stageLabel, fmtComp } from '../lib/store.jsx';
import { Num, SkBoard, EmptyState, useToast, useIsMobile } from '../ui/primitives.jsx';
import { scoreBadge } from '../lib/score.js';
import { fmtDay, isoDay } from '../lib/dates.js';

// due + overdue follow-ups across every job: the "what do I do today" list
function Agenda() {
  const { jobs, followUps, setFollowUpDone } = useApp();
  const toast = useToast();
  const today = isoDay();
  const rows = useMemo(() => {
    const jobById = new Map((jobs || []).map((j) => [j.id, j]));
    return (followUps || [])
      .filter((f) => !f.done && f.due_date <= today)
      .map((f) => ({ ...f, job: jobById.get(f.job_id) }))
      .filter((x) => x.job)
      .sort((a, b) => a.due_date.localeCompare(b.due_date));
  }, [jobs, followUps, today]);

  if (!rows.length) return null;
  return (
    <div className="card pad-md section">
      <h2>Today — {rows.length} follow-up{rows.length === 1 ? '' : 's'} due</h2>
      <ul className="timeline agenda">
        {rows.map((f) => (
          <li key={f.id} style={{ alignItems: 'center' }}>
            <span className="when" style={{ color: f.due_date < today ? 'var(--bad)' : undefined }}>
              {f.due_date < today ? `overdue · ${fmtDay(f.due_date)}` : 'due today'}
            </span>
            <span style={{ flex: 1 }}>
              <Link to={`/jobs/${f.job.id}?tab=followups`}><b>{f.job.company}</b></Link>
              {f.note ? ` — ${f.note}` : ''}
            </span>
            <button className="btn sm" onClick={async () => {
              try { await setFollowUpDone(f.id, true); toast('Follow-up done'); }
              catch (ex) { toast(ex.message, { err: true }); }
            }}>Done</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function FitBadge({ score }) {
  return <span className={`badge ${scoreBadge(score)}`} title={score == null ? 'unscored' : `fit ${score}/100`}>{score == null ? '—' : score}</span>;
}

function KCard({ job, stale, nextDue, daysIn, onDragStartCard, onDragEndCard, dragging, canDrag = true }) {
  const draggedRef = useRef(false);
  const comp = fmtComp(job.comp_min, job.comp_max);
  return (
    <Link
      to={`/jobs/${job.id}`}
      className={`kcard${dragging ? ' dragging' : ''}`}
      draggable={canDrag}
      onDragStart={(e) => { if (!canDrag) return; draggedRef.current = true; e.dataTransfer.effectAllowed = 'move'; onDragStartCard(job.id); }}
      onDragEnd={() => { if (!canDrag) return; onDragEndCard(); setTimeout(() => { draggedRef.current = false; }, 60); }}
      onClick={(e) => { if (draggedRef.current) e.preventDefault(); }}
    >
      <div className="co">{job.company || '—'}</div>
      <div className="ti">{job.title || 'Untitled role'}</div>
      <div className="meta">
        <FitBadge score={job.fit_score} />
        {comp && <span>{comp}</span>}
        {daysIn != null && <span title="days in this stage">{daysIn}d</span>}
        {job.source === 'scan' && <span title="found by board scan">◎ scan</span>}
        {job.posting_state === 'gone' && <span className="stale" title={job.posting_note || 'the posting was taken down'}>✕ posting gone</span>}
        {stale && <span className="stale" title="quiet past your follow-up window">⚑ follow up</span>}
        {!stale && nextDue && <span title="next follow-up due">due {fmtDay(nextDue)}</span>}
      </div>
    </Link>
  );
}

// Mobile pipeline: a 7-column kanban is unusable on a phone (horizontal drag,
// 206px columns), so small screens get one stage at a time — a scrollable
// pill strip with live counts, and the selected stage's cards in a single
// column. Moves happen from the job page's stepper; drag stays desktop-only.
function MobileStages({ byStage, staleIds, nextDueByJob, daysIn }) {
  const firstWithCards = STAGES.find((s) => byStage[s.id].length > 0)?.id || 'saved';
  const [stage, setStage] = useState(firstWithCards);
  const cards = byStage[stage] || [];
  return (
    <>
      {/* toggle buttons, not a tablist — tablist semantics demand arrow-key
          wiring these plain buttons don't have */}
      <div className="stagebar" role="group" aria-label="Pipeline stage">
        {STAGES.map((s) => (
          <button key={s.id} aria-pressed={s.id === stage}
            className={`pill${s.id === stage ? ' active' : ''}`} onClick={() => setStage(s.id)}>
            {s.label}
            {byStage[s.id].length > 0 && <span className="cnt">{byStage[s.id].length}</span>}
          </button>
        ))}
      </div>
      <div className="stagelist">
        {cards.length === 0 ? (
          <div className="kempty">Nothing in {stageLabel(stage)} — move a job here from its page.</div>
        ) : (
          cards.map((j) => (
            <KCard key={j.id} job={j} canDrag={false}
              stale={staleIds.has(j.id)} nextDue={nextDueByJob.get(j.id)} daysIn={daysIn(j)}
              dragging={false} onDragStartCard={() => {}} onDragEndCard={() => {}} />
          ))
        )}
      </div>
    </>
  );
}

export default function Board() {
  const { jobs, events, followUps, metrics, loading, loadError, moveStage, checkPostings, checkingPostings } = useApp();
  const toast = useToast();
  const isMobile = useIsMobile();

  // active jobs with a URL — the population a liveness sweep can verify
  const checkable = useMemo(
    () => (jobs || []).filter((j) => j.url && j.status !== 'closed' && j.status !== 'offer').length,
    [jobs],
  );
  const runCheck = async () => {
    try {
      const t = await checkPostings();
      if (t.checked === 0) toast('All postings checked within the last hour — nothing due');
      else if (t.gone > 0) toast(`${t.checked} checked — ${t.gone} posting${t.gone === 1 ? '' : 's'} taken down (marked on the cards)`, { ms: 5000 });
      else toast(`${t.checked} checked — ${t.live} live${t.uncertain ? `, ${t.uncertain} couldn't be verified` : ''}`);
    } catch (ex) { toast(`Check failed: ${ex.message}`, { err: true }); }
  };
  const [dragId, setDragId] = useState(null);
  const [overCol, setOverCol] = useState(null);

  const byStage = useMemo(() => {
    const m = {};
    for (const s of STAGES) m[s.id] = [];
    for (const j of jobs || []) (m[j.status] || (m[j.status] = [])).push(j);
    // best fits float to the top of every column; unscored sink, newest first
    for (const s of STAGES) {
      m[s.id].sort((a, b) =>
        ((b.fit_score ?? -1) - (a.fit_score ?? -1)) || (new Date(b.created_at) - new Date(a.created_at)));
    }
    return m;
  }, [jobs]);

  // when each job entered its current stage (events are sorted ascending)
  const stageSince = useMemo(() => {
    const m = new Map();
    for (const e of events || []) m.set(e.job_id, e.changed_at);
    return m;
  }, [events]);

  const nextDueByJob = useMemo(() => {
    const m = new Map();
    for (const f of followUps || []) {
      if (!f.done && !m.has(f.job_id)) m.set(f.job_id, f.due_date); // sorted by due_date
    }
    return m;
  }, [followUps]);

  if (loading || jobs === null) return <SkBoard />;
  if (loadError) return null; // Shell renders the retryable error state

  const onDrop = async (stage) => {
    setOverCol(null);
    const id = dragId;
    setDragId(null);
    if (!id) return;
    const job = jobs.find((j) => j.id === id);
    if (!job || job.status === stage) return;
    const prev = job.status;
    try {
      await moveStage(id, stage);
      toast(`${job.company || 'Job'} → ${stageLabel(stage)}`, {
        action: { label: 'Undo', fn: () => moveStage(id, prev).catch((ex) => toast(`Undo failed: ${ex.message}`, { err: true })) },
      });
    } catch (ex) {
      toast(`Couldn't move it: ${ex.message}`, { err: true });
    }
  };

  const daysIn = (j) => {
    const since = stageSince.get(j.id) || j.created_at;
    return Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 86400000));
  };

  return (
    <>
      {/* The <h1>Board</h1> is gone — the rail's Board item is already lit. Be
          honest about what that buys here: this row also holds the primary
          action, which is taller than the title was, so the page below does NOT
          move up. What it removes is the second name for the place, not a line
          of space. The pages whose head was title-only (see Market's sparse
          branch) are where the space actually comes back. */}
      <div className="page-head">
        <div style={{ display: 'flex', gap: 10 }}>
          {/* the liveness sweep is a utility, not a headline action — on
              mobile it lives at the foot of the pipeline instead */}
          {!isMobile && checkable > 0 && (
            <button className="btn" onClick={runCheck} disabled={checkingPostings}
              title="Verify each active job's posting is still live (its ATS's public API, else the page itself)">
              {checkingPostings ? 'Checking…' : 'Check postings'}
            </button>
          )}
          <Link className="btn primary" to="/capture">+ Capture a job</Link>
        </div>
      </div>

      {/* the kit's stat tiles, `on-canvas` so each one is its own card. The
          label used to be a Syne uppercase 11px (9.5px on a phone) — a
          decorative face hand-rolling what .stattile-label does at the floor. */}
      <div className="grid metrics section stagger">
        <div className="stattile on-canvas metric"><div className="stattile-label"><span className="lab-full">Active</span><span className="lab-short">Active</span></div><div className="stattile-value"><Num v={metrics.active} /></div><div className="t-cap note">everything not closed</div></div>
        <div className="stattile on-canvas metric"><div className="stattile-label"><span className="lab-full">Applied this week</span><span className="lab-short">This wk</span></div><div className="stattile-value"><Num v={metrics.appliedThisWeek} /></div><div className="t-cap note">last 7 days</div></div>
        <div className="stattile on-canvas metric"><div className="stattile-label"><span className="lab-full">Response rate</span><span className="lab-short">Response</span></div><div className="stattile-value">{metrics.responseRate == null ? '—' : <><Num v={metrics.responseRate} />%</>}</div><div className="t-cap note">applications that got a screen</div></div>
        <div className="stattile on-canvas metric"><div className="stattile-label"><span className="lab-full">Needs follow-up</span><span className="lab-short">Follow-up</span></div><div className="stattile-value"><Num v={metrics.staleJobs.length} /></div><div className="t-cap note">quiet &gt; {metrics.windowDays} business days</div></div>
      </div>

      <Agenda />

      {metrics.oldestUnfollowed && (
        <div className="callout section">
          <span>
            <b>{metrics.oldestUnfollowed.job.company} — {metrics.oldestUnfollowed.job.title}</b> has been quiet{' '}
            {metrics.oldestUnfollowed.days < 1 ? 'since applying' : `${metrics.oldestUnfollowed.days} business day${metrics.oldestUnfollowed.days === 1 ? '' : 's'}`} with no follow-up on the books.
          </span>
          <Link className="btn sm" to={`/jobs/${metrics.oldestUnfollowed.job.id}`}>Open it</Link>
        </div>
      )}

      {jobs.length === 0 ? (
        <EmptyState
          title="Nothing on the board yet"
          hint="Capture your first role — paste a posting or enter it manually, and it gets scored against your targets."
          cta="Capture a job"
          ctaTo="/capture"
        />
      ) : isMobile ? (
        <>
          <MobileStages byStage={byStage} staleIds={metrics.staleIds} nextDueByJob={nextDueByJob} daysIn={daysIn} />
          {checkable > 0 && (
            <button className="btn ghost checkrow" onClick={runCheck} disabled={checkingPostings}>
              {checkingPostings ? 'Checking postings…' : '✓ Verify these postings are still live'}
            </button>
          )}
        </>
      ) : (
        <div className="kanban">
          {STAGES.map((s) => (
            <div
              key={s.id}
              className={`kcol stagger${overCol === s.id ? ' over' : ''}`}
              onDragOver={(e) => { e.preventDefault(); if (overCol !== s.id) setOverCol(s.id); }}
              onDragLeave={() => setOverCol((c) => (c === s.id ? null : c))}
              onDrop={() => onDrop(s.id)}
            >
              <div className="kcol-head"><span className="t-label">{s.label}</span><span className="cnt">{byStage[s.id].length}</span></div>
              {byStage[s.id].map((j) => (
                <KCard
                  key={j.id}
                  job={j}
                  stale={metrics.staleIds.has(j.id)}
                  nextDue={nextDueByJob.get(j.id)}
                  daysIn={daysIn(j)}
                  dragging={dragId === j.id}
                  onDragStartCard={setDragId}
                  onDragEndCard={() => setDragId(null)}
                />
              ))}
              {byStage[s.id].length === 0 && <div className="kempty">drop a card here</div>}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

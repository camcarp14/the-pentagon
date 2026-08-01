import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useApp, fmtComp, stageLabel } from '../lib/store.jsx';
import { SENIORITY_LADDER } from '../lib/score.js';
import { computeFunnel } from '../lib/metrics.js';
import { computeCalibration, computeWaiting, CLAIM_MIN_N } from '../lib/benchmarks.js';
import { SkPage, EmptyState } from '../ui/primitives.jsx';

// your funnel vs published candidate-side benchmark bands — honest framing is
// the feature: years attached, no multiplier claims under n=20, and beating
// the band is expected (targeted vs mass-platform), not praise
function CalibrationCard() {
  const { jobs, events } = useApp();
  const cal = useMemo(() => {
    const f = computeFunnel(jobs, events);
    const everApplied = f.reached[2] || 0;
    const pct = (n) => (everApplied > 0 ? Math.round((n / everApplied) * 100) : null);
    return computeCalibration({
      everApplied,
      responseRate: pct(f.reached[3] || 0),
      interviewRate: pct(f.reached[4] || 0),
    });
  }, [jobs, events]);

  if (!cal.rows.length || cal.n === 0) return null;
  const bandLabel = { 'below-range': 'below typical', 'within-range': 'within typical', 'above-range': 'above typical' };
  const bandColor = { 'below-range': 'var(--bad)', 'within-range': 'var(--dim)', 'above-range': 'var(--good)' };
  return (
    <div className="card pad-md section">
      <h2>Your funnel vs the market</h2>
      {cal.rows.map((r) => (
        <div className="bar-row cal-row" key={r.key}>
          <span>{r.label}</span>
          <span className="val" style={{ textAlign: 'left' }}>
            {r.own}% <span style={{ color: bandColor[r.band] }}>· {bandLabel[r.band]}</span>
            <span style={{ color: 'var(--faint)' }}> (typical {r.typical}%, range {r.range[0]}–{r.range[1]}%, {r.year} — directional)</span>
            {r.multiple != null && <span style={{ color: 'var(--faint)' }}> · {r.multiple}× typical</span>}
          </span>
          {r.note && <span className="why">{r.band === 'above-range' ? '✓ ' : '→ '}{r.note}</span>}
        </div>
      ))}
      <p className="sub" style={{ marginBottom: 0 }}>
        {cal.smallSample
          ? `Small sample (n=${cal.n} applications) — directional only; comparisons firm up past ${CLAIM_MIN_N}.`
          : `Benchmarks are mass-application platform data (sources: HiringThing, scale.jobs) — hand-targeted applications should beat them.`}
      </p>
    </div>
  );
}

// everything sitting in Applied vs the typical first-response window.
// "Silence is common, not a verdict" — deliberate anti-anxiety framing.
function WaitingCard() {
  const { jobs } = useApp();
  const w = useMemo(() => computeWaiting(jobs), [jobs]);
  if (!w.inFlight) return null;
  return (
    <div className="card pad-md section">
      <h2>Waiting on a response — {w.inFlight}</h2>
      <p className="sub" style={{ marginTop: 2 }}>
        Typical first-response window: {w.window[0]}–{w.window[1]} days ({w.year}, directional). Many applications never get a response — silence is common, not a verdict.
      </p>
      <ul className="timeline" style={{ marginBottom: 0 }}>
        {w.items.map(({ job, elapsedDays, beyond }) => (
          <li key={job.id} style={{ alignItems: 'center' }}>
            <span className="when" style={{ color: beyond ? 'var(--bad)' : undefined, minWidth: 70 }}>
              {elapsedDays == null ? 'no date' : `${elapsedDays}d`}
            </span>
            <span style={{ flex: 1 }}>
              <Link to={`/jobs/${job.id}`}><b>{job.company}</b></Link> — {job.title}
              {beyond && <span style={{ color: 'var(--faint)' }}> · beyond the typical window</span>}
            </span>
            {beyond && <Link className="btn ghost sm" to={`/jobs/${job.id}?tab=followups`}>Follow up</Link>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// how far things get and how long each stage takes — the "is my process
// working" read, computed from the server-logged stage history
function FunnelCard() {
  const { jobs, events } = useApp();
  const f = useMemo(() => computeFunnel(jobs, events), [jobs, events]);
  const max = Math.max(1, ...f.reached);
  if (!f.reached[0]) return null;
  return (
    <div className="card pad-md section">
      <h2>Pipeline funnel</h2>
      {f.stages.map((s, i) => (
        <div className="bar-row funnel-row" key={s}>
          <span>{stageLabel(s)}</span>
          <div className="bar"><i style={{ width: `${Math.round((f.reached[i] / max) * 100)}%` }} /></div>
          <span className="val" style={{ textAlign: 'left' }}>
            {f.reached[i]}
            {f.conv[i] != null && f.reached[i] > 0 && <span style={{ color: 'var(--faint)' }}> · {f.conv[i]}% advance</span>}
          </span>
          <span className="why">
            {f.medianDays[i] != null ? `median ${f.medianDays[i]}d in stage` : '—'}
          </span>
        </div>
      ))}
      <p className="sub" style={{ marginBottom: 0 }}>
        “Reached” counts every job that ever got to a stage (from the event history), so conversion is honest even after jobs close.
      </p>
    </div>
  );
}

const fmtK = (n) => `$${Math.round(n / 1000)}k`;
const mid = (j) => ((j.comp_min ?? j.comp_max) + (j.comp_max ?? j.comp_min)) / 2;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const W = 820, LABEL_W = 215, PAD_R = 24;

function CompChart({ priced, floor }) {
  const groups = [...SENIORITY_LADDER, 'unknown']
    .map((s) => ({ s, jobs: priced.filter((j) => (j.seniority || 'unknown') === s).sort((a, b) => mid(b) - mid(a)) }))
    .filter((g) => g.jobs.length);

  const vals = priced.flatMap((j) => [j.comp_min, j.comp_max]).filter((v) => v != null);
  if (floor) vals.push(floor);
  const lo = Math.min(...vals) * 0.9;
  const hi = Math.max(...vals) * 1.06;
  const X = (v) => LABEL_W + ((v - lo) / (hi - lo)) * (W - LABEL_W - PAD_R);

  // nice axis ticks
  const span = hi - lo;
  const step = [10000, 20000, 25000, 50000, 100000].find((s) => span / s <= 6) || 100000;
  const ticks = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) ticks.push(t);

  const rows = [];
  let y = 10;
  for (const g of groups) {
    const med = median(g.jobs.map(mid));
    rows.push(
      <text key={`h-${g.s}`} x="0" y={y + 12} fill="var(--dim)" fontSize="12" fontWeight="700">
        {g.s} · {g.jobs.length} · median {fmtK(med)}
      </text>,
    );
    y += 26;
    for (const j of g.jobs) {
      const a = j.comp_min ?? j.comp_max;
      const b = j.comp_max ?? j.comp_min;
      const x1 = X(a);
      const wBar = Math.max(X(b) - x1, 7);
      const label = `${j.company || '—'} · ${j.title || ''}`;
      rows.push(
        <g key={j.id}>
          <text x="0" y={y + 10} fill="var(--text)" fontSize="12">
            {label.length > 34 ? `${label.slice(0, 33)}…` : label}
          </text>
          <rect x={x1} y={y} width={wBar} height={13} rx="6.5" fill="var(--accent)" opacity="0.55">
            <title>{`${j.company} — ${j.title}: ${fmtComp(j.comp_min, j.comp_max)}`}</title>
          </rect>
          <text x={Math.min(x1 + wBar + 8, W - 4)} y={y + 11} fill="var(--faint)" fontSize="11">
            {fmtComp(j.comp_min, j.comp_max)}
          </text>
        </g>,
      );
      y += 24;
    }
    y += 10;
  }

  const axisY = y + 4;
  const H = axisY + 26;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Compensation distribution by seniority" style={{ width: '100%', height: 'auto', fontVariantNumeric: 'tabular-nums' }}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={X(t)} y1="4" x2={X(t)} y2={axisY} stroke="rgba(255,255,255,0.07)" />
          <text x={X(t)} y={axisY + 16} fill="var(--faint)" fontSize="11" textAnchor="middle">{fmtK(t)}</text>
        </g>
      ))}
      {floor != null && (
        <g>
          <line x1={X(floor)} y1="0" x2={X(floor)} y2={axisY} stroke="var(--bad)" strokeDasharray="4 4" opacity="0.75" />
          <text x={X(floor) + 5} y={axisY - 4} fill="var(--bad)" fontSize="11">your floor {fmtK(floor)}</text>
        </g>
      )}
      {rows}
    </svg>
  );
}

export default function Market() {
  const { jobs, profile, loading } = useApp();

  const priced = useMemo(
    () => (jobs || []).filter((j) => j.comp_min != null || j.comp_max != null),
    [jobs],
  );

  if (loading || jobs === null) return <SkPage cards={2} />;

  if (priced.length < 3) {
    return (
      <>
        {/* The whole .page-head goes, not just the <h1> inside it. It held
            nothing else, and an empty flex row still spends its `margin: 0 0
            18px` — deleting the heading and leaving the wrapper is the version
            of this change that reclaims nothing. */}
        <FunnelCard />
        <CalibrationCard />
        <WaitingCard />
        <EmptyState
          title={`Comp data: ${priced.length} of the 3 postings needed`}
          hint="Capture roles with stated comp and this page adds a market-rate distribution by title and level — so you can judge any offer against the market instead of guessing."
          cta="Capture a job"
          ctaTo="/capture"
        />
      </>
    );
  }

  return (
    <>
      {/* The count is not a repeat — it is how much data these charts are built
          on, and the rail says nothing about it. The title is, so it goes. */}
      <div className="page-head">
        <span className="sub">{priced.length} postings with stated comp</span>
      </div>
      <FunnelCard />
      <CalibrationCard />
      <WaitingCard />
      <div className="card pad-md section">
        <h2>Comp distribution by level</h2>
        {/* fixed-min chart scrolls sideways on phones instead of shrinking to unreadable */}
        <div className="chartwrap">
          <CompChart priced={priced} floor={profile?.comp_floor ?? null} />
        </div>
      </div>
      <div className="card pad-md">
        <h2>All captured comp</h2>
        <div className="tablewrap">
          <table>
            <thead><tr><th>Company</th><th>Title</th><th>Seniority</th><th>Range</th><th>Midpoint</th></tr></thead>
            <tbody>
              {[...priced].sort((a, b) => mid(b) - mid(a)).map((j) => (
                <tr key={j.id}>
                  <td>{j.company}</td><td>{j.title}</td><td>{j.seniority}</td>
                  <td>{fmtComp(j.comp_min, j.comp_max)}</td><td>{fmtK(mid(j))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

// SKILLS & POSITIONING — the read that no single job page can give you.
//
// Requirements coverage (on every job) answers "can I claim THIS role". It is
// useful and it is myopic: forty postings, forty separate verdicts, and no way
// to see the thing that is actually true — that the same requirement keeps
// appearing and you keep not having it. You feel that as a vague sense of
// being under-qualified rather than as a fact with a number on it.
//
// This page computes over the whole sample: every job you captured and every
// posting a scan matched for you. Not the job market in general — YOUR market,
// the one your hunts describe. Then it says three things a single posting
// cannot:
//
//   • what your market keeps asking for, ranked, weighted toward the roles
//     that actually fit you
//   • which of those your resume evidences, and which it does not
//   • what is on your resume that this market never asks for — the half nobody
//     looks at, and the cheapest edit available
//
// Everything here is deterministic (lib/skills.js). No model call, no network,
// no "insights" that change when you reload.
import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useApp, fmtComp } from '../lib/store.jsx';
import { gapAnalysis, SKILL_CATEGORIES, GAP_MIN_N } from '../lib/skills.js';
import { SENIORITY_LADDER } from '../lib/score.js';
import { Num, SkPage, EmptyState } from '../ui/primitives.jsx';

const fmtK = (n) => `$${Math.round(n / 1000)}k`;

// A demand row. The bar is the share of postings asking for it; the count and
// the median comp beside it are the evidence, because a bar on its own invites
// you to read a shape rather than a number.
function DemandRow({ row, max }) {
  return (
    <div className="bar-row skill-row">
      <span className={row.have ? 'skill-have' : 'skill-gap'}>
        {row.have ? '✓' : '△'} {row.label}
      </span>
      <div className="bar"><i style={{ width: `${Math.round((row.pct / Math.max(1, max)) * 100)}%` }} /></div>
      <span className="val" style={{ textAlign: 'left' }}>
        {row.pct}%
        <span className="dimtext"> · {row.count} posting{row.count === 1 ? '' : 's'}</span>
      </span>
      <span className="why">
        {row.medianComp != null ? `median ${fmtK(row.medianComp)}` : row.category}
      </span>
    </div>
  );
}

// What level this market is actually hiring at, against the band you target.
// The common failure it exposes: aiming at senior while the postings that
// match you are overwhelmingly mid — which reads as "nobody replies" and is
// really "you are applying one rung up, every time".
function LevelRead({ postings, profile }) {
  const read = useMemo(() => {
    const counts = new Map();
    let known = 0;
    for (const p of postings) {
      const s = String(p.seniority || '').toLowerCase();
      if (!SENIORITY_LADDER.includes(s)) continue;
      counts.set(s, (counts.get(s) || 0) + 1);
      known += 1;
    }
    if (known < 4) return null;
    const rows = SENIORITY_LADDER
      .filter((s) => counts.has(s))
      .map((s) => ({ s, n: counts.get(s), pct: Math.round((counts.get(s) / known) * 100) }));
    const band = (profile?.seniority_band || []).map((x) => String(x).toLowerCase());
    const inBand = band.length ? rows.filter((r) => band.includes(r.s)).reduce((t, r) => t + r.n, 0) : null;
    return { rows, known, band, inBandPct: inBand == null ? null : Math.round((inBand / known) * 100) };
  }, [postings, profile]);

  if (!read) return null;
  const max = Math.max(...read.rows.map((r) => r.pct));
  return (
    <div className="card pad-md section">
      <h2>What level this market is hiring at</h2>
      {read.rows.map((r) => (
        <div className="bar-row skill-row" key={r.s}>
          <span className={read.band.includes(r.s) ? 'skill-have' : undefined}>{r.s}</span>
          <div className="bar"><i style={{ width: `${Math.round((r.pct / max) * 100)}%` }} /></div>
          <span className="val" style={{ textAlign: 'left' }}>{r.pct}%<span className="dimtext"> · {r.n}</span></span>
          <span className="why">{read.band.includes(r.s) ? 'in your band' : ''}</span>
        </div>
      ))}
      <p className="sub" style={{ marginBottom: 0 }}>
        {read.inBandPct == null
          ? 'No seniority band set on Profile — set one and this says how much of your market you are actually aiming at.'
          : read.inBandPct >= 50
            ? `${read.inBandPct}% of the ${read.known} levelled postings sit in your band. Your aim matches your market.`
            : `Only ${read.inBandPct}% of the ${read.known} levelled postings sit in your band — most of what you are seeing is a different rung. Either widen the band on Profile or expect a thinner funnel.`}
      </p>
    </div>
  );
}

// Where your floor sits inside the comp your market actually states.
function CompRead({ postings, profile }) {
  const read = useMemo(() => {
    const mids = postings
      .map((p) => (p.comp_min != null && p.comp_max != null ? (p.comp_min + p.comp_max) / 2 : (p.comp_min ?? p.comp_max)))
      .filter((v) => v != null)
      .sort((a, b) => a - b);
    if (mids.length < 5) return null;
    const at = (q) => mids[Math.min(mids.length - 1, Math.floor(q * mids.length))];
    const floor = profile?.comp_floor ?? null;
    const above = floor == null ? null : mids.filter((m) => m >= floor).length;
    return {
      n: mids.length, p25: at(0.25), p50: at(0.5), p75: at(0.75), floor,
      abovePct: above == null ? null : Math.round((above / mids.length) * 100),
    };
  }, [postings, profile]);

  if (!read) return null;
  return (
    <div className="card pad-md section">
      <h2>Where your floor sits</h2>
      <div className="dl">
        <div><div className="t-label">25th</div><div className="val">{fmtK(read.p25)}</div></div>
        <div><div className="t-label">Median</div><div className="val">{fmtK(read.p50)}</div></div>
        <div><div className="t-label">75th</div><div className="val">{fmtK(read.p75)}</div></div>
        <div><div className="t-label">Your floor</div><div className="val">{read.floor == null ? '—' : fmtK(read.floor)}</div></div>
      </div>
      <p className="sub" style={{ marginBottom: 0 }}>
        {read.floor == null
          ? `Across ${read.n} postings that stated comp. Set a floor on Profile and this says how much of the market clears it.`
          : read.abovePct >= 60
            ? `${read.abovePct}% of the ${read.n} postings that state comp clear your floor — the floor is not what is limiting you.`
            : read.abovePct >= 25
              ? `${read.abovePct}% of the ${read.n} postings that state comp clear your floor. That is a real constraint, and a defensible one.`
              : `Only ${read.abovePct}% of the ${read.n} postings that state comp clear your floor. Either the floor is above this market or you are searching the wrong slice of it.`}
        {' '}Most postings state nothing at all, so this is the priced minority.
      </p>
    </div>
  );
}

export default function Skills() {
  const { jobs, marketPostings, resume, profile, loading } = useApp();

  // The sample is BOTH halves: what you chose to capture (the strongest signal
  // about what you want) and what the scanner matched (breadth). Discoveries
  // already carry a stored `skills` array; captured jobs may too, and anything
  // missing one is extracted on the fly, so an older row is never invisible.
  const sample = useMemo(() => {
    const captured = (jobs || []).map((j) => ({
      id: j.id, company: j.company, title: j.title, fit_score: j.fit_score,
      skills: j.skills, requirements: j.requirements, raw_description: j.raw_description,
      seniority: j.seniority, comp_min: j.comp_min, comp_max: j.comp_max, captured: true,
    }));
    const scanned = (marketPostings || []).map((d) => ({ ...d, captured: false }));
    return [...captured, ...scanned];
  }, [jobs, marketPostings]);

  const analysis = useMemo(() => gapAnalysis(sample, resume), [sample, resume]);

  if (loading || jobs === null) return <SkPage cards={2} />;

  const noResume = !resume || !Object.keys(resume).length;

  if (sample.length < 3) {
    return (
      <>
        <div className="page-head">
          <span className="sub">What your market keeps asking for, and which of it you can evidence.</span>
        </div>
        <EmptyState
          title={`${sample.length} posting${sample.length === 1 ? '' : 's'} in the sample — this needs a few more`}
          hint="Capture roles or run a scan. Once there are postings to read, this page ranks every skill your market asks for and marks the ones your resume doesn't show."
          cta="Find roles"
          ctaTo="/capture"
        />
      </>
    );
  }

  if (noResume) {
    return (
      <>
        <div className="page-head">
          <span className="sub">{analysis.total} postings read · {analysis.rows.length} distinct skills asked for</span>
        </div>
        <div className="card pad-md section">
          <h2>What this market asks for</h2>
          {analysis.rows.slice(0, 18).map((r) => <DemandRow key={r.id} row={r} max={analysis.rows[0]?.pct || 100} />)}
        </div>
        <EmptyState
          title="Add your master resume to see the gaps"
          hint="Demand is only half the read. With the resume stored, every row above splits into what you can evidence and what you can't."
          cta="Open profile"
          ctaTo="/profile"
        />
      </>
    );
  }

  const topGaps = analysis.gaps.slice(0, 12);
  const maxPct = analysis.rows[0]?.pct || 100;
  const byCategory = SKILL_CATEGORIES
    .map((cat) => ({ cat, rows: analysis.rows.filter((r) => r.category === cat) }))
    .filter((g) => g.rows.length);

  return (
    <>
      <div className="page-head">
        <span className="sub">
          {analysis.total} postings read ({(jobs || []).length} captured, {(marketPostings || []).length} matched by scans) · {analysis.rows.length} distinct skills asked for
        </span>
      </div>

      <div className="grid metrics section stagger">
        <div className="stattile on-canvas metric">
          <div className="stattile-label"><span className="lab-full">Skill coverage</span><span className="lab-short">Coverage</span></div>
          <div className="stattile-value">{analysis.coverage == null ? '—' : <><Num v={analysis.coverage} />%</>}</div>
          <div className="t-cap note">of what this market asks for</div>
        </div>
        <div className="stattile on-canvas metric">
          <div className="stattile-label"><span className="lab-full">Gaps worth closing</span><span className="lab-short">Gaps</span></div>
          <div className="stattile-value"><Num v={analysis.gaps.length} /></div>
          <div className="t-cap note">asked for {GAP_MIN_N}+ times, absent from your resume</div>
        </div>
        <div className="stattile on-canvas metric">
          <div className="stattile-label"><span className="lab-full">Evidenced</span><span className="lab-short">Have</span></div>
          <div className="stattile-value"><Num v={analysis.covered.length} /></div>
          <div className="t-cap note">skills your resume demonstrates</div>
        </div>
        <div className="stattile on-canvas metric">
          <div className="stattile-label"><span className="lab-full">Unasked-for</span><span className="lab-short">Unused</span></div>
          <div className="stattile-value"><Num v={analysis.unused.length} /></div>
          <div className="t-cap note">on your resume, never mentioned here</div>
        </div>
      </div>

      {analysis.thin && (
        <div className="callout section">
          <span>
            Only {analysis.total} postings in the sample — treat everything below as directional until there are more.
          </span>
          <Link className="btn sm" to="/capture">Run a scan</Link>
        </div>
      )}

      {topGaps.length > 0 && (
        <div className="card pad-md section">
          <h2>The gaps, ranked</h2>
          <p className="sub" style={{ marginTop: 0 }}>
            Weighted toward the roles that actually fit you, so the top of this list is the highest-leverage thing to fix.
            A gap can mean the skill is missing — or that you have it and your resume never says so, which is a five-minute edit.
          </p>
          {topGaps.map((r) => <DemandRow key={r.id} row={r} max={maxPct} />)}
          <p className="sub" style={{ marginBottom: 0 }}>
            <Link to="/profile">Add the ones you actually have to your master resume</Link> — every tailored draft and coverage check reads from it.
          </p>
        </div>
      )}

      <LevelRead postings={sample} profile={profile} />
      <CompRead postings={sample} profile={profile} />

      {analysis.unused.length > 0 && (
        <div className="card pad-md section">
          <h2>On your resume, never asked for here</h2>
          <p className="sub" style={{ marginTop: 0 }}>
            Not wasted — but not earning its space in front of THIS market either. Worth demoting if the resume is tight.
          </p>
          <div className="chips">
            {analysis.unused.map((s) => <span className="chip" key={s.id}>{s.label}</span>)}
          </div>
        </div>
      )}

      <div className="card pad-md">
        <h2>Everything this market asks for</h2>
        {byCategory.map((g) => (
          <div key={g.cat} style={{ marginBottom: 18 }}>
            <div className="t-label">{g.cat}</div>
            {g.rows.map((r) => <DemandRow key={r.id} row={r} max={maxPct} />)}
          </div>
        ))}
        <p className="sub" style={{ marginBottom: 0 }}>
          Extracted deterministically from each posting's requirements and description — same text, same answer, every time.
        </p>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// AI Business — the mount entry, and the two gates in front of it.
//
// B5: auth is mandatory and fails closed. "This panel shows spend, revenue and
// business strategy" — so a missing or expired session renders NOTHING. Not a
// skeleton, not a greyed-out layout, not an empty shell with the panel titles
// showing. A skeleton is a blueprint of the surface, and there is no reason an
// unauthenticated visitor should learn that this tab has an approvals queue and
// a spend ledger.
//
// The gates are ordered, and the order matters:
//   1. env    — if the key in the anon slot is a SECRET key, refuse to build a
//               client at all. A degraded client here works perfectly, which is
//               the failure that looks like success.
//   2. auth   — no SERVER-VALIDATED session, no tree. The data provider lives
//               inside <App/>, so it cannot be constructed — let alone issue a
//               query — until `session` holds a token the agent project itself
//               has just vouched for. Note the word validated: an earlier
//               version of this file gated on a session and got the property
//               wrong anyway, because supabase-js hands you the stored session
//               synchronously and that was enough to mount the tree. Structure
//               is only a guarantee where the structure is actually load-bearing.
//
// The agent has its OWN Supabase project, so this is a SECOND sign-in — the
// Pentagon's shared login cannot vouch for a different project's users. That
// second gate is the cost of the isolation, and it is worth it.
// ═══════════════════════════════════════════════════════════════════════════
import { useEffect, useState } from "react";
import bizCss from "./styles.css?inline";
import { agentAuth, agentSb, envCheck, activeFault } from "./lib/agentClient.js";
import { primeHaltToken } from "./lib/halt.js";
import App from "./App.jsx";

export default function BusinessRoot() {
  // Gate the first paint on the sheet being in the document — a cold chunk
  // load otherwise flashes the whole layout unstyled for a frame.
  const [styled, setStyled] = useState(false);
  useEffect(() => {
    const el = document.createElement("style");
    el.id = "biz-scoped-styles";
    el.textContent = bizCss;
    document.head.appendChild(el);
    setStyled(true);
    return () => el.remove();
  }, []);

  // undefined = still checking. Distinct from null (definitively signed out),
  // because rendering the sign-in form during the check makes an already
  // signed-in operator watch a login screen flash past on every visit.
  const [session, setSession] = useState(undefined);

  useEffect(() => {
    if (!agentSb) { setSession(null); return; }
    let alive = true;

    // EVERY path to a mounted <App/> goes through here, and none of them may
    // take localStorage's word for it.
    //
    // The bug this replaces: the validating read lived in its own async IIFE
    // while onAuthStateChange was subscribed separately — and supabase-js
    // fires INITIAL_SESSION with the STORED session the moment you subscribe.
    // So a revoked token mounted the whole tab, fired ten authenticated
    // queries at the agent project, and painted the halt button, both tiles
    // and every panel title, and only then did getUser() come back 401 and
    // close the gate. Measured: 10 REST requests and a full structural paint
    // before the session was known to be bad.
    //
    // getSession() answers from localStorage. A token the server has since
    // rejected — revoked, or signed by a project that rotated its secret —
    // still reads as perfectly valid there. getUser() is the round trip that
    // makes the failure closed rather than cosmetic, so it now gates the
    // subscription too, not just the first read.
    let validating = null;
    const adopt = async (s) => {
      if (!alive) return;
      if (!s?.access_token) { primeHaltToken(null); setSession(null); return; }
      // A refresh re-delivers the same token; revalidating it on every tick
      // would be a round trip per refresh for no new information.
      if (validating === s.access_token) return;
      validating = s.access_token;
      const { data, error } = await agentSb.auth.getUser();
      if (!alive || validating !== s.access_token) return;
      validating = null;
      if (error || !data?.user) { primeHaltToken(null); setSession(null); return; }
      setSession(s);
    };

    agentAuth.getSession().then(adopt);
    const off = agentAuth.onChange(adopt);
    return () => { alive = false; off(); };
  }, []);

  if (!styled) return null;
  if (!envCheck.ok) return <EnvProblem problems={envCheck.problems} />;
  if (session === undefined) return <Checking />;
  if (!session) return <SignIn onDone={setSession} />;

  return (
    // data-kit: AI Business opts into the shared kit HERE, on the tab's own
    // root. It renders inside the shell's tool slot, so every [data-kit] rule in
    // packages/ui/components.css reaches this tab and nothing else — the same
    // rule the shell follows by keeping data-kit off the wrapper that holds
    // every tool. Note this element is behind the styled gate above, so a cold
    // renderToStaticMarkup never reaches it; see src/__tests__/render.test.jsx.
    <div className="biz-root" data-kit>
      {activeFault() && <FaultBanner fault={activeFault()} />}
      <App session={session} />
    </div>
  );
}

// ─── gate 1: the environment ─────────────────────────────────────────────────
function EnvProblem({ problems }) {
  return (
    <Centered>
      <div style={{ maxWidth: 460, width: "100%" }}>
        <Title>This tab is not safe to run</Title>
        <p className="t-foot" style={{ color: "var(--muted)", lineHeight: 1.65, margin: "0 0 16px" }}>
          It refuses to connect rather than starting in a state where every query would
          appear to succeed. Fix the environment and reload.
        </p>
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
          {problems.map((p, i) => (
            <li key={i} className="t-cap" style={{
              lineHeight: 1.6, color: "var(--ink)",
              background: "rgba(248,113,113,0.12)", border: "1px solid rgba(248,113,113,0.45)",
              borderLeft: "3px solid var(--bad)", borderRadius: 10, padding: "10px 12px",
            }}>{p}</li>
          ))}
        </ul>
        <p className="t-cap" style={{ color: "var(--faint)", lineHeight: 1.6, marginTop: 16 }}>
          See <code style={{ fontFamily: "var(--font-mono)" }}>supabase/agent/README.md</code>, or hit{" "}
          <code style={{ fontFamily: "var(--font-mono)" }}>/.netlify/functions/env-check</code> to see what the deploy actually has.
        </p>
      </div>
    </Centered>
  );
}

// ─── gate 2: the session ─────────────────────────────────────────────────────
// A bare spinner, deliberately. Any layout drawn here would be a preview of the
// surface for someone who has not yet proved they may see it.
function Checking() {
  return (
    <Centered>
      {/* The kit's .spinner — the same drawn arc this was hand-rolling. */}
      <div className="spinner" style={{ width: 26, height: 26 }} />
    </Centered>
  );
}

function SignIn({ onDone }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const submit = async (e) => {
    e.preventDefault();
    setErr(""); setBusy(true);
    try {
      const { session } = await agentAuth.signIn(email, password);
      onDone(session || null);
    } catch (ex) {
      setErr(ex?.message || "Sign in failed");
      setBusy(false);
    }
  };

  return (
    <Centered>
      {/* The kit's card. This had a border AND a modal shadow — the pairing the
          language forbids — so the outline is gone and the elevation stays. */}
      <form onSubmit={submit} className="biz-root card" style={{
        width: "100%", maxWidth: 340, padding: "26px 22px",
      }}>
        <Title>AI Business</Title>
        <p className="t-cap" style={{ color: "var(--muted)", lineHeight: 1.6, margin: "0 0 18px" }}>
          The agent runs in its own Supabase project, so this is a separate sign-in from the
          Pentagon's — that separation is what keeps a compromise of the agent away from
          everything else here.
        </p>

        <label className="t-cap" style={{ color: "var(--muted)", fontWeight: 700, display: "block", marginBottom: 6 }}>Email</label>
        <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} style={{ marginBottom: 13 }} />

        <label className="t-cap" style={{ color: "var(--muted)", fontWeight: 700, display: "block", marginBottom: 6 }}>Password</label>
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />

        {err && (
          <div className="t-cap" style={{ color: "var(--bad)", marginTop: 12, lineHeight: 1.5 }}>{err}</div>
        )}

        {/* The kit's primary button, full width. .btn.md is 44px, .btn.full is
            100% — both of which this was writing out by hand. */}
        <button type="submit" disabled={busy} className="btn md primary full biz-press" style={{ marginTop: 18 }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </Centered>
  );
}

// ─── chrome ──────────────────────────────────────────────────────────────────
function FaultBanner({ fault }) {
  const what = {
    db: "every shared read is being failed on purpose",
    loader: "the shared data loader is being thrown on purpose",
    stale: "every row is being back-dated three hours on purpose",
  }[fault];
  return (
    <div className="t-cap" style={{
      background: "rgba(255,178,36,0.16)", borderBottom: "1px solid rgba(245,184,77,0.5)",
      padding: "9px 14px", color: "var(--warn)", fontWeight: 700,
      fontFamily: "var(--font-mono)", textAlign: "center", lineHeight: 1.5,
    }}>
      ⚠ FAULT INJECTION ACTIVE (?fault={fault}) — {what}. Remove the query parameter to see real state.
    </div>
  );
}

function Centered({ children }) {
  return (
    // The gate screens render OUTSIDE the mounted tab root above, so they carry
    // their own data-kit — same scope, same rule: this app and nothing else.
    <div className="biz-root" data-kit style={{
      minHeight: "calc(100vh - 52px)", display: "grid", placeItems: "center",
      padding: "24px 18px", background: "var(--bg)", color: "var(--ink)", fontFamily: "var(--font-body)",
    }}>
      {children}
    </div>
  );
}

function Title({ children }) {
  // .t-head is the kit's 17px section title — one step off what this was doing
  // at 16, and it comes with the scale's own tracking and colour.
  return <h1 className="t-head" style={{ margin: "0 0 8px", fontWeight: 800 }}>{children}</h1>;
}

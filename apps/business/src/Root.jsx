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
//   2. auth   — no session, no tree. The data provider lives inside <App/> and
//               therefore cannot even be constructed, let alone issue a query,
//               before a session exists. That is what makes "zero business data
//               in the network tab" a structural property and not a promise.
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

    (async () => {
      const s = await agentAuth.getSession();
      if (!alive) return;
      if (!s) { setSession(null); return; }
      // getSession() answers from localStorage. A token that the server has
      // since rejected — revoked, or signed by a project that has rotated its
      // secret — still reads as a valid-looking session here. getUser() is the
      // round trip that makes the failure closed rather than cosmetic.
      const { data, error } = await agentSb.auth.getUser();
      if (!alive) return;
      if (error || !data?.user) { primeHaltToken(null); setSession(null); return; }
      setSession(s);
    })();

    const off = agentAuth.onChange((s) => { if (alive) setSession(s); });
    return () => { alive = false; off(); };
  }, []);

  if (!styled) return null;
  if (!envCheck.ok) return <EnvProblem problems={envCheck.problems} />;
  if (session === undefined) return <Checking />;
  if (!session) return <SignIn onDone={setSession} />;

  return (
    <div className="biz-root">
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
        <p style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.65, margin: "0 0 16px" }}>
          It refuses to connect rather than starting in a state where every query would
          appear to succeed. Fix the environment and reload.
        </p>
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 8 }}>
          {problems.map((p, i) => (
            <li key={i} style={{
              fontSize: 12, lineHeight: 1.6, color: "var(--ink)",
              background: "rgba(248,113,113,0.12)", border: "1px solid rgba(248,113,113,0.45)",
              borderLeft: "3px solid var(--bad)", borderRadius: 10, padding: "10px 12px",
            }}>{p}</li>
          ))}
        </ul>
        <p style={{ fontSize: 11, color: "var(--faint)", lineHeight: 1.6, marginTop: 16 }}>
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
      <div className="biz-spin" style={{ width: 26, height: 26, borderRadius: "50%", border: "2px solid var(--border)", borderTopColor: "var(--accent)" }} />
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
      <form onSubmit={submit} className="biz-root" style={{
        width: "100%", maxWidth: 340, background: "var(--surface)",
        border: "1px solid var(--border)", borderRadius: 18, padding: "26px 22px",
        boxShadow: "var(--shadow-modal)",
      }}>
        <Title>AI Business</Title>
        <p style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.6, margin: "0 0 18px" }}>
          The agent runs in its own Supabase project, so this is a separate sign-in from the
          Pentagon's — that separation is what keeps a compromise of the agent away from
          everything else here.
        </p>

        <label style={{ fontSize: 11, color: "var(--muted)", fontWeight: 700, display: "block", marginBottom: 6 }}>Email</label>
        <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} style={{ marginBottom: 13 }} />

        <label style={{ fontSize: 11, color: "var(--muted)", fontWeight: 700, display: "block", marginBottom: 6 }}>Password</label>
        <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />

        {err && (
          <div style={{ fontSize: 11.5, color: "var(--bad)", marginTop: 12, lineHeight: 1.5 }}>{err}</div>
        )}

        <button type="submit" disabled={busy} className="biz-press" style={{
          width: "100%", marginTop: 18, minHeight: 46, borderRadius: 10, border: "none",
          cursor: busy ? "default" : "pointer", background: "var(--accent-grad)", color: "var(--accent-ink)",
          fontWeight: 800, fontSize: 13.5, fontFamily: "var(--font-display)", letterSpacing: "0.03em",
          opacity: busy ? 0.7 : 1,
        }}>
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
    <div style={{
      background: "rgba(255,178,36,0.16)", borderBottom: "1px solid rgba(245,184,77,0.5)",
      padding: "9px 14px", fontSize: 11.5, color: "var(--warn)", fontWeight: 700,
      fontFamily: "var(--font-mono)", textAlign: "center", lineHeight: 1.5,
    }}>
      ⚠ FAULT INJECTION ACTIVE (?fault={fault}) — {what}. Remove the query parameter to see real state.
    </div>
  );
}

function Centered({ children }) {
  return (
    <div className="biz-root" style={{
      minHeight: "calc(100vh - 52px)", display: "grid", placeItems: "center",
      padding: "24px 18px", background: "var(--bg)", color: "var(--ink)", fontFamily: "var(--font-body)",
    }}>
      {children}
    </div>
  );
}

function Title({ children }) {
  return (
    <h1 style={{
      margin: "0 0 8px", fontSize: 16, fontWeight: 800, fontFamily: "var(--font-display)",
      color: "var(--ink)", letterSpacing: "0.02em",
    }}>{children}</h1>
  );
}

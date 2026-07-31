import { useState } from "react";
import { T } from "../../theme";
import { sbAuth } from "../../lib/supabase.js";

// ─── Main App ────────────────────────────────────────────────────────────────
export function LoginScreen({ onLogin }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async () => {
    if (!email || !password) return;
    setLoading(true);
    setError("");
    try {
      const session = await sbAuth.signIn(email, password);
      localStorage.setItem("clarify_token", session.access_token);
      localStorage.setItem("clarify_refresh", session.refresh_token || "");
      onLogin(session.access_token);
    } catch (err) {
      setError(err.message);
    }
    setLoading(false);
  };

  return (
    // data-kit: the sign-in screen is its own root — App returns it before the
    // main tree, so the opt-in there does not reach here.
    <div data-kit style={{ minHeight: "100vh", background: "transparent", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: T.fontBody }}>
      <div style={{ width: "100%", maxWidth: "380px", padding: "0 24px" }}>
        {/* Brand */}
        <div style={{ textAlign: "center", marginBottom: "40px" }}>
          <div className="t-title2" style={{ color: T.gold, marginBottom: "6px" }}>Clarify</div>
          <div className="t-foot">Paid search outreach</div>
        </div>

        {/* Card */}
        <div className="card" style={{ padding: "32px" }}>
          <div className="t-head" style={{ marginBottom: "6px" }}>Sign in</div>
          <div className="t-foot" style={{ marginBottom: "28px" }}>Enter your credentials to continue</div>

          <div style={{ marginBottom: "16px" }}>
            <label className="t-label" style={{ display: "block", marginBottom: "6px" }}>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleSubmit()}
              placeholder="you@domain.com"
              className="field" />
          </div>

          <div style={{ marginBottom: "24px" }}>
            <label className="t-label" style={{ display: "block", marginBottom: "6px" }}>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)}
              onKeyDown={e => e.key === "Enter" && handleSubmit()}
              placeholder="••••••••"
              className="field" />
          </div>

          {error && (
            // An error gets a way forward, not just a colour: the message, and
            // the button below is still live to try again.
            <div role="alert" style={{ marginBottom: "16px", padding: "10px 14px", background: `${T.red}14`, border: "none", borderRadius: "12px", fontSize: "13px", color: T.red }}>
              {error} — check the address and password, then try again.
            </div>
          )}

          <button onClick={handleSubmit} type="button" disabled={loading || !email || !password} className="btn md primary full">
            {loading ? "Signing in…" : "Sign in →"}
          </button>
        </div>

        <div className="t-cap" style={{ textAlign: "center", marginTop: "24px", color: T.faint }}>
          Clarify Paid Search · Private Access
        </div>
      </div>
    </div>
  );
}

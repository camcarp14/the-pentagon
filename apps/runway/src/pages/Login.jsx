import { useState } from 'react';
import { supabase } from '../lib/supabase.js';

// GoTrue wraps trigger exceptions, so the allowlist rejection surfaces as
// "Database error saving new user" — translate it honestly.
const friendly = (msg, mode) => {
  const m = String(msg || '');
  if (mode === 'signup' && /database error|allowlist|blocked/i.test(m)) {
    return 'This is a single-user tool — that email isn’t on the allowlist, so no account was created.';
  }
  if (/invalid login credentials/i.test(m)) return 'Wrong email or password.';
  if (/email not confirmed/i.test(m)) return 'Email not confirmed yet — click the link in your inbox first, then sign in.';
  return m;
};

export default function Login() {
  const [mode, setMode] = useState('signin'); // signin | signup (first-run setup)
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [notice, setNotice] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null); setNotice(null);
    try {
      if (mode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
        if (error) throw error;
        // success: onAuthStateChange flips the gate
      } else {
        const { data, error } = await supabase.auth.signUp({ email, password: pw });
        if (error) throw error;
        if (!data.session) setNotice(`Account created. Check ${email} for a confirmation link, then sign in here.`);
      }
    } catch (ex) {
      setErr(friendly(ex.message, mode));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login card pad-lg pagefade" onSubmit={submit}>
        <div className="brand" style={{ padding: '0 0 10px' }}><span className="dot" /><span className="t-head">Runway</span></div>
        <p className="sub" style={{ marginTop: 0 }}>Private job-search command board. One seat, allowlisted email only.</p>
        <div className="fld">
          <label className="f" htmlFor="login-email">Email</label>
          <input className="field" id="login-email" type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="fld">
          <label className="f" htmlFor="login-pw">Password</label>
          <input className="field" id="login-pw" type="password" required minLength={8} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} value={pw} onChange={(e) => setPw(e.target.value)} />
        </div>
        {err && <p className="err-text" role="alert">{err}</p>}
        {notice && <p className="sub" role="status">{notice}</p>}
        <button className="btn primary" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
          {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create the account'}
        </button>
        <button type="button" className="btn ghost sm" style={{ width: '100%', justifyContent: 'center', marginTop: 8 }}
          onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setErr(null); setNotice(null); }}>
          {mode === 'signin' ? 'First time here? Set up the account' : 'Already set up? Sign in'}
        </button>
      </form>
    </div>
  );
}

// Mount entry for the shell. Macro ("Torque") shipped with its own shared-secret
// gate (DASHBOARD_TOKEN); under The Pentagon it rides the ONE Supabase login
// instead. We mirror the shell's Supabase access token into the sessionStorage
// slot Macro's api client already reads (`torque_token`) and send it as a bearer;
// the functions verify it against Supabase (see netlify/shared/util.mjs). Its
// global CSS is injected scoped-to-mounted (the shell renders one tool at a
// time) so Macro's `body {}` / `:root {}` rules never bleed onto the others.
import { useEffect, useState } from "react";
import { supabase } from "@cc/supabase";
import macroCss from "./styles.css?inline";
import App from "./App.jsx";

function syncToken(session) {
  try {
    if (session?.access_token) sessionStorage.setItem("torque_token", session.access_token);
    else sessionStorage.removeItem("torque_token");
  } catch { /* storage unavailable — the api client will just 401 and the shell handles auth */ }
}

export default function MacroRoot() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const el = document.createElement("style");
    el.id = "macro-scoped-styles";
    el.textContent = macroCss;
    document.head.appendChild(el);
    return () => el.remove();
  }, []);

  useEffect(() => {
    let off;
    // `off` only exists after getSession() resolves, so a cleanup that fires
    // while that await is still in flight — the shell unmounts one tool the
    // moment you pick another — used to run with nothing to cancel, and the
    // async body then registered a subscription no one could ever unsubscribe.
    // Every quick tap through Macro left another live listener behind.
    let cancelled = false;
    (async () => {
      const { data } = (await supabase?.auth.getSession()) || { data: {} };
      if (cancelled) return;
      syncToken(data?.session);
      setReady(true);
      const { data: sub } = supabase?.auth.onAuthStateChange((_e, s) => syncToken(s)) || { data: null };
      if (cancelled) { sub?.subscription?.unsubscribe(); return; }
      off = () => sub?.subscription?.unsubscribe();
    })();
    return () => { cancelled = true; off?.(); };
  }, []);

  if (!ready) return null;
  return <App embedded />;
}

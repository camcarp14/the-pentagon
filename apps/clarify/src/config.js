// ─── Config ─────────────────────────────────────────────────────────────────
export const SUPABASE_URL = "https://nrzpinvyxxorxufadvyc.supabase.co";

export const SUPABASE_ANON_KEY = "sb_publishable_zDV3HpSChf0bZJ5nY09s3w_rNI3sZ1m";

// Local-dev-only keys. On the deployed site every third-party call rides a
// Netlify function with server-side env vars, so nothing sensitive is compiled
// into the public bundle. Keep VITE_* keys in your local .env only — never set
// them in Netlify's environment (VITE_* vars get baked into the shipped JS).
// BUILD-TIME gate, not a runtime one. `import.meta.env.DEV` is statically
// replaced by Vite with the literal `false` in a production build, so the
// whole ternary folds to "" and the key is NEVER EMITTED into dist.
//
// A `window.location.hostname === "localhost"` check does NOT do this: the
// minifier cannot evaluate it, so it keeps both branches and the key survives
// as a string literal in the shipped JS — readable by anyone who opens
// devtools, even though the code would never USE it off localhost. Verified
// by building with a canary value and grepping dist.
export const IS_LOCAL = typeof window !== "undefined" && window.location.hostname === "localhost";

export const ANTHROPIC_API_KEY = import.meta.env.DEV ? (import.meta.env.VITE_ANTHROPIC_API_KEY || "") : "";

export const GOOGLE_PLACES_KEY = import.meta.env.DEV ? import.meta.env.VITE_GOOGLE_PLACES_KEY : "";

export const HUNTER_API_KEY = import.meta.env.DEV ? import.meta.env.VITE_HUNTER_API_KEY : "";

export const FIRECRAWL_API_KEY = import.meta.env.DEV ? import.meta.env.VITE_FIRECRAWL_API_KEY : "";


// ─── Email send mode ─────────────────────────────────────────────────────────
// Live sending is a RUNTIME switch, OFF by default. While off ("Safe mode"),
// every send reroutes to SAFE_SEND_ADDRESS with a banner naming the intended
// recipient — nothing reaches a real prospect until you flip the switch in the
// header. The setting persists locally; a fresh browser always starts safe.
export const SAFE_SEND_ADDRESS = "clarifypaidsearch@gmail.com";

export const SCHEDULING_LINK = "https://calendar.app.google/your-booking-link"; // ← replace with your Google/Calendly booking link

export const SCHEDULING_LINK_CONFIGURED = !/your-booking-link/.test(SCHEDULING_LINK);

export const DEFAULT_MEETING_MINUTES = 30;

// Public origin for tracked short links (/r/<id>) baked into outgoing emails.
// Must be the PRODUCTION origin — localhost links would be dead in a real inbox,
// and so is a retired one: this pointed at the old clarify-outreach site after
// the tools were consolidated, so every tracked link sent would 404 once that
// site was deleted. The Pentagon serves /r/* → track-click (see netlify.toml).
export const PUBLIC_SITE_URL = "https://the-pentagon.netlify.app";

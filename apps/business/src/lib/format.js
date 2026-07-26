// Formatting. Pure, no DOM, no env — so the unit tests can hold it to account.

/** "3s" · "12m" · "4h" · "2d". Compact on purpose: this is a phone. */
export function shortAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 === 0 || h >= 10 ? `${h}h` : `${h}h ${m % 60}m`;
  return `${Math.round(h / 24)}d`;
}

export function ageLabel(ms) {
  const a = shortAge(ms);
  return a === "—" ? "never" : `${a} ago`;
}

/**
 * A hard countdown, for the veto window. Stays honest past zero: an expired
 * approval reads "expired 4m ago", never "0:00" forever.
 */
export function countdown(msRemaining) {
  const expired = !Number.isFinite(msRemaining) || msRemaining <= 0;
  if (expired) {
    return { expired: true, text: Number.isFinite(msRemaining) ? `expired ${shortAge(-msRemaining)} ago` : "expired" };
  }
  const total = Math.floor(msRemaining / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return { expired: false, text: h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}` };
}

export function usd(n, { cents = false } = {}) {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (!cents && abs >= 1000) return `$${Math.round(n).toLocaleString("en-US")}`;
  if (!cents && abs >= 100) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

export function pct(n, digits = 0) {
  if (!Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

export function signed(n, fmt = (x) => String(x)) {
  if (!Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmt(Math.abs(n))}`;
}

/** Milliseconds since an ISO timestamp; null when the input is unusable. */
export function ageOf(iso, now = Date.now()) {
  const t = toMs(iso);
  return t === null ? null : now - t;
}

export function toMs(iso) {
  if (iso === null || iso === undefined || iso === "") return null;
  const t = typeof iso === "number" ? iso : Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Newest timestamp across rows, by column name. null if none parse. */
export function newestAt(rows, column) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let best = null;
  for (const r of rows) {
    const t = toMs(r?.[column]);
    if (t !== null && (best === null || t > best)) best = t;
  }
  return best;
}

export const clockTime = (iso) => {
  const t = toMs(iso);
  if (t === null) return "—";
  return new Date(t).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
};

export const dayLabel = (iso) => {
  const t = toMs(iso);
  if (t === null) return "—";
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

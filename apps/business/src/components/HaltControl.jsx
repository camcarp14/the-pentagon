// ═══════════════════════════════════════════════════════════════════════════
// B1 — the halt button, and the status it reports.
//
// This component reads and writes the agent's config over halt.js, which
// imports nothing and shares nothing. It does NOT use the AgentDataProvider,
// does NOT use useSource, and does not sit inside the boundary that catches
// panel crashes. If every other thing on this page is throwing, the sequence
// tap → PATCH → confirmed row → red "HALTED" still completes.
//
// No optimistic UI. Between the tap and the server's answer the button says
// "Halting…" and the status keeps saying what it last confirmed. The screen
// claims the agent is stopped only when the database has said so.
// ═══════════════════════════════════════════════════════════════════════════
import { useCallback, useEffect, useRef, useState } from "react";
import { readConfirmedConfig, setHalted } from "../lib/halt.js";
import { AUTONOMY_TIERS } from "../lib/tables.js";
import { shortAge } from "../lib/format.js";
import { MAX_AGE_MIN } from "../lib/freshness.js";
import { Btn, Badge, AlarmBlock, TONE } from "./primitives.jsx";

const POLL_MS = 20_000;

/**
 * The halt control's own view of the world. Deliberately a separate request
 * from everything else on the page: a status that can only be wrong when the
 * database is unreachable is worth far more than one that shares a failure
 * mode with nine panels.
 */
export function useConfirmedConfig() {
  const [state, setState] = useState({ status: "loading", row: null, error: null, atMs: null });
  const alive = useRef(true);

  const load = useCallback(async () => {
    const r = await readConfirmedConfig();
    if (!alive.current) return;
    if (r.ok) setState({ status: "ok", row: r.row, error: null, atMs: r.at });
    // Keep the last confirmed row so the UI can say "this is what it was, and
    // we can't see it now" instead of blanking to an ambiguous nothing.
    // `code` is carried, not flattened into the message, because whether the
    // halt path is still usable depends entirely on WHICH failure this was.
    else setState((s) => ({ status: "error", row: s.row, error: r.message, code: r.code || null, atMs: s.atMs }));
  }, []);

  useEffect(() => {
    alive.current = true;
    load();
    const t = setInterval(() => { if (document.visibilityState === "visible") load(); }, POLL_MS);
    const onVisible = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      alive.current = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [load]);

  // `apply` takes the confirmed row straight from the write's response, so the
  // button's own result — not the next poll — is what repaints the status.
  const apply = useCallback((row, atMs) => setState({ status: "ok", row, error: null, atMs }), []);
  return { ...state, reload: load, apply };
}

/** loading · running · halted · running-but-silent · unknown. */
export function deriveStatus(cfg, now = Date.now()) {
  // LOADING FIRST, and it has to be its own branch. Without it the function
  // fell through to "UNKNOWN — No config row." during the very first read, so
  // for as long as the request took, the most important widget on the page
  // stated a finding it had not made. Over a slow link that is several seconds
  // of the status bar claiming the agent has no control row at all. A skeleton
  // and a verdict are exactly the two things B3 says must never be confused.
  if (cfg.status === "loading" && !cfg.row) {
    return { key: "loading", label: "CHECKING…", tone: "loading", detail: null };
  }
  if (cfg.status === "error" && !cfg.row) {
    return { key: "unknown", label: "UNKNOWN", tone: "error", detail: cfg.error || "Can't reach the agent database." };
  }
  const row = cfg.row;
  // Reached only on a SUCCESSFUL read that returned no row — readConfirmedConfig
  // reports that as its own `no_row` failure, so this really does mean the
  // table answered and the singleton is missing.
  if (!row) return { key: "unknown", label: "UNKNOWN", tone: "error", detail: "No config row." };

  const beat = row.heartbeat_at ? Date.parse(row.heartbeat_at) : NaN;
  const beatAge = Number.isFinite(beat) ? now - beat : null;
  const silent = beatAge === null || beatAge > MAX_AGE_MIN * 60_000;

  if (row.halted) {
    return {
      key: "halted", label: "HALTED", tone: "error", beatAge,
      detail: row.halt_reason || "No reason recorded.",
    };
  }
  if (silent) {
    // The most important state on the page, and the one a naive dashboard
    // renders as a calm green "running": the config says it is live and it has
    // not made a sound in longer than its own tick. Nothing has failed loudly,
    // which is exactly why it needs to shout here.
    return {
      key: "silent", label: "RUNNING · NO HEARTBEAT", tone: "error", beatAge,
      detail: beatAge === null
        ? "It has never recorded a heartbeat. It says it is running; nothing confirms that."
        : `Last heartbeat ${shortAge(beatAge)} ago — past the ${MAX_AGE_MIN}-minute window. It says it is running, but it has gone quiet.`,
    };
  }
  return { key: "running", label: "RUNNING", tone: "fresh", beatAge, detail: null };
}

export function StatusAndHalt({ cfg, now }) {
  const [busy, setBusy] = useState(false);
  const [confirmResume, setConfirmResume] = useState(false);
  const [writeError, setWriteError] = useState(null);
  const status = deriveStatus(cfg, now);
  const halted = !!cfg.row?.halted;
  const tone = TONE[status.tone] || TONE.error;

  const act = async (next) => {
    setBusy(true);
    setWriteError(null);
    const r = await setHalted(next, next ? "Halted from the panel" : "");
    setBusy(false);
    setConfirmResume(false);
    if (r.ok) cfg.apply(r.row, r.at);
    // A failed halt is the single most important error this tab can show, so
    // it is stated in full rather than reduced to a toast that slides away.
    else setWriteError(r.message || "The halt did not take effect.");
  };

  const tier = AUTONOMY_TIERS[cfg.row?.autonomy_tier] || null;

  return (
    // The kit's card. This carried a border AND an inset rail — the pairing the
    // language forbids — so the outline is gone and the rail is stacked on the
    // card's own shadow. The rail itself stays: it is the only status signal
    // that survives being scrolled halfway off screen.
    <div className="card" style={{
      boxShadow: `inset 3px 0 0 ${tone.fg}, var(--shadow-card)`,
      padding: 14, display: "flex", flexDirection: "column", gap: 12,
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}>
            <span
              className={status.key === "running" ? undefined : "biz-pulse"}
              style={{ width: 9, height: 9, borderRadius: "50%", background: tone.fg, flexShrink: 0, boxShadow: `0 0 10px ${tone.fg}` }}
            />
            <span className="t-body" style={{
              fontWeight: 800, color: tone.fg,
              letterSpacing: "0.04em", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
            }}>{status.label}</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            {tier && <Badge tone={cfg.row?.autonomy_tier >= 3 ? "stale" : "empty"} title={tier.detail}>T{cfg.row.autonomy_tier}</Badge>}
            <span className="t-cap" style={{ color: status.key === "silent" ? tone.fg : "var(--muted)", fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", fontWeight: status.key === "silent" ? 700 : 400 }}>
              {status.beatAge === null ? "no heartbeat ever" : `heartbeat ${shortAge(status.beatAge)} ago`}
            </span>
            {cfg.status === "error" && (
              <span className="t-cap" style={{ color: "var(--bad)", fontWeight: 700, fontFamily: "var(--font-mono)" }}>
                · offline{cfg.atMs ? ` · last confirmed ${shortAge(now - cfg.atMs)} ago` : ""}
              </span>
            )}
          </div>
        </div>

        {/* The button. Halting is one tap — it is the safe direction and must
            never be gated behind a dialog. Resuming an autonomous business
            that spends money is the dangerous direction, so that one asks. */}
        {halted ? (
          confirmResume ? (
            <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
              <Btn tone="good" busy={busy} onClick={() => act(false)}>Confirm</Btn>
              <Btn tone="ghost" size="sm" onClick={() => setConfirmResume(false)}>Cancel</Btn>
            </div>
          ) : (
            <Btn tone="good" onClick={() => setConfirmResume(true)} style={{ flexShrink: 0 }}>Resume</Btn>
          )
        ) : (
          <Btn tone="danger" busy={busy} onClick={() => act(true)} style={{ flexShrink: 0, minWidth: 96 }}>
            {busy ? "Halting…" : "HALT"}
          </Btn>
        )}
      </div>

      {status.detail && (
        <div className="t-cap" style={{
          lineHeight: 1.55, color: status.tone === "error" ? "var(--ink)" : "var(--muted)",
          background: tone.bg, border: `1px solid ${tone.line}`, borderRadius: 10, padding: "9px 11px",
        }}>
          {halted ? <><strong style={{ color: tone.fg }}>Reason:</strong> {status.detail}</> : status.detail}
        </div>
      )}

      {writeError && (
        <AlarmBlock
          tone="error"
          headline="The halt did NOT take effect"
          detail={writeError}
          action={<Btn size="sm" tone="danger" busy={busy} onClick={() => act(!halted)}>Try again</Btn>}
        />
      )}

      {cfg.status === "error" && (
        <AlarmBlock
          tone="error"
          headline={cfg.code === "no_session" || cfg.code === "denied" ? "Your session was rejected" : "Can't confirm the agent's state"}
          detail={`${cfg.error} — the status above is the last confirmed reading${cfg.atMs ? `, from ${shortAge(now - cfg.atMs)} ago` : ""}, not a live one. ${
            // This used to promise unconditionally that "the HALT button still
            // works over its own connection". Under an auth failure that is a
            // lie of the worst possible kind: the halt path carries the SAME
            // bearer token and 401s identically, so the one instruction the
            // operator is given in an emergency would waste the emergency.
            // Halt's independence is from the shared LOADER, never from the
            // session.
            cfg.code === "no_session" || cfg.code === "denied"
              ? "HALT cannot work either — it carries the same token. Sign in again first."
              : "HALT reaches the database over its own connection and may still work; try it and read the result."
          }`}
          action={<Btn size="sm" tone="danger" onClick={cfg.reload}>Retry</Btn>}
        />
      )}
    </div>
  );
}

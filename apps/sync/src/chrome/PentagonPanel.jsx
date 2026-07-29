// ─── The Pentagon panel ──────────────────────────────────────────────────────
// What syncs, where it stands, and the one conflict that can happen.
//
// Standalone SYNC carried its own sign-in form here: email, password, a
// magic-link fallback, and a footnote explaining that connecting was optional.
// None of that survives the move. The shell gates every tool behind one login,
// so by the time this renders there IS a session — `c.user` cannot be null —
// and signing out is the top bar's job, not this panel's.

import { useCloud } from "../data/useStore.js";
import { pull, takeRemote, keepLocal } from "../data/cloud.js";
import { SOURCES } from "../agent/pentagon-sources.js";
import { Button, SectionHeader, Status } from "../ui/kit.jsx";

function ago(ts) {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

const STATUS = {
  off: { state: "offline", label: "Not built in" },
  "signed-out": { state: "idle", label: "Waiting for the session" },
  "signing-in": { state: "thinking", label: "Connecting" },
  syncing: { state: "thinking", label: "Syncing" },
  synced: { state: "live", label: "Connected" },
  conflict: { state: "waiting", label: "Diverged" },
  error: { state: "error", label: "Error" },
};

export default function PentagonPanel() {
  const c = useCloud();
  const st = STATUS[c.status] || STATUS["signed-out"];

  if (!c.configured) {
    return (
      <section>
        <SectionHeader title="Pentagon" trailing={<Status state="offline" label="Not built in" />} />
        <div className="t-foot">
          This build has no Supabase project configured, so SYNC runs entirely on this device.
        </div>
      </section>
    );
  }

  return (
    <section>
      <SectionHeader title="Pentagon" trailing={<Status state={st.state} label={st.label} />} />

      {c.status === "conflict" && (
        <div
          style={{
            background: "var(--amber-a14)", border: "1px solid var(--amber)",
            borderRadius: 13, padding: "13px 14px", marginBottom: 12,
          }}
        >
          <div className="t-body" style={{ fontWeight: 600, marginBottom: 4 }}>Two copies have drifted apart</div>
          <div className="t-foot" style={{ marginBottom: 10 }}>
            {c.conflict?.device ? `${c.conflict.device} wrote` : "Another device wrote"} while this one had unsaved
            changes. Merging them automatically would resurrect things you deleted, so pick one — the other is
            discarded.
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Button kind="primary" size="md" onClick={() => takeRemote()} style={{ flex: 1 }}>
              Use {c.conflict?.device || "the other device"}
            </Button>
            <Button kind="quiet" size="md" onClick={() => keepLocal()} style={{ flex: 1 }}>
              Keep this device
            </Button>
          </div>
        </div>
      )}

      {c.status === "error" && c.message && (
        <div className="t-foot" style={{ color: "var(--red)", marginBottom: 10 }}>{c.message}</div>
      )}

      <div
        style={{
          display: "flex", alignItems: "center", gap: 10,
          background: "var(--surface-2)", borderRadius: 13, padding: "12px 14px",
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t-body" style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {c.user?.email || "Signed in"}
          </div>
          <div className="t-foot">{c.device} · revision {c.rev} · synced {ago(c.syncedAt)}</div>
        </div>
        <Button kind="quiet" size="sm" onClick={() => pull({ force: true })} style={{ flex: "none" }}>
          Refresh
        </Button>
      </div>

      <div className="t-label" style={{ margin: "14px 0 7px" }}>What SYNC can reach</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {SOURCES.map((s) => {
          const on = s.scope === "personal" || c.owner;
          return (
            <span
              key={s.key}
              className="t-cap"
              title={s.desc}
              style={{
                padding: "5px 10px", borderRadius: 999, fontWeight: 600,
                background: on ? "var(--accent-a12)" : "var(--surface-2)",
                color: on ? "var(--accent)" : "var(--faint)",
              }}
            >
              {s.label}
            </span>
          );
        })}
      </div>

      <div className="t-foot" style={{ marginTop: 10 }}>
        {c.owner
          ? "Personal data is scoped to this account by the database itself. The business sources go through an ownership check, so a signed-in account that isn't yours opens nothing."
          : "This account isn't the Pentagon owner, so the business sources stay closed. Personal data is readable and scoped to you."}
      </div>
    </section>
  );
}

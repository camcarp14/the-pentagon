import { Fragment } from "react";
import { T } from "../theme";
import { sm } from "../lib/store.js";
import { normEmail } from "../lib/supabase.js";

// One journey, six stages — rendered on inbound leads, outreach threads, and clients
// so every surface reads the same story about where a lead stands.
export function LeadJourney({ card, hasInbound = null, isClient = null }) {
  const email = normEmail(card?.contact?.email);
  const clientLinked = isClient !== null ? isClient
    : !!(email && sm.keys("client_origin_").some(id => normEmail((sm.get(`client_origin_${id}`) || {}).email) === email));
  const contacted = !!card?.sent_at || ["sent", "replied", "meeting"].includes(card?.status);
  const replied = !!card?.reply_body || ["replied", "meeting"].includes(card?.status);
  const stages = [
    hasInbound === null ? null : { label: "Inbound", on: hasInbound },
    { label: "Pipeline", on: !!card },
    { label: "Contacted", on: contacted },
    { label: "Replied", on: replied },
    { label: "Meeting", on: card?.status === "meeting" },
    { label: "Client", on: clientLinked },
  ].filter(Boolean);
  const lastOn = stages.reduce((m, s, i) => (s.on ? i : m), -1);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "4px", flexWrap: "wrap" }}>
      {stages.map((s, i) => (
        <Fragment key={s.label}>
          {i > 0 && <span style={{ width: "14px", height: "1px", background: i <= lastOn ? T.gold : T.line }} />}
          <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
            {/* Ring and halo are both shadows now — this dot had a 1.5px border
                AND a halo shadow, which is the pairing the language forbids. */}
            <span className="dotstatus" style={{ background: s.on ? T.gold : "transparent", boxShadow: `inset 0 0 0 1.5px ${s.on ? T.gold : T.faint}${i === lastOn && s.on ? `, 0 0 0 3px ${T.gold}2E` : ""}` }} />
            {/* Six of these sit on one line inside a 340px panel, so this is
                .t-cap rather than .t-label: sentence case at 11.5px, above the
                floor, and uppercase stays reserved for .t-label. */}
            <span className="t-cap" style={{ color: s.on ? T.inkDeep : T.faint }}>{s.label}</span>
          </span>
        </Fragment>
      ))}
    </div>
  );
}

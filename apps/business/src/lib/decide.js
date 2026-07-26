// Verb 2 of three — approve / veto.
//
// Same discipline as the halt path: a write that changed no rows is a FAILURE,
// not a quiet success. Here that case is not a misconfiguration but a race
// with real meaning — the RLS policy only permits a decision while
// `veto_until > now()`, so zero rows changed means the deadline passed between
// the render and the tap, and the agent has already gone ahead. Telling the
// operator "saved" at that moment would be a lie about something they will act
// on later.
import { agentSb } from "./agentClient.js";

export async function decideApproval(id, decision, by = "operator") {
  if (!agentSb) return { ok: false, message: "The agent project is not configured." };
  if (!["approved", "vetoed"].includes(decision)) return { ok: false, message: `Not a decision: ${decision}` };

  const { data, error } = await agentSb
    .from("approvals")
    .update({ decision, decided_at: new Date().toISOString(), decided_by: by })
    .eq("id", id)
    .select();

  if (error) {
    return {
      ok: false,
      message: error.code === "42501"
        ? "The database refused the write (permission denied on approvals.decision)."
        : error.message || "The decision could not be saved.",
    };
  }
  if (!Array.isArray(data) || data.length === 0) {
    return {
      ok: false,
      expired: true,
      message: "The veto window closed before this saved — the agent has already proceeded. Your decision was NOT recorded.",
    };
  }
  return { ok: true, row: data[0] };
}

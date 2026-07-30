// ─── Sequence engine loop — the I/O half ─────────────────────────────────────
// Runs while the app is open (same model as reply polling / the agent engine).
// Each pass: pull active enrollments + their threads + events, run the PURE
// decision core (lib/sequences.js), then persist the outcome:
//
//   stop / complete → enrollment status change
//   wait            → next_action_at + audit line
//   skip            → pointer advance (recorded in last_decision)
//   draft           → ONE new messages row with status='draft' — i.e. into the
//                     approval queue. THE ENGINE NEVER SENDS. Sending is a
//                     human clicking the send button, always (PLAN.md AD-2).
//
// AI personalization is budgeted per pass (MAX_AI_DRAFTS_PER_PASS) so an
// overdue backlog can't burn tokens in one hit; excess drafts fall back to the
// plain template merge and are flagged in meta for the queue UI.
import { useEffect, useRef, useState } from "react";
import { resolveDecision, mergeTemplate } from "./sequences.js";
import { seqDb } from "./sequenceDb.js";
import { callClaude } from "./claudeApi.js";
import { cleanBody, cleanSubject } from "./email.js";
import { withLegacyBridge } from "./threadBridge.js";

const PASS_INTERVAL_MS = 5 * 60000; // decisions are cheap; drafting is budgeted
const MAX_AI_DRAFTS_PER_PASS = 3;

async function aiPersonalizeStep({ step, card, toneMemory }) {
  const tone = (toneMemory || []).length
    ? `\nTone instructions:\n${toneMemory.map((t) => `- ${t.feedback_text}`).join("\n")}`
    : "";
  const brief = card?.prospect?.prospect_brief ? `\nWhat we know: ${card.prospect.prospect_brief.slice(0, 500)}` : "";
  const prompt = `You are Cameron from Clarify Paid Search, a boutique Google Ads agency in Chicago. You already emailed this prospect and are writing follow-up #${step.step_order} ("${step.name}") in the thread.

Prospect: ${card?.prospect?.business_name || "a local business"} (${card?.prospect?.category || "local business"}, ${card?.prospect?.city || "Chicago"})${brief}
Original email subject: ${cleanSubject(card?.draft_subject || "")}
Step direction: ${mergeTemplate(step.body_template || "", card)}

Write the follow-up email body. Under 80 words, plain text, no subject line, specific not generic, sign off "Cameron | Clarify Paid Search".${tone}
Return ONLY valid JSON: {"body":"..."}`;
  const r = await callClaude({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 400,
    messages: [{ role: "user", content: prompt }],
    fn: "sequence_step_draft",
    promptChars: prompt.length,
  });
  try {
    const parsed = JSON.parse((r.text || "{}").replace(/```json|```/g, "").trim());
    if (parsed.body) return cleanBody(parsed.body);
  } catch {}
  return null;
}

// One engine pass over every active enrollment. Exported for tests/manual runs.
// `cards` supplies prospect/contact context (already loaded by the app).
export async function runEnginePass({ cards, toneMemory, log = () => {} }) {
  // These fetches must NOT fall back to []. A failed sequence_steps read used to
  // become an empty ladder, which reads as "cadence exhausted" for every active
  // enrollment — one 5xx would mark the whole book 'completed' and nothing
  // re-opens a completed enrollment. Same for the ledger: an empty messages list
  // reads as "nothing sent yet" and re-drafts steps that already went out.
  // A pass we couldn't ground in real data is a pass we don't run.
  let sequences, steps, enrollments;
  try {
    [sequences, steps, enrollments] = await Promise.all([
      seqDb.getSequences(),
      seqDb.getSteps(),
      seqDb.getEnrollments(["active"]),
    ]);
  } catch (err) {
    log(`Engine pass skipped — couldn't load sequence state: ${err.message}`);
    return { decisions: 0, drafted: 0, error: err.message };
  }
  if (!enrollments || enrollments.length === 0) return { decisions: 0, drafted: 0 };

  const outreachIds = enrollments.map((e) => e.outreach_id);
  let messages, events;
  try {
    messages = await seqDb.getMessagesFor(outreachIds);
    events = await seqDb.getEventsForMessages(messages);
  } catch (err) {
    log(`Engine pass skipped — couldn't load the message ledger: ${err.message}`);
    return { decisions: 0, drafted: 0, error: err.message };
  }

  const cardById = new Map((cards || []).map((c) => [c.id, c]));
  let drafted = 0, aiDrafts = 0, decisions = 0;

  for (const enrollment of enrollments) {
    const sequence = sequences.find((s) => s.id === enrollment.sequence_id);
    const seqSteps = steps.filter((s) => s.sequence_id === enrollment.sequence_id).sort((a, b) => a.step_order - b.step_order);
    const card = cardById.get(enrollment.outreach_id);
    // Shared legacy bridge (threadBridge.js) — same rule analytics uses.
    const threadMessages = withLegacyBridge(card, messages.filter((m) => m.outreach_id === enrollment.outreach_id));
    const threadEvents = events.filter((e) => threadMessages.some((m) => m.id === e.message_id));

    const { decision, pointer } = resolveDecision({
      enrollment, sequence, steps: seqSteps, messages: threadMessages, events: threadEvents,
    });
    decisions++;

    try {
      if (decision.action === "stop") {
        await seqDb.updateEnrollment(enrollment.id, { status: "stopped_reply", last_decision: decision.reason, next_action_at: null });
      } else if (decision.action === "complete") {
        await seqDb.updateEnrollment(enrollment.id, { status: "completed", completed_at: new Date().toISOString(), current_step_order: pointer, last_decision: decision.reason, next_action_at: null });
      } else if (decision.action === "wait") {
        const patch = { last_decision: decision.reason, next_action_at: decision.until ? decision.until.toISOString() : null };
        if (pointer !== enrollment.current_step_order) patch.current_step_order = pointer;
        await seqDb.updateEnrollment(enrollment.id, patch);
      } else if (decision.action === "draft") {
        const step = decision.step;
        if (!card) {
          // No card means no merge vars, so the row would land in the queue with
          // literal {{business_name}} tags — and worse, it burns the one-draft-
          // per-step slot that pendingForStep guards, so the correct draft can
          // never replace it. The first pass fires while the board is still
          // loading, so this is a wait, not an error.
          log(`Skipped draft for ${enrollment.outreach_id} — prospect card not loaded`);
          continue;
        }
        let body = null;
        let personalized = false;
        // Budget counts actual AI calls — template-only drafts don't consume it.
        if (step.ai_personalize && aiDrafts < MAX_AI_DRAFTS_PER_PASS && card) {
          aiDrafts++;
          body = await aiPersonalizeStep({ step, card, toneMemory });
          personalized = !!body;
        }
        if (!body) body = mergeTemplate(step.body_template || "", card || {});
        const subject = step.subject_template
          ? mergeTemplate(step.subject_template, card || {})
          : `Re: ${cleanSubject(card?.draft_subject || "our note")}`;
        await seqDb.insertMessage({
          outreach_id: enrollment.outreach_id,
          enrollment_id: enrollment.id,
          step_id: step.id,
          direction: "outbound",
          kind: "followup",
          subject,
          body,
          status: "draft", // ← the approval queue; a human decides from here
          meta: { personalized, step_name: step.name, step_order: step.step_order, gate: step.send_condition },
        });
        drafted++;
        const patch = { last_decision: `${step.name} drafted → approval queue`, next_action_at: null };
        if (pointer !== enrollment.current_step_order) patch.current_step_order = pointer;
        await seqDb.updateEnrollment(enrollment.id, patch);
        log(`Drafted "${step.name}" for ${card?.prospect?.business_name || enrollment.outreach_id}`);
      }
    } catch (err) {
      // One enrollment failing must not stall the pass.
      log(`Engine pass error on ${enrollment.id}: ${err.message}`);
    }
  }
  return { decisions, drafted };
}

// React hook: run a pass on mount and on an interval while the app is open.
export function useSequenceEngine({ cards, toneMemory, enabled = true }) {
  const [lastPass, setLastPass] = useState(null);
  const busyRef = useRef(false);
  const cardsRef = useRef(cards);
  const toneRef = useRef(toneMemory);
  cardsRef.current = cards;
  toneRef.current = toneMemory;

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const pass = async () => {
      if (busyRef.current) return;
      // A backgrounded tab must not keep drafting AI content around the clock —
      // decisions resume (and catch up) the moment the tab is visible again.
      if (typeof document !== "undefined" && document.hidden) return;
      busyRef.current = true;
      try {
        const result = await runEnginePass({ cards: cardsRef.current, toneMemory: toneRef.current });
        if (alive) setLastPass({ at: new Date(), ...result });
      } catch {} finally {
        busyRef.current = false;
      }
    };
    const t = setTimeout(pass, 4000); // let initial data land first
    const iv = setInterval(pass, PASS_INTERVAL_MS);
    return () => { alive = false; clearTimeout(t); clearInterval(iv); };
  }, [enabled]);

  return { lastPass };
}

import { useState, useEffect } from "react";
import { T } from "../../theme";
import { EmptyState } from "../../ui.jsx";
import { eng, engineSpendThisHour, goalProgress, kb } from "../../lib/engine.js";
import { sm } from "../../lib/store.js";

// Shared roster metadata — Mission Control and the Agent Engine both read this so
// they always show the same agents. Each entry describes what the agent watches.
export const AGENT_META = [
  { key: "pipeline", name: "Pipeline Watcher", role: "Pipeline health", watches: "Prospects that have sat untouched 14+ days, and drafts written but never sent. Flags when either pile up so the pipeline keeps moving.", cost: "Free heuristic" },
  { key: "value", name: "Value Scout", role: "Revenue prioritization", watches: "High-value prospects (estimated $1.5k+/mo retainer) sitting un-worked. Surfaces the biggest dollar opportunities so you work money, not volume.", cost: "Free heuristic" },
  { key: "cadence", name: "Cadence Monitor", role: "Follow-up discipline", watches: "Sent threads that have crossed a follow-up step (bump → value-add → break-up) with no reply. Catches the silence that stalls deals.", cost: "Free heuristic" },
  { key: "reply", name: "Reply Sentinel", role: "Warm-lead triage", watches: "New replies, auto-classified by sentiment. Raises a critical flag the moment an INTERESTED reply lands so it never sits.", cost: "Free heuristic" },
  { key: "pattern", name: "Pattern Learner", role: "Learning over time", watches: "Which verticals actually convert. Builds a running reply-rate model from your sends and recommends where to weight prospecting.", cost: "Free heuristic" },
  { key: "cost", name: "Cost Sentinel", role: "Spend guardrail", watches: "AI spend over the last hour. Keeps the engine honest about token cost and warns before it climbs.", cost: "Free heuristic" },
  { key: "synthesizer", name: "Synthesizer", role: "Insight distillation", watches: "Accumulated observations from every other agent. Occasionally distills them into one highest-leverage move. When Verify is on, a separate skeptical checker (Sonnet) grades each insight against the pipeline facts before it ships. The only agent that spends tokens, and only when every lock opens.", cost: "Haiku · gated" },
];


// Per-agent detail modal — opened from the Mission roster or the Agents tab.

// AgentDetail and AgentsView lived here and were never rendered — the agent
// controls moved to the shell's System hub. AGENT_META above is the only
// live export (MissionControl imports it).

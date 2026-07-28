import { useState, useEffect, useRef } from "react";
import { callClaude } from "../../lib/claudeApi.js";
import { ANALYST_SYSTEM_PROMPT } from "../../lib/prompts.js";
import { memoryHistory, sm, store } from "../../lib/store.js";
import { T, SEV } from "../../theme";
import { EmptyState, SkeletonLine, SkeletonRows } from "../../ui.jsx";

// ─── Analyst: Upload Card ─────────────────────────────────────────────────────
export function UploadCard({ type, upload, onUpload, onRemove }) {
  const inputRef = useRef(null);
  return (
    <div style={{ marginBottom: "8px", background: upload ? `${SEV.pass}12` : T.subtle, border: upload ? `1px solid ${SEV.pass}33` : `1px dashed ${T.line}`, borderRadius: "9px", padding: "10px 12px", cursor: upload ? "default" : "pointer" }}
      onClick={() => !upload && inputRef.current?.click()}>
      <input ref={inputRef} type="file" accept=".csv" style={{ display: "none" }}
        onChange={e => { if (e.target.files[0]) onUpload(e.target.files[0]); e.target.value = ""; }} />
      <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
        <span style={{ fontSize: "12px", color: upload ? SEV.pass : T.faint, fontWeight: 700 }}>{upload ? "✓" : "+"}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "11px", fontWeight: 700, color: upload ? SEV.pass : T.ink, fontFamily: T.fontDisplay }}>{type.label}</div>
          {upload
            ? <div style={{ fontSize: "10px", color: T.muted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{upload.name} · <span style={{ fontFamily: T.fontMono }}>{upload.totalRows}</span> rows</div>
            : <div style={{ fontSize: "10px", color: T.faint }}>{type.hint}</div>}
        </div>
        {upload && <button onClick={e => { e.stopPropagation(); onRemove(); }} style={{ background: "none", border: "none", color: T.faint, cursor: "pointer", fontSize: "16px", lineHeight: 1 }}>×</button>}
      </div>
    </div>
  );
}


// ─── Analyst: Metric Tile ─────────────────────────────────────────────────────
export function MetricTile({ label, value, sub, color, accent }) {
  return (
    <div style={{ flex: 1, padding: "16px 18px", background: accent ? T.goldSoft : T.surface, borderRadius: "10px", border: accent ? `1px solid ${T.goldLine}` : `1px solid ${T.lineInk}`, boxShadow: T.shadowCard }}>
      <div style={{ fontSize: "9px", fontWeight: 700, color: T.faint, textTransform: "uppercase", letterSpacing: "0.14em", fontFamily: T.fontDisplay, marginBottom: "8px" }}>{label}</div>
      <div style={{ fontSize: "26px", fontWeight: 500, color: color || T.inkDeep, fontFamily: T.fontMono, letterSpacing: "-0.02em", lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: "10px", color: T.faint, marginTop: "5px" }}>{sub}</div>}
    </div>
  );
}


// ─── Analyst: Bar Chart (SVG) ─────────────────────────────────────────────────
export function BarChart({ data, valueKey, labelKey, color, formatValue, title, targetValue, targetLabel }) {
  const sorted = [...data].sort((a, b) => b[valueKey] - a[valueKey]).slice(0, 8);
  const max = Math.max(...sorted.map(d => d[valueKey]), targetValue || 0) * 1.15;
  const barH = 26, gap = 8, lblW = 160, numW = 60, w = 520;

  return (
    <div style={{ background: T.surface, borderRadius: "10px", border: `1px solid ${T.lineInk}`, padding: "16px 20px", boxShadow: T.shadowCard }}>
      <div style={{ fontSize: "9px", fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.14em", fontFamily: T.fontDisplay, marginBottom: "12px" }}>{title}</div>
      <svg width="100%" viewBox={`0 0 ${w} ${sorted.length * (barH + gap) + 4}`} style={{ overflow: "visible" }}>
        {sorted.map((d, i) => {
          const y = i * (barH + gap);
          const barW = max > 0 ? ((d[valueKey] / max) * (w - lblW - numW)) : 0;
          const lbl = String(d[labelKey] || "").replace(/Non-Brand - |Brand - |\| Chicago.*|Exact.*|PI |Law /gi, "").trim().slice(0, 24);
          return (
            <g key={i}>
              <text x={lblW - 6} y={y + barH * 0.68} textAnchor="end" fontSize="10" fill={T.faint} fontFamily={T.fontMono}>{lbl}</text>
              <rect x={lblW} y={y + 3} width={Math.max(barW, 2)} height={barH - 6} fill={color} rx="3" opacity="0.75" />
              <text x={lblW + barW + 5} y={y + barH * 0.68} fontSize="10" fill={T.faint} fontFamily={T.fontMono}>{formatValue(d[valueKey])}</text>
            </g>
          );
        })}
        {targetValue && max > 0 && (() => {
          const tx = lblW + (targetValue / max) * (w - lblW - numW);
          return (
            <>
              <line x1={tx} y1={0} x2={tx} y2={sorted.length * (barH + gap)} stroke={T.amber} strokeWidth="1.5" strokeDasharray="4,3" />
              <text x={tx + 4} y={10} fontSize="9" fill={T.amber} fontFamily={T.fontDisplay}>{targetLabel}</text>
            </>
          );
        })()}
      </svg>
    </div>
  );
}


// ─── Analyst View ─────────────────────────────────────────────────────────────
// ─── Round 3: Analyst memory & comparison ────────────────────────────────────
// When the same account has been analyzed before, show what changed since last
// time — the single most useful thing an analyst wants on re-analysis.
export function compareAnalyses(current, prior) {
  if (!current || !prior) return null;
  const cm = current.csvMetrics, pm = prior.csvMetrics;
  const deltas = [];
  if (cm && pm) {
    const metrics = [
      { key: "totalCost", label: "Spend", money: true, inverse: false },
      { key: "totalConv", label: "Conversions", money: false, inverse: false },
      { key: "avgCPA", label: "CPA", money: true, inverse: true },   // lower CPA is better
      { key: "avgCPC", label: "Avg CPC", money: true, inverse: true },
    ];
    metrics.forEach(m => {
      const cur = cm[m.key] || 0, prev = pm[m.key] || 0;
      if (prev === 0) return;
      const pctChange = Math.round(((cur - prev) / prev) * 100);
      if (Math.abs(pctChange) < 1) return;
      const good = m.inverse ? pctChange < 0 : pctChange > 0;
      deltas.push({ label: m.label, pctChange, good, cur, prev, money: m.money });
    });
  }
  const signalChanged = current.signal !== prior.signal;
  return { deltas, signalChanged, priorSignal: prior.signal, currentSignal: current.signal, priorDate: prior.savedAt };
}


export function AnalysisComparison({ current, savedAnalyses }) {
  if (!current?.clientName) return null;
  // Most recent prior save for the same client (excluding the current one).
  const prior = savedAnalyses
    .filter(s => s.clientName?.toLowerCase() === current.clientName.toLowerCase() && s.id !== current.id)
    .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt))[0];
  if (!prior) return null;
  const cmp = compareAnalyses(current, prior);
  if (!cmp || (cmp.deltas.length === 0 && !cmp.signalChanged)) return null;

  const daysAgo = Math.floor((Date.now() - new Date(cmp.priorDate).getTime()) / 86400000);
  const fmtVal = (v, money) => money ? `$${Math.round(v).toLocaleString()}` : Math.round(v).toLocaleString();
  const SIG = { needs_attention: { c: SEV.critical, l: "Needs Attention" }, stable: { c: SEV.warning, l: "Stable" }, performing: { c: SEV.pass, l: "Performing" } };

  return (
    <div style={{ marginBottom: "16px", padding: "16px 18px", background: T.surface, border: `1px solid ${T.lineInk}`, borderRadius: "12px", boxShadow: T.shadowCard }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "14px" }}>
        <span style={{ fontSize: "11px", fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.12em", fontFamily: T.fontDisplay }}>Since Last Analysis</span>
        <span style={{ fontSize: "10px", color: T.faint }}>{daysAgo === 0 ? "earlier today" : `${daysAgo}d ago`}</span>
      </div>

      {cmp.signalChanged && (
        <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "12px", fontSize: "12px" }}>
          <span style={{ color: T.faint }}>Signal</span>
          <span style={{ fontWeight: 700, color: SIG[cmp.priorSignal]?.c || T.muted }}>{SIG[cmp.priorSignal]?.l || cmp.priorSignal}</span>
          <span style={{ color: T.ghost }}>→</span>
          <span style={{ fontWeight: 700, color: SIG[cmp.currentSignal]?.c || T.muted }}>{SIG[cmp.currentSignal]?.l || cmp.currentSignal}</span>
        </div>
      )}

      {cmp.deltas.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: "10px" }}>
          {cmp.deltas.map((d, i) => (
            <div key={i} style={{ padding: "10px 12px", background: T.subtle, borderRadius: "9px" }}>
              <div style={{ fontSize: "9px", fontWeight: 700, color: T.faint, textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: T.fontDisplay, marginBottom: "5px" }}>{d.label}</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: "6px" }}>
                <span style={{ fontSize: "15px", fontWeight: 600, color: T.ink, fontFamily: T.fontMono }}>{fmtVal(d.cur, d.money)}</span>
                <span style={{ fontSize: "11px", fontWeight: 700, color: d.good ? SEV.pass : SEV.critical, fontFamily: T.fontMono }}>{d.pctChange > 0 ? "▲" : "▼"}{Math.abs(d.pctChange)}%</span>
              </div>
              <div style={{ fontSize: "9px", color: T.ghost, marginTop: "2px", fontFamily: T.fontMono }}>was {fmtVal(d.prev, d.money)}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


export function AnalystView() {
  const REPORT_TYPES = [
    { key: "campaign", label: "Campaign / Keyword Report", hint: "Campaign, Keyword, Cost, Conv, CPC, IS" },
    { key: "searchTerms", label: "Search Terms Report", hint: "Search term, Campaign, Cost, Conversions" },
    { key: "auctionInsights", label: "Auction Insights", hint: "Competitor, Impr. Share, Outranking Share" },
    { key: "changeHistory", label: "Change History", hint: "Date, Change type, Before, After" },
  ];

  const [uploads, setUploads] = useState({});
  const [clientName, setClientName] = useState("");
  const [clientContext, setClientContext] = useState("");
  const [analysis, setAnalysis] = useState(null);
  const [rawAnalysis, setRawAnalysis] = useState("");
  const [analyzing, setAnalyzing] = useState(false);
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [sending, setSending] = useState(false);
  const [reportGenerating, setReportGenerating] = useState(false);
  const [clientReport, setClientReport] = useState("");
  const [showReport, setShowReport] = useState(false);
  const [csvMetrics, setCsvMetrics] = useState(null);
  const [savedAnalyses, setSavedAnalyses] = useState(() => {
    try { return store.get("analyst_saves", []); }
    catch { return []; }
  });
  const [completedWins, setCompletedWins] = useState(() => sm.get("completed_wins") || {});
  const [localQueue, setLocalQueue] = useState([]);
  const [queueVisible, setQueueVisible] = useState(false);
  const [synthesizing, setSynthesizing] = useState(false);
  const [portfolioInsight, setPortfolioInsight] = useState(null);
  const chatEndRef = useRef(null);

  // Load action queue from sessionMemory when client name changes or analysis runs
  useEffect(() => {
    if (!clientName) return;
    const key = `queue_${clientName.toLowerCase().replace(/\s+/g, "_")}`;
    const q = sm.get(key);
    if (q?.length) { setLocalQueue(q); setQueueVisible(true); }
  }, [clientName, analysis]);

  const toggleWin = (winKey) => {
    const updated = { ...completedWins, [winKey]: !completedWins[winKey] };
    setCompletedWins(updated);
    sm.set("completed_wins", updated);
  };

  const updateQueueItem = (id, status) => {
    const key = `queue_${(clientName || "unnamed").toLowerCase().replace(/\s+/g, "_")}`;
    const updated = localQueue.map(q => q.id === id ? { ...q, status } : q);
    setLocalQueue(updated);
    sm.set(key, updated);
  };

  const synthesizePortfolio = async () => {
    if (!savedAnalyses.length) return;
    setSynthesizing(true);
    try {
      const clientSummaries = savedAnalyses.slice(0, 10).map(s => {
        const bridge = sm.get(`analysis_${(s.clientName || "unnamed").toLowerCase().replace(/\s+/g, "_")}`);
        return `${s.clientName}: ${bridge?.signal || s.signal || "unknown"} — ${bridge?.topFinding || s.analysis?.priorities?.[0]?.action || "no finding"}`;
      }).join("\n");
      const prompt = `Review these Google Ads client statuses and tell me where to focus first.\n\n${clientSummaries}\n\nReturn JSON only: {"ranked":[{"client":"name","urgency":1,"sentence":"one specific action sentence"}]}`;
      const r = await callClaude({ model: "claude-haiku-4-5-20251001", max_tokens: 600, system: [{ type: "text", text: ANALYST_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: prompt }], fn: "portfolio_synthesis", promptChars: prompt.length });
      const parsed = JSON.parse((r.text || "").replace(/```json|```/g, "").trim());
      setPortfolioInsight(parsed.ranked || []);
    } catch {}
    setSynthesizing(false);
  };

  const persistSaves = (saves) => {
    store.set("analyst_saves", saves);
    setSavedAnalyses(saves);
  };

  const saveCurrentAnalysis = () => {
    if (!analysis && !rawAnalysis) return;
    const save = {
      id: Date.now(),
      clientName: clientName || "Unnamed",
      clientContext,
      savedAt: new Date().toISOString(),
      signal: analysis?.signal || "stable",
      analysis,
      csvMetrics,
      messages,
      uploads: Object.fromEntries(Object.entries(uploads).map(([k, v]) => [k, { name: v.name, headers: v.headers, rows: v.rows.slice(0, 200), totalRows: v.totalRows }])),
    };
    const existing = store.get("analyst_saves", []);
    persistSaves([save, ...existing].slice(0, 15));
  };

  const loadSavedAnalysis = (save) => {
    setClientName(save.clientName || "");
    setClientContext(save.clientContext || "");
    setUploads(save.uploads || {});
    setAnalysis(save.analysis || null);
    setCsvMetrics(save.csvMetrics || null);
    setMessages(save.messages || []);
    setRawAnalysis("");
    setClientReport("");
  };

  const deleteSave = (id, e) => {
    e.stopPropagation();
    const updated = store.get("analyst_saves", []).filter(s => s.id !== id);
    persistSaves(updated);
  };

  const hasUploads = Object.keys(uploads).length > 0;
  const hasAnalysis = !!(analysis || rawAnalysis);
  const chatMessages = messages.filter(m => !m.hidden);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  // Compute metrics from CSV data whenever uploads change
  useEffect(() => {
    if (!uploads.campaign) { setCsvMetrics(null); return; }
    const rows = uploads.campaign.rows;
    const parse = v => parseFloat(String(v || "0").replace(/[$,%\s,]/g, "")) || 0;
    const campaigns = {};
    for (const row of rows) {
      const name = Object.values(row)[0] || "Unknown";
      if (name === "--" || !name) continue;
      if (!campaigns[name]) campaigns[name] = { name, cost: 0, conversions: 0, clicks: 0, impressions: 0 };
      const cost = parse(row["Cost"] || row["cost"] || row["Spend"] || "0");
      const conv = parse(row["Conversions"] || row["conversions"] || "0");
      const clicks = parse(row["Clicks"] || row["clicks"] || "0");
      campaigns[name].cost += cost;
      campaigns[name].conversions += conv;
      campaigns[name].clicks += clicks;
    }
    const camps = Object.values(campaigns).filter(c => c.cost > 0.01);
    const totalCost = camps.reduce((s, c) => s + c.cost, 0);
    const totalConv = camps.reduce((s, c) => s + c.conversions, 0);
    const avgCPA = totalConv > 0 ? totalCost / totalConv : 0;
    const avgCPC = camps.reduce((s, c) => s + c.clicks, 0) > 0
      ? totalCost / camps.reduce((s, c) => s + c.clicks, 0) : 0;
    setCsvMetrics({ camps, totalCost, totalConv, avgCPA, avgCPC });
  }, [uploads]);

  const parseCSV = (text) => {
    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split("\n");
    if (lines.length < 2) return { headers: [], rows: [] };
    const parseRow = (line) => {
      const result = []; let cur = ""; let inQ = false;
      for (const ch of line) {
        if (ch === '"') inQ = !inQ;
        else if (ch === "," && !inQ) { result.push(cur.trim()); cur = ""; }
        else cur += ch;
      }
      result.push(cur.trim());
      return result;
    };
    const headers = parseRow(lines[0]).map(h => h.replace(/^"|"$/g, ""));
    const rows = lines.slice(1)
      .map(line => Object.fromEntries(headers.map((h, i) => [h, (parseRow(line)[i] || "").replace(/^"|"$/g, "")])))
      .filter(row => Object.values(row).some(v => v.trim()));
    return { headers, rows };
  };

  const handleFileUpload = (typeKey, file) => {
    const reader = new FileReader();
    reader.onload = e => {
      const { headers, rows } = parseCSV(e.target.result);
      setUploads(prev => ({ ...prev, [typeKey]: { name: file.name, headers, rows, totalRows: rows.length } }));
    };
    reader.readAsText(file);
  };

  const formatForPrompt = (upload, maxRows = 25) => {
    const { headers, rows } = upload;
    const keyHeaders = headers.filter(h => !["Status","Ad group"].includes(h)).slice(0, 12);
    const head = keyHeaders.join(" | ");
    const body = rows.slice(0, maxRows).map(r => keyHeaders.map(h => r[h] || "—").join(" | ")).join("\n");
    return `${head}\n${body}${rows.length > maxRows ? `\n[+${rows.length - maxRows} more rows]` : ""}`;
  };

  // Thin adapter over the global callClaude seam — keeps the analyst's cached
  // system prompt + throw-on-error contract that AnalystView's callers expect.
  const analystClaude = async (messages, maxTokens = 2000, useHaiku = false) => {
    const __model = useHaiku ? "claude-haiku-4-5-20251001" : "claude-sonnet-4-6";
    const r = await callClaude({ model: __model, max_tokens: maxTokens, system: [{ type: "text", text: ANALYST_SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }], messages, fn: "analyst_call" });
    if (!r.ok) throw new Error(r.error || "API error");
    return r.text || "";
  };

  const extractJSON = (text) => {
    const cleaned = text.replace(/^```json\s*/m, "").replace(/```\s*$/m, "").trim();
    // Try direct parse
    try { return JSON.parse(cleaned); } catch {}
    // Find outermost { }
    const start = cleaned.indexOf("{");
    if (start === -1) return null;
    // Try from start to end
    try { return JSON.parse(cleaned.slice(start)); } catch {}
    // Try to find last complete }
    for (let i = cleaned.length - 1; i > start; i--) {
      if (cleaned[i] === "}") {
        try { return JSON.parse(cleaned.slice(start, i + 1)); } catch {}
      }
    }
    return null;
  };

  const runAnalysis = async () => {
    if (!hasUploads) return;
    setAnalyzing(true); setAnalysis(null); setRawAnalysis(""); setMessages([]); setClientReport("");
    const dataSections = Object.entries(uploads).map(([key, u]) => {
      const label = REPORT_TYPES.find(r => r.key === key)?.label || key;
      return `## ${label.toUpperCase()} (${u.totalRows} rows total)\n${formatForPrompt(u)}`;
    }).join("\n\n---\n\n");

    const clientSlug = (clientName || "unnamed").toLowerCase().replace(/\s+/g, "_");
    const priorSessions = memoryHistory.get(clientSlug);
    const priorContext = priorSessions.length
      ? `\n\nPRIOR CONTEXT FOR THIS CLIENT (read this before diagnosing — do not re-discover what is already known):\n${priorSessions.map(s => `- ${new Date(s.date).toLocaleDateString()}: ${s.signal} — ${s.topFinding}`).join("\n")}\nIf this analysis confirms a known issue, say so explicitly rather than presenting it as new. If it contradicts prior findings, flag the change.`
      : "";

    const userPrompt = `Analyze this Google Ads account data.${clientName ? `\nCLIENT: ${clientName}` : ""}${clientContext ? `\nCONTEXT: ${clientContext}` : ""}${priorContext}\n\nDATA:\n${dataSections}\n\nReturn ONLY valid JSON (no markdown, no preamble). Every finding must cite a specific data point. Be precise:\n{"signal":"needs_attention|stable|performing","signalReason":"one sentence with a specific metric","dataQualityNote":"what you trust and what to be cautious about","reasoningTrace":"2-3 sentences on what you checked first and why","summary":"2-3 sentence executive summary with specific numbers","priorities":[{"rank":1,"action":"specific action title","rationale":"what and why — reference data","sourceData":"the exact metric that triggered this","impact":"high|medium|low","effort":"low|medium|high","confidence":0.90}],"findings":[{"area":"Tracking|Efficiency|Structure|Coverage|Creative","status":"critical|warning|ok","insights":["specific finding with data","specific finding"],"citations":["data point supporting this finding"],"confidence":0.85}],"quickWins":[{"action":"specific win","estimatedImpact":"expected outcome","effortLevel":"30min|2hrs|half-day"}]}`;

    try {
      const text = await analystClaude([{ role: "user", content: userPrompt }], 4000);
      const parsed = extractJSON(text);
      if (parsed) setAnalysis(parsed);
      else setRawAnalysis(text);
      const initMessages = [
        { role: "user", content: userPrompt, hidden: true },
        { role: "assistant", content: text, hidden: true },
      ];
      setMessages(initMessages);
      // Auto-save after analysis
      if (parsed) {
        // Write to cross-tab intelligence bridge
        const bridgeKey = `analysis_${clientSlug}`;
        const memoryEntry = {
          clientName: clientName || "Unnamed",
          signal: parsed.signal,
          signalReason: parsed.signalReason,
          topFinding: parsed.priorities?.[0]?.action || parsed.summary?.slice(0, 80),
          topPriority: parsed.priorities?.[0] || null,
          date: new Date().toISOString(),
          summary: parsed.summary,
          dataQualityNote: parsed.dataQualityNote,
        };
        sm.set(bridgeKey, memoryEntry);          // "latest" pointer — read by OutreachCard + portfolio panel
        memoryHistory.push(clientSlug, memoryEntry); // history — read INTO the next analysis prompt above
        // Auto-populate local action queue (no API, pure computation)
        if (parsed.priorities?.length) {
          const qItems = parsed.priorities.map(p => ({
            id: `${Date.now()}_${p.rank}`,
            clientName: clientName || "Unnamed",
            action: p.action,
            rationale: p.rationale,
            sourceData: p.sourceData,
            impact: p.impact,
            effort: p.effort,
            confidence: p.confidence,
            status: "pending",
            createdAt: new Date().toISOString(),
          }));
          sm.set(`queue_${(clientName || "unnamed").toLowerCase().replace(/\s+/g, "_")}`, qItems);
        }
        const save = {
          id: Date.now(),
          clientName: clientName || "Unnamed",
          clientContext,
          savedAt: new Date().toISOString(),
          signal: parsed?.signal || "stable",
          analysis: parsed,
          csvMetrics: null, // will be set by effect
          messages: initMessages,
          uploads: Object.fromEntries(Object.entries(uploads).map(([k, v]) => [k, { name: v.name, headers: v.headers, rows: v.rows.slice(0, 200), totalRows: v.totalRows }])),
        };
        const existing = store.get("analyst_saves", []);
        const updated = [save, ...existing].slice(0, 15);
        localStorage.setItem("clarify_analyst_saves", JSON.stringify(updated));
        setSavedAnalyses(updated);
      }
    } catch (err) { setRawAnalysis(`Analysis failed: ${err.message}`); }
    setAnalyzing(false);
  };

  const sendChat = async () => {
    if (!chatInput.trim() || sending) return;
    const userMsg = chatInput.trim(); setChatInput("");
    const updated = [...messages, { role: "user", content: userMsg }];
    setMessages(updated); setSending(true);
    try {
      const reply = await analystClaude(updated.map(({ role, content }) => ({ role, content })), 1500);
      setMessages(prev => [...prev, { role: "assistant", content: reply }]);
    } catch (err) { setMessages(prev => [...prev, { role: "assistant", content: `Error: ${err.message}` }]); }
    setSending(false);
  };

  const generateReport = async () => {
    if (!hasAnalysis) return;
    setReportGenerating(true);
    try {
      const report = await analystClaude([
        ...messages.map(({ role, content }) => ({ role, content })),
        { role: "user", content: `Write a professional client-facing report from this analysis. Clear headers, plain language, no jargon. Include: Executive Summary, What We Found, Priority Actions This Month, Expected Outcomes. End with: Clarify Paid Search${clientName ? ` — ${clientName}` : ""} · ${new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })}` }
      ], 3000);
      setClientReport(report); setShowReport(true);
    } catch (err) { console.error(err); }
    setReportGenerating(false);
  };

  const SIG = {
    needs_attention: { color: SEV.critical, bg: `${SEV.critical}12`, border: `${SEV.critical}33`, label: "Needs Attention", icon: "⚠" },
    stable: { color: SEV.warning, bg: `${SEV.warning}12`, border: `${SEV.warning}33`, label: "Stable", icon: "◎" },
    performing: { color: SEV.pass, bg: `${SEV.pass}12`, border: `${SEV.pass}33`, label: "Performing", icon: "✓" },
  };
  const FSTATUS_COLOR = { critical: SEV.critical, warning: SEV.warning, ok: SEV.pass };
  const IMPACT_COLOR = { high: SEV.pass, medium: SEV.warning, low: T.faint };
  const EFFORT_COLOR = { low: SEV.pass, medium: SEV.warning, high: SEV.critical };
  const sig = SIG[analysis?.signal] || SIG.stable;

  return (
    <div className="co-grid-side" style={{ display: "grid", gridTemplateColumns: "264px 1fr", minHeight: "calc(100vh - 48px)", background: "transparent" }}>
      {/* Sidebar */}
      <div style={{ borderRight: `1px solid ${T.lineInk}`, padding: "24px 16px", background: T.surface, overflowY: "auto", display: "flex", flexDirection: "column" }}>
        <div style={{ marginBottom: "14px" }}>
          <div style={{ fontSize: "9px", fontWeight: 700, color: T.gold, textTransform: "uppercase", letterSpacing: "0.14em", fontFamily: T.fontDisplay, marginBottom: "2px" }}>Reports</div>
          <div style={{ fontSize: "11px", color: T.faint }}>Upload Google Ads exports</div>
        </div>
        {REPORT_TYPES.map(type => (
          <UploadCard key={type.key} type={type} upload={uploads[type.key]}
            onUpload={file => handleFileUpload(type.key, file)}
            onRemove={() => setUploads(prev => { const n = { ...prev }; delete n[type.key]; return n; })} />
        ))}
        <div style={{ borderTop: `1px solid ${T.lineSoft}`, paddingTop: "16px", marginTop: "10px" }}>
          <div style={{ fontSize: "9px", fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.14em", fontFamily: T.fontDisplay, marginBottom: "8px" }}>Client Context</div>
          <input value={clientName} onChange={e => setClientName(e.target.value)} placeholder="Client name"
            style={{ width: "100%", padding: "7px 10px", background: T.subtle, border: `1px solid ${T.line}`, borderRadius: "7px", fontSize: "12px", color: T.ink, outline: "none", boxSizing: "border-box", marginBottom: "7px" }} />
          <textarea value={clientContext} onChange={e => setClientContext(e.target.value)} rows={4}
            placeholder="Goals, recent changes, client concerns, anything AI should know…"
            style={{ width: "100%", padding: "7px 10px", background: T.subtle, border: `1px solid ${T.line}`, borderRadius: "7px", fontSize: "12px", color: T.ink, outline: "none", resize: "vertical", fontFamily: "inherit", boxSizing: "border-box", lineHeight: 1.5 }} />
        </div>
        <div style={{ marginTop: "auto", paddingTop: "14px" }}>
          <button onClick={runAnalysis} disabled={!hasUploads || analyzing}
            style={{ width: "100%", padding: "11px", background: !hasUploads || analyzing ? T.subtle : T.goldGrad, border: "none", borderRadius: "9px", color: !hasUploads || analyzing ? T.faint : T.textOnBrand, fontSize: "12px", fontWeight: 700, cursor: !hasUploads || analyzing ? "not-allowed" : "pointer", letterSpacing: "0.05em", fontFamily: T.fontDisplay }}>
            {analyzing ? "Analyzing…" : "✦ Run Analysis"}
          </button>
          {hasAnalysis && (
            <button onClick={generateReport} disabled={reportGenerating}
              style={{ width: "100%", marginTop: "7px", padding: "9px", background: "transparent", border: `1px solid ${T.line}`, borderRadius: "9px", color: T.muted, fontSize: "11px", fontWeight: 600, cursor: reportGenerating ? "not-allowed" : "pointer", fontFamily: T.fontDisplay }}>
              {reportGenerating ? "Generating…" : "↗ Client Report"}
            </button>
          )}
        </div>

        {/* Saved analyses */}
        {savedAnalyses.length > 0 && (
          <div style={{ borderTop: `1px solid ${T.lineSoft}`, paddingTop: "16px", marginTop: "16px" }}>
            <div style={{ fontSize: "9px", fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.14em", fontFamily: T.fontDisplay, marginBottom: "10px" }}>Saved Analyses</div>
            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              {savedAnalyses.map(save => {
                const SIG_COLORS = { needs_attention: SEV.critical, stable: SEV.warning, performing: SEV.pass };
                const dot = SIG_COLORS[save.signal] || T.faint;
                const ago = (() => {
                  const diff = Date.now() - save.id;
                  const mins = Math.floor(diff / 60000);
                  const hrs = Math.floor(mins / 60);
                  const days = Math.floor(hrs / 24);
                  if (days > 0) return `${days}d ago`;
                  if (hrs > 0) return `${hrs}h ago`;
                  return `${mins}m ago`;
                })();
                return (
                  <div key={save.id} onClick={() => loadSavedAnalysis(save)}
                    style={{ display: "flex", alignItems: "center", gap: "8px", padding: "9px 10px", background: T.subtle, border: `1px solid ${T.lineInk}`, borderRadius: "8px", cursor: "pointer" }}
                    onMouseEnter={e => e.currentTarget.style.background = T.raised}
                    onMouseLeave={e => e.currentTarget.style.background = T.subtle}>
                    <span style={{ width: "6px", height: "6px", borderRadius: "50%", background: dot, flexShrink: 0, boxShadow: `0 0 4px ${dot}80` }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: "11px", fontWeight: 600, color: T.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{save.clientName}</div>
                      <div style={{ fontSize: "10px", color: T.faint, fontFamily: T.fontMono }}>{ago}</div>
                    </div>
                    <button onClick={e => deleteSave(save.id, e)}
                      style={{ background: "none", border: "none", color: T.ghost, cursor: "pointer", fontSize: "14px", lineHeight: 1, padding: "0 2px", flexShrink: 0 }}>×</button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Main */}
      <div style={{ overflowY: "auto", padding: "24px 28px", minWidth: 0 }}>
        {/* Portfolio Intelligence Panel — shows when no active analysis but saved sessions exist */}
        {!hasAnalysis && !analyzing && !csvMetrics && savedAnalyses.length === 0 && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "400px" }}>
            <EmptyState icon="chart" title="Upload reports to get started" sub="Upload at least one Google Ads export, add client context, then run the analysis." />
          </div>
        )}

        {/* Portfolio panel — pre-computed from saved sessions, zero API cost */}
        {!hasAnalysis && !analyzing && !csvMetrics && savedAnalyses.length > 0 && (
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "16px" }}>
              <div>
                <div style={{ fontSize: "16px", fontWeight: 700, color: T.inkDeep, fontFamily: T.fontDisplay, letterSpacing: "-0.01em" }}>Portfolio Intelligence</div>
                <div style={{ fontSize: "11px", color: T.faint, marginTop: "2px" }}>{savedAnalyses.length} saved session{savedAnalyses.length !== 1 ? "s" : ""} · computed instantly</div>
              </div>
              <button onClick={synthesizePortfolio} disabled={synthesizing}
                style={{ padding: "8px 16px", background: synthesizing ? T.subtle : T.goldGrad, border: "none", borderRadius: "8px", color: synthesizing ? T.faint : T.textOnBrand, fontSize: "11px", fontWeight: 700, cursor: synthesizing ? "not-allowed" : "pointer", fontFamily: T.fontDisplay, letterSpacing: "0.04em" }}>
                {synthesizing ? "Synthesizing…" : "✦ Synthesize"}
              </button>
            </div>

            {/* Synthesized ranking */}
            {portfolioInsight?.length > 0 && (
              <div style={{ background: T.surface, borderRadius: "11px", border: `1px solid ${T.lineInk}`, padding: "16px 18px", marginBottom: "14px", boxShadow: T.shadowCard }}>
                <div style={{ fontSize: "9px", fontWeight: 700, color: T.gold, textTransform: "uppercase", letterSpacing: "0.14em", fontFamily: T.fontDisplay, marginBottom: "12px" }}>Where To Focus First</div>
                {portfolioInsight.map((item, i) => (
                  <div key={i} style={{ display: "flex", gap: "12px", alignItems: "flex-start", marginBottom: i < portfolioInsight.length - 1 ? "10px" : 0 }}>
                    <span style={{ fontSize: "14px", fontWeight: 500, color: T.ghost, fontFamily: T.fontMono, minWidth: "20px" }}>0{item.urgency}</span>
                    <div>
                      <span style={{ fontSize: "12px", fontWeight: 700, color: T.ink, fontFamily: T.fontDisplay }}>{item.client}</span>
                      <span style={{ fontSize: "12px", color: T.muted, marginLeft: "6px" }}>— {item.sentence}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Saved sessions grid */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: "10px" }}>
              {savedAnalyses.map(save => {
                const SIG_MAP = { needs_attention: { color: SEV.critical, label: "Needs Attention" }, stable: { color: SEV.warning, label: "Stable" }, performing: { color: SEV.pass, label: "Performing" } };
                const sig = SIG_MAP[save.signal] || SIG_MAP.stable;
                const bridge = sm.get(`analysis_${(save.clientName || "unnamed").toLowerCase().replace(/\s+/g, "_")}`);
                const topAction = bridge?.topFinding || save.analysis?.priorities?.[0]?.action;
                const ago = (() => { const d = Date.now() - save.id; const h = Math.floor(d/3600000); return h < 24 ? `${h}h ago` : `${Math.floor(h/24)}d ago`; })();
                return (
                  <div key={save.id} onClick={() => { setClientName(save.clientName || ""); setClientContext(save.clientContext || ""); setUploads(save.uploads || {}); setAnalysis(save.analysis || null); setCsvMetrics(save.csvMetrics || null); setMessages(save.messages || []); setRawAnalysis(""); }}
                    style={{ background: T.surface, borderRadius: "11px", border: `1px solid ${T.lineInk}`, padding: "14px 16px", cursor: "pointer", boxShadow: T.shadowCard, transition: "box-shadow 0.15s" }}
                    onMouseEnter={e => e.currentTarget.style.boxShadow = T.shadowHover}
                    onMouseLeave={e => e.currentTarget.style.boxShadow = T.shadowCard}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                      <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: sig.color, flexShrink: 0, boxShadow: `0 0 5px ${sig.color}80` }} />
                      <span style={{ fontSize: "13px", fontWeight: 700, color: T.ink, fontFamily: T.fontDisplay, flex: 1 }}>{save.clientName || "Unnamed"}</span>
                      <span style={{ fontSize: "10px", color: T.faint, fontFamily: T.fontMono }}>{ago}</span>
                    </div>
                    {topAction && <div style={{ fontSize: "11px", color: T.muted, lineHeight: 1.55, marginBottom: "6px" }}>{topAction}</div>}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                      <span style={{ fontSize: "9px", fontWeight: 700, color: sig.color, textTransform: "uppercase", letterSpacing: "0.08em", fontFamily: T.fontDisplay }}>{sig.label}</span>
                      <button onClick={e => { e.stopPropagation(); const s = store.get("analyst_saves", []).filter(x => x.id !== save.id); store.set("analyst_saves", s); setSavedAnalyses(s); }}
                        style={{ background: "none", border: "none", color: T.ghost, cursor: "pointer", fontSize: "14px", padding: "0 2px" }}>×</button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Pre-analysis metrics from CSV */}
        {csvMetrics && !hasAnalysis && !analyzing && (
          <div style={{ marginBottom: "20px" }}>
            <div style={{ fontSize: "9px", fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.14em", fontFamily: T.fontDisplay, marginBottom: "10px" }}>From Uploaded Data</div>
            <div style={{ display: "flex", gap: "8px", marginBottom: "16px", flexWrap: "wrap" }}>
              <MetricTile label="Total Spend" value={`$${csvMetrics.totalCost.toLocaleString("en-US", { maximumFractionDigits: 0 })}`} sub="across all campaigns" />
              <MetricTile label="Conversions" value={csvMetrics.totalConv.toFixed(0)} sub="reported total" />
              <MetricTile label="Avg CPA" value={csvMetrics.avgCPA > 0 ? `$${csvMetrics.avgCPA.toFixed(0)}` : "—"} sub="cost per conversion" accent />
              <MetricTile label="Avg CPC" value={csvMetrics.avgCPC > 0 ? `$${csvMetrics.avgCPC.toFixed(2)}` : "—"} sub="cost per click" />
              <MetricTile label="Campaigns" value={csvMetrics.camps.length} sub="with spend data" />
            </div>
            <BarChart data={csvMetrics.camps} valueKey="cost" labelKey="name" color={T.blue}
              formatValue={v => `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
              title="Spend by Campaign" />
          </div>
        )}

        {/* Loading */}
        {analyzing && (
          // The status line stays — an analysis run takes long enough that
          // naming the stage is real information, not decoration. What changes
          // is the shape underneath it: a skeleton of the findings list it
          // resolves into, so the answer arrives in place instead of replacing
          // a spinner with a full page of content.
          <div className="pagefade" style={{ minHeight: "360px", paddingTop: "8px" }}>
            <div style={{ fontSize: "13px", fontWeight: 600, color: T.muted, fontFamily: T.fontDisplay }}>Analyzing account data…</div>
            <div style={{ fontSize: "11px", color: T.faint, marginTop: "4px", marginBottom: "18px" }}>Diagnosing, prioritizing, prescribing</div>
            <SkeletonLine width="46%" height="15px" style={{ marginBottom: "14px" }} />
            <SkeletonRows count={3} />
          </div>
        )}

        {/* Full analysis display */}
        {!analyzing && (analysis || rawAnalysis) && (() => {
          return (
            <div>
              {/* Header row */}
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "20px", gap: "16px" }}>
                <div>
                  <button onClick={() => { setAnalysis(null); setRawAnalysis(""); setCsvMetrics(null); setMessages([]); setClientName(""); setClientContext(""); setUploads({}); }}
                    style={{ display: "flex", alignItems: "center", gap: "5px", padding: 0, marginBottom: "8px", background: "none", border: "none", color: T.faint, fontSize: "11px", fontWeight: 600, cursor: "pointer", fontFamily: T.fontDisplay }}>
                    ← Back to Portfolio
                  </button>
                  {clientName && <div style={{ fontSize: "18px", fontWeight: 700, color: T.inkDeep, fontFamily: T.fontDisplay, letterSpacing: "-0.01em" }}>{clientName}</div>}
                  <div style={{ fontSize: "11px", color: T.faint, marginTop: "2px" }}>{new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</div>
                </div>
                {analysis && (
                  <div style={{ display: "flex", alignItems: "center", gap: "8px", padding: "10px 16px", background: sig.bg, border: `1px solid ${sig.border}`, borderRadius: "10px", flexShrink: 0 }}>
                    <span style={{ fontSize: "16px", color: sig.color }}>{sig.icon}</span>
                    <span style={{ fontSize: "11px", fontWeight: 700, color: sig.color, fontFamily: T.fontDisplay, letterSpacing: "0.07em", textTransform: "uppercase" }}>{sig.label}</span>
                  </div>
                )}
              </div>

              {/* Signal reason */}
              {analysis?.signalReason && (
                <div style={{ fontSize: "13px", color: T.muted, marginBottom: "12px", padding: "12px 16px", background: sig.bg, borderRadius: "8px", borderLeft: `3px solid ${sig.color}`, lineHeight: 1.65 }}>{analysis.signalReason}</div>
              )}
              {/* Round 3: what changed since the last analysis of this client */}
              <AnalysisComparison current={{ clientName, signal: analysis?.signal, csvMetrics, id: null }} savedAnalyses={savedAnalyses} />

              {analysis?.dataQualityNote && (
                <div style={{ fontSize: "11px", color: T.muted, marginBottom: "12px", padding: "10px 14px", background: "rgba(255,255,255,0.03)", borderRadius: "8px", border: `1px solid ${T.lineInk}`, display: "flex", gap: "8px", alignItems: "flex-start" }}>
                  <span style={{ flexShrink: 0 }}>🔍</span>
                  <span style={{ lineHeight: 1.6 }}><strong style={{ fontFamily: T.fontDisplay, fontWeight: 700, color: T.muted }}>Data Quality</strong> — {analysis.dataQualityNote}</span>
                </div>
              )}
              {analysis?.reasoningTrace && (
                <ReasoningTrace trace={analysis.reasoningTrace} />
              )}

              {/* Metrics from CSV alongside analysis */}
              {csvMetrics && (
                <div style={{ display: "flex", gap: "8px", marginBottom: "16px", flexWrap: "wrap" }}>
                  <MetricTile label="Total Spend" value={`$${csvMetrics.totalCost.toLocaleString("en-US", { maximumFractionDigits: 0 })}`} sub="period total" />
                  <MetricTile label="Conversions" value={csvMetrics.totalConv.toFixed(0)} sub="reported" />
                  <MetricTile label="Avg CPA" value={csvMetrics.avgCPA > 0 ? `$${csvMetrics.avgCPA.toFixed(0)}` : "—"} color={analysis?.signal === "needs_attention" ? SEV.critical : T.inkDeep} accent />
                  <MetricTile label="Avg CPC" value={csvMetrics.avgCPC > 0 ? `$${csvMetrics.avgCPC.toFixed(2)}` : "—"} sub="cost per click" />
                </div>
              )}

              {/* Charts row */}
              {csvMetrics && csvMetrics.camps.length > 1 && (
                <div className="co-grid2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "12px", marginBottom: "16px" }}>
                  <BarChart data={csvMetrics.camps} valueKey="cost" labelKey="name" color={T.blue}
                    formatValue={v => `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
                    title="Spend by Campaign" />
                  <BarChart
                    data={csvMetrics.camps.filter(c => c.conversions > 0).map(c => ({ ...c, cpa: c.cost / c.conversions }))}
                    valueKey="cpa" labelKey="name" color={T.pink}
                    formatValue={v => `$${v.toFixed(0)}`}
                    title="CPA by Campaign"
                    targetValue={120} targetLabel="$120 target" />
                </div>
              )}

              {/* Summary */}
              {analysis?.summary && (
                <div style={{ background: T.surface, borderRadius: "11px", border: `1px solid ${T.lineInk}`, padding: "18px 20px", marginBottom: "14px", boxShadow: T.shadowCard }}>
                  <div style={{ fontSize: "9px", fontWeight: 700, color: T.faint, textTransform: "uppercase", letterSpacing: "0.14em", fontFamily: T.fontDisplay, marginBottom: "8px" }}>Summary</div>
                  <p style={{ fontSize: "13px", color: T.ink, lineHeight: 1.75, margin: 0 }}>{analysis.summary}</p>
                </div>
              )}

              {/* Priority actions */}
              {analysis?.priorities?.length > 0 && (
                <div style={{ marginBottom: "14px" }}>
                  <div style={{ fontSize: "9px", fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.14em", fontFamily: T.fontDisplay, marginBottom: "10px" }}>Priority Actions</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {analysis.priorities.map((p, i) => (
                      <div key={i} style={{ background: T.surface, borderRadius: "11px", border: `1px solid ${T.lineInk}`, padding: "16px 18px", display: "flex", gap: "16px", alignItems: "flex-start", boxShadow: T.shadowCard }}>
                        <div style={{ fontSize: "22px", fontWeight: 400, color: T.ghost, fontFamily: T.fontMono, lineHeight: 1, minWidth: "28px", paddingTop: "2px" }}>0{p.rank}</div>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "5px" }}>
                            <div style={{ fontSize: "13px", fontWeight: 700, color: T.ink, fontFamily: T.fontDisplay }}>{p.action}</div>
                            {p.confidence != null && <span style={{ fontSize: "9px", fontFamily: T.fontMono, color: p.confidence >= 0.85 ? SEV.pass : SEV.warning, background: `${p.confidence >= 0.85 ? SEV.pass : SEV.warning}1a`, padding: "1px 6px", borderRadius: "20px" }}>{Math.round((p.confidence || 0) * 100)}%</span>}
                          </div>
                          <div style={{ fontSize: "12px", color: T.muted, lineHeight: 1.65, marginBottom: p.sourceData ? "5px" : 0 }}>{p.rationale}</div>
                          {p.sourceData && <div style={{ fontSize: "10px", color: T.faint, fontStyle: "italic" }}>↳ {p.sourceData}</div>}
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: "4px", flexShrink: 0 }}>
                          <span style={{ fontSize: "9px", fontWeight: 700, color: IMPACT_COLOR[p.impact], background: IMPACT_COLOR[p.impact] + "15", padding: "2px 8px", borderRadius: "20px", letterSpacing: "0.07em", textTransform: "uppercase", textAlign: "center", fontFamily: T.fontDisplay }}>{p.impact} impact</span>
                          <span style={{ fontSize: "9px", fontWeight: 700, color: EFFORT_COLOR[p.effort], background: EFFORT_COLOR[p.effort] + "15", padding: "2px 8px", borderRadius: "20px", letterSpacing: "0.07em", textTransform: "uppercase", textAlign: "center", fontFamily: T.fontDisplay }}>{p.effort} effort</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Findings grid */}
              {analysis?.findings?.length > 0 && (
                <div style={{ marginBottom: "14px" }}>
                  <div style={{ fontSize: "9px", fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.14em", fontFamily: T.fontDisplay, marginBottom: "10px" }}>Findings by Area</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: "8px" }}>
                    {analysis.findings.map((f, i) => (
                      <div key={i} style={{ background: T.surface, borderRadius: "11px", border: `1px solid ${FSTATUS_COLOR[f.status] || SEV.pass}22`, padding: "14px 16px", boxShadow: T.shadowCard }}>
                        <div style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "10px" }}>
                          <span style={{ color: FSTATUS_COLOR[f.status] || SEV.pass, fontSize: "9px", fontWeight: 700 }}>●</span>
                          <span style={{ fontSize: "11px", fontWeight: 700, color: T.ink, fontFamily: T.fontDisplay }}>{f.area}</span>
                          {f.confidence != null && <span style={{ marginLeft: "auto", fontSize: "9px", fontFamily: T.fontMono, color: f.confidence >= 0.85 ? SEV.pass : SEV.warning }}>{Math.round((f.confidence||0)*100)}%</span>}
                          <span style={{ fontSize: "9px", fontWeight: 700, color: FSTATUS_COLOR[f.status] || SEV.pass, textTransform: "uppercase", letterSpacing: "0.06em", marginLeft: f.confidence != null ? "4px" : "auto" }}>{f.status}</span>
                        </div>
                        <ul style={{ margin: 0, padding: "0 0 0 14px" }}>
                          {f.insights?.map((ins, j) => (
                            <li key={j} style={{ fontSize: "11px", color: T.muted, lineHeight: 1.65, marginBottom: "4px" }}>{ins}</li>
                          ))}
                        </ul>
                        {f.citations?.length > 0 && (
                          <div style={{ marginTop: "8px", paddingTop: "8px", borderTop: `1px solid ${T.lineSoft}` }}>
                            {f.citations.map((c, j) => <div key={j} style={{ fontSize: "10px", color: T.faint, fontStyle: "italic" }}>↳ {c}</div>)}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Quick wins */}
              {analysis?.quickWins?.length > 0 && (
                <div style={{ marginBottom: "24px" }}>
                  <div style={{ fontSize: "9px", fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.14em", fontFamily: T.fontDisplay, marginBottom: "10px" }}>Quick Wins</div>
                  <div style={{ background: T.surface, borderRadius: "11px", border: `1px solid ${T.lineInk}`, padding: "14px 18px", boxShadow: T.shadowCard }}>
                    {analysis.quickWins.map((win, i) => {
                        const w = typeof win === "string" ? { action: win } : (win || {});
                        const winKey = `${clientName}_qw_${i}`;
                        const done = completedWins[winKey];
                        return (
                          <div key={i} style={{ display: "flex", gap: "10px", alignItems: "flex-start", marginBottom: i < analysis.quickWins.length - 1 ? "10px" : 0, opacity: done ? 0.5 : 1, transition: "opacity 0.2s" }}>
                            <button onClick={() => toggleWin(winKey)}
                              style={{ width: "18px", height: "18px", borderRadius: "4px", border: `2px solid ${done ? SEV.pass : T.line}`, background: done ? SEV.pass : "transparent", cursor: "pointer", flexShrink: 0, marginTop: "1px", display: "flex", alignItems: "center", justifyContent: "center" }}>
                              {done && <span style={{ color: T.textOnBrand, fontSize: "10px", fontWeight: 700 }}>✓</span>}
                            </button>
                            <div style={{ flex: 1 }}>
                              <span style={{ fontSize: "12px", color: T.ink, lineHeight: 1.65, textDecoration: done ? "line-through" : "none" }}>{w.action || String(win)}</span>
                              {w.effortLevel && <span style={{ marginLeft: "8px", fontSize: "9px", fontFamily: T.fontMono, color: T.faint, background: "rgba(255,255,255,0.06)", padding: "1px 7px", borderRadius: "20px" }}>{w.effortLevel}</span>}
                              {w.estimatedImpact && !done && <div style={{ fontSize: "10px", color: T.muted, marginTop: "3px", fontStyle: "italic" }}>→ {w.estimatedImpact}</div>}
                              {done && <div style={{ fontSize: "10px", color: SEV.pass, marginTop: "2px" }}>Completed</div>}
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}

              {/* Action Queue — auto-populated from analysis, approve/skip per item */}
              {localQueue.length > 0 && (
                <div style={{ marginBottom: "24px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "10px" }}>
                    <div style={{ fontSize: "9px", fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.14em", fontFamily: T.fontDisplay }}>Action Queue</div>
                    <span style={{ fontSize: "10px", fontFamily: T.fontMono, color: T.gold, background: T.goldSoft, padding: "1px 7px", borderRadius: "20px" }}>{localQueue.filter(q => q.status === "pending").length} pending</span>
                    <button onClick={() => setQueueVisible(v => !v)} style={{ marginLeft: "auto", background: "none", border: "none", color: T.faint, cursor: "pointer", fontSize: "11px" }}>{queueVisible ? "▲ hide" : "▼ show"}</button>
                  </div>
                  {queueVisible && (
                    <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                      {localQueue.map((item) => (
                        <div key={item.id} style={{ background: T.surface, borderRadius: "10px", border: `1px solid ${item.status === "approved" ? `${SEV.pass}33` : item.status === "skipped" ? T.lineSoft : T.lineInk}`, padding: "12px 14px", opacity: item.status === "skipped" ? 0.45 : 1, transition: "opacity 0.2s, border-color 0.2s", boxShadow: T.shadowCard }}>
                          <div style={{ display: "flex", alignItems: "flex-start", gap: "12px" }}>
                            <div style={{ flex: 1 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                                <span style={{ fontSize: "12px", fontWeight: 700, color: T.ink, fontFamily: T.fontDisplay }}>{item.action}</span>
                                {item.confidence != null && <span style={{ fontSize: "9px", fontFamily: T.fontMono, color: item.confidence >= 0.85 ? SEV.pass : SEV.warning }}>{Math.round((item.confidence||0)*100)}%</span>}
                              </div>
                              <div style={{ fontSize: "11px", color: T.muted, lineHeight: 1.55, marginBottom: item.sourceData ? "4px" : 0 }}>{item.rationale}</div>
                              {item.sourceData && <div style={{ fontSize: "10px", color: T.faint, fontStyle: "italic" }}>↳ {item.sourceData}</div>}
                            </div>
                            <div style={{ display: "flex", flexDirection: "column", gap: "4px", flexShrink: 0 }}>
                              {["high","medium","low"].includes(item.impact) && <span style={{ fontSize: "9px", fontWeight: 700, color: { high: SEV.pass, medium: SEV.warning, low: T.faint }[item.impact], background: { high: `${SEV.pass}1a`, medium: `${SEV.warning}1a`, low: "rgba(255,255,255,0.06)" }[item.impact], padding: "2px 7px", borderRadius: "20px", textTransform: "uppercase", letterSpacing: "0.07em", fontFamily: T.fontDisplay, textAlign: "center" }}>{item.impact}</span>}
                              {item.status === "pending" && (
                                <div style={{ display: "flex", gap: "4px", marginTop: "4px" }}>
                                  <button onClick={() => updateQueueItem(item.id, "approved")} style={{ padding: "4px 8px", background: SEV.pass, border: "none", borderRadius: "6px", color: T.textOnBrand, fontSize: "10px", fontWeight: 700, cursor: "pointer" }}>✓</button>
                                  <button onClick={() => updateQueueItem(item.id, "skipped")} style={{ padding: "4px 8px", background: T.raised, border: "none", borderRadius: "6px", color: T.faint, fontSize: "10px", cursor: "pointer" }}>—</button>
                                </div>
                              )}
                              {item.status === "approved" && <span style={{ fontSize: "10px", color: SEV.pass, fontWeight: 700, marginTop: "4px" }}>✓ Approved</span>}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Raw fallback */}
              {rawAnalysis && (
                <div style={{ background: T.surface, borderRadius: "11px", border: `1px solid ${T.lineInk}`, padding: "20px", marginBottom: "24px" }}>
                  <div style={{ fontSize: "9px", fontWeight: 700, color: T.faint, textTransform: "uppercase", letterSpacing: "0.14em", fontFamily: T.fontDisplay, marginBottom: "12px" }}>Analysis</div>
                  <pre style={{ fontSize: "12px", color: T.ink, lineHeight: 1.75, whiteSpace: "pre-wrap", margin: 0, fontFamily: "inherit" }}>{rawAnalysis}</pre>
                </div>
              )}

              {/* Chat */}
              <div style={{ borderTop: `1px solid ${T.lineInk}`, paddingTop: "24px" }}>
                <div style={{ fontSize: "9px", fontWeight: 700, color: T.muted, textTransform: "uppercase", letterSpacing: "0.14em", fontFamily: T.fontDisplay, marginBottom: "16px" }}>Follow-up · Context carries</div>
                <div style={{ display: "flex", flexDirection: "column", gap: "10px", marginBottom: "14px" }}>
                  {chatMessages.map((m, i) => (
                    <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
                      <div style={{ maxWidth: "78%", padding: "10px 14px", background: m.role === "user" ? T.raised : T.surface, border: m.role === "assistant" ? `1px solid ${T.lineSoft}` : "none", borderRadius: m.role === "user" ? "12px 12px 3px 12px" : "12px 12px 12px 3px", fontSize: "13px", color: T.ink, lineHeight: 1.65, whiteSpace: "pre-wrap" }}>
                        {m.content}
                      </div>
                    </div>
                  ))}
                  {sending && (
                    <div style={{ display: "flex" }}>
                      <div style={{ padding: "12px 16px", background: T.surface, border: `1px solid ${T.lineSoft}`, borderRadius: "12px 12px 12px 3px" }}>
                        <span style={{ color: T.ghost, fontSize: "18px", letterSpacing: "4px" }}>···</span>
                      </div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>
                <div style={{ display: "flex", gap: "8px" }}>
                  <input value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendChat()}
                    placeholder="Ask a follow-up, add context, dig deeper into any area…"
                    style={{ flex: 1, padding: "11px 14px", background: T.subtle, border: `1px solid ${T.line}`, borderRadius: "9px", fontSize: "13px", color: T.ink, outline: "none" }} />
                  <button onClick={sendChat} disabled={!chatInput.trim() || sending}
                    style={{ padding: "11px 20px", background: !chatInput.trim() || sending ? T.subtle : T.goldGrad, border: "none", borderRadius: "9px", color: !chatInput.trim() || sending ? T.faint : T.textOnBrand, fontSize: "12px", fontWeight: 700, cursor: !chatInput.trim() || sending ? "not-allowed" : "pointer", fontFamily: T.fontDisplay }}>
                    Send
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
      </div>

      {/* Client report modal */}
      {showReport && (
        <div className="co-modal-overlay" style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: "40px" }}
          onClick={e => e.target === e.currentTarget && setShowReport(false)}>
          <div className="co-modal-sheet" style={{ background: T.surface, borderRadius: "14px", maxWidth: "700px", width: "100%", maxHeight: "82vh", overflow: "hidden", display: "flex", flexDirection: "column", boxShadow: T.shadowModal }}>
            <div style={{ padding: "18px 24px", borderBottom: `1px solid ${T.line}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: "13px", fontWeight: 700, color: T.ink, fontFamily: T.fontDisplay }}>Client Report</span>
              <div style={{ display: "flex", gap: "8px" }}>
                <button onClick={() => navigator.clipboard.writeText(clientReport)} style={{ padding: "5px 12px", background: T.raised, border: "none", borderRadius: "6px", fontSize: "11px", fontWeight: 600, cursor: "pointer", color: T.muted }}>Copy</button>
                <button onClick={() => setShowReport(false)} className="co-modal-close" style={{ background: "none", border: "none", fontSize: "20px", color: T.faint, cursor: "pointer" }}>×</button>
              </div>
            </div>
            <div style={{ flex: 1, overflowY: "auto", padding: "24px 28px" }}>
              <pre style={{ fontSize: "13px", color: T.ink, lineHeight: 1.85, whiteSpace: "pre-wrap", fontFamily: "inherit", margin: 0 }}>{clientReport}</pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}



// ─── ReasoningTrace ───────────────────────────────────────────────────────────
export function ReasoningTrace({ trace }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginBottom: "12px", background: "rgba(255,255,255,0.03)", borderRadius: "8px", border: `1px solid ${T.lineSoft}`, overflow: "hidden" }}>
      <button onClick={() => setOpen(o => !o)} style={{ width: "100%", padding: "10px 14px", background: "none", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: "8px", textAlign: "left" }}>
        <span style={{ fontSize: "10px" }}>🧠</span>
        <span style={{ fontSize: "10px", fontWeight: 700, color: T.muted, fontFamily: T.fontDisplay, letterSpacing: "0.08em", textTransform: "uppercase" }}>How the Agent Reasoned</span>
        <span style={{ marginLeft: "auto", fontSize: "10px", color: T.faint }}>{open ? "▲" : "▼"}</span>
      </button>
      {open && <div style={{ padding: "0 14px 12px 14px", fontSize: "11px", color: T.muted, lineHeight: 1.7, fontStyle: "italic" }}>{trace}</div>}
    </div>
  );
}

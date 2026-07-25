// ─── Factory integration — the web side of shorts-factory ────────────────────
// shorts-factory (factory/ in this repo) is the local Python pipeline that
// turns raw footage into a finished 9:16 Short. This module is everything the
// The Pentagon needs to talk to it: a client for factory/bridge.py, a
// production rail for the Studio view, and the Send-to-Factory handoff.
//
// The bridge is local-only (127.0.0.1:8765). When it's up, Studio shows live
// project state and can approve drafts / receive briefs. When it's down —
// including on the deployed site with no bridge running — everything
// degrades to copy-paste handoffs instead of failing.
import { useCallback, useEffect, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { EmptyState, M, useToast } from "./ui.jsx";
import { T, syne, mono } from "./theme.js";

const BRIDGE = "http://127.0.0.1:8765";

// Palette — the one ZTS source (midnight + emerald), plus the two font consts
// this module references as F.syne / F.mono.
const F = { ...T, syne, mono };

async function bridgeFetch(path, opts = {}, timeoutMs = 2500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BRIDGE}${path}`, { ...opts, signal: ctrl.signal });
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// ─── useFactory — bridge status + project list, polled gently ────────────────
export function useFactory(active) {
  const [status, setStatus] = useState("checking"); // checking | online | offline
  const [projects, setProjects] = useState([]);
  const timerRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const health = await bridgeFetch("/health");
      if (!health?.ok) throw new Error("bad health");
      const list = await bridgeFetch("/projects");
      setProjects(Array.isArray(list) ? list : []);
      setStatus("online");
    } catch {
      setStatus("offline");
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    refresh();
    timerRef.current = setInterval(refresh, 15000);
    return () => clearInterval(timerRef.current);
  }, [active, refresh]);

  return { status, projects, refresh };
}

// ─── Send-to-Factory — brief handoff from a Studio Short ─────────────────────
// Bridge online → POST the brief (lands in factory/briefs/ as md+json).
// Bridge offline → the same brief goes to the clipboard, ready to paste.
export function briefFromShort(short) {
  return {
    // Provenance stamp only — nothing on the factory side reads or validates it,
    // so it tracks the current app name. Briefs written before the rename keep
    // their historical "zts-command-center" stamp, which is what provenance means.
    source: "the-pentagon",
    short_id: short.id,
    type: short.type || "angle",
    topic: short.topic || "",
    title: short.title || "",
    hook: short.hook || "",
    script: short.script || "",
    description: short.description || "",
    tags: short.tags || [],
    pinned_comment: short.pinned_comment || "",
  };
}

export function briefAsText(brief) {
  return [
    `PRODUCTION BRIEF — ${brief.title || brief.topic || "Short"}`,
    ``,
    `TYPE: ${brief.type}`,
    `HOOK: ${brief.hook}`,
    ``,
    `SCRIPT:`,
    brief.script,
    ``,
    `TITLE: ${brief.title}`,
    `DESCRIPTION: ${brief.description}`,
    `TAGS: ${(brief.tags || []).join(", ")}`,
    `PINNED COMMENT: ${brief.pinned_comment}`,
    ``,
    `NEXT: film it, then in factory/:`,
    `python -m pipeline.cli new "${brief.title || "short"}" --video <footage.mp4>`,
  ].join("\n");
}

export async function sendBriefToFactory(short, toast) {
  const brief = briefFromShort(short);
  try {
    const res = await bridgeFetch("/briefs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(brief),
    });
    if (res?.ok) {
      toast.push(`Brief delivered to the factory — ${res.path}. Film it, then run the CLI from the brief.`, { tone: "success", duration: 6000 });
      return { delivered: true, path: res.path };
    }
    throw new Error(res?.error || "bridge error");
  } catch {
    try {
      await navigator.clipboard.writeText(briefAsText(brief));
      toast.push("Factory bridge is offline — full production brief copied to your clipboard instead.", { tone: "warning", duration: 6000 });
    } catch {
      toast.push("Factory bridge is offline and the clipboard was blocked — open Studio on your machine with the bridge running.", { tone: "error" });
    }
    return { delivered: false };
  }
}

// ─── Minimal markdown → HTML for REVIEW docs ─────────────────────────────────
// The review docs are plain, well-formed markdown from a template we control;
// this covers exactly what they use (headings, bold, code, lists, tables kept
// as-is in a code block would be overkill — they don't use tables).
function mdToHtml(md) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const lines = esc(md).split("\n");
  const out = [];
  let inList = false;
  for (const line of lines) {
    const inline = (s) => s
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>");
    const li = line.match(/^\s*[-*]\s+(.*)/);
    const num = line.match(/^\s*\d+\.\s+(.*)/);
    if (li || num) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push(`<li>${inline((li || num)[1])}</li>`);
      continue;
    }
    if (inList) { out.push("</ul>"); inList = false; }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) { const n = h[1].length + 1; out.push(`<h${n}>${inline(h[2])}</h${n}>`); continue; }
    if (line.trim() === "") { out.push(""); continue; }
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push("</ul>");
  return out.join("\n");
}

// ─── ReviewModal — the factory's REVIEW_vN.md, rendered in-app ───────────────
function ReviewModal({ project, markdown, onClose, onApprove, approving }) {
  const approved = project.approved_version != null && project.approved_version === project.draft_version;
  return (
    <div onClick={(e) => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, background: "rgba(11,18,32,0.5)", zIndex: 300, display: "flex", alignItems: "center", justifyContent: "center", padding: "20px", animation: `fadein ${M.durFast} ease both` }}>
      <div style={{ background: F.card, borderRadius: "18px", width: "720px", maxWidth: "94vw", maxHeight: "86vh", display: "flex", flexDirection: "column", overflow: "hidden", boxShadow: "0 32px 80px rgba(11,17,32,0.24)" }}>
        <div style={{ padding: "16px 22px", borderBottom: `1px solid ${F.line}`, display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexShrink: 0 }}>
          <div>
            <div style={{ fontSize: "14px", fontWeight: 700, color: F.ink, fontFamily: F.syne }}>{project.title}</div>
            <div style={{ fontSize: "11px", color: F.faint, fontFamily: F.mono, marginTop: "2px" }}>draft v{project.draft_version}{approved ? " · approved" : ""}{project.has_final ? " · exported" : ""}</div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: F.faint, fontSize: "20px", cursor: "pointer", lineHeight: 1 }}>×</button>
        </div>
        <div className="factory-md" style={{ padding: "18px 24px", overflowY: "auto", fontSize: "13px", color: F.ink, lineHeight: 1.65 }}
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(mdToHtml(markdown)) }} />
        <div style={{ padding: "13px 22px", borderTop: `1px solid ${F.line}`, display: "flex", justifyContent: "flex-end", gap: "8px", flexShrink: 0 }}>
          {!approved && project.draft_version > 0 && (
            <button onClick={onApprove} disabled={approving} style={{ padding: "9px 18px", background: approving ? "rgba(255,255,255,0.06)" : F.greenGrad, border: "none", borderRadius: "9px", color: approving ? F.faint : F.accentInk, fontSize: "12px", fontWeight: 700, cursor: approving ? "default" : "pointer", fontFamily: F.syne }}>
              {approving ? "Approving…" : `✓ Approve draft v${project.draft_version}`}
            </button>
          )}
          {approved && !project.has_final && (
            <span style={{ fontSize: "11px", color: F.greenDeep, fontWeight: 600, alignSelf: "center" }}>Approved — export from the CLI: <code style={{ fontFamily: F.mono }}>python -m pipeline.cli export {project.name}</code></span>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── FactoryPanel — the production rail inside Studio ────────────────────────
export function FactoryPanel({ isMobile }) {
  const { status, projects, refresh } = useFactory(true);
  const [review, setReview] = useState(null); // { project, markdown }
  const [approving, setApproving] = useState(false);
  const toast = useToast();

  const openReview = async (p) => {
    try {
      const res = await bridgeFetch(`/projects/${encodeURIComponent(p.name)}/review`);
      if (res?.ok) setReview({ project: p, markdown: res.markdown });
      else toast.push(res?.error || "No review doc yet — run the pipeline first.", { tone: "warning" });
    } catch {
      toast.push("Bridge went away — is it still running?", { tone: "error" });
    }
  };

  const approve = async () => {
    if (!review) return;
    setApproving(true);
    try {
      const res = await bridgeFetch(`/projects/${encodeURIComponent(review.project.name)}/approve`, { method: "POST" });
      if (res?.ok) {
        toast.push(`Draft v${res.approved_version} approved — export when ready.`, { tone: "success" });
        setReview(null);
        refresh();
      } else {
        toast.push(res?.error || "Approve failed.", { tone: "error" });
      }
    } catch {
      toast.push("Bridge went away mid-approve — check it and retry.", { tone: "error" });
    }
    setApproving(false);
  };

  const stageOf = (p) => {
    if (p.has_final) return { label: "Exported", color: F.purple };
    if (p.approved_version != null && p.approved_version === p.draft_version && p.draft_version > 0) return { label: "Approved", color: F.green };
    if (p.has_review) return { label: `Draft v${p.draft_version} — review`, color: F.amber };
    return { label: "In pipeline", color: F.faint };
  };

  return (
    <div style={{ marginTop: "26px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "9px", marginBottom: "12px" }}>
        <span style={{ width: "7px", height: "7px", borderRadius: "50%", background: status === "online" ? F.green : status === "checking" ? F.amber : F.faint, animation: status === "online" ? "pulse 2.5s infinite" : "none" }} />
        <span style={{ fontSize: "11px", fontWeight: 700, color: F.sub, textTransform: "uppercase", letterSpacing: "0.13em", fontFamily: F.syne }}>Factory — production</span>
        <span style={{ fontSize: "10px", color: F.faint, fontFamily: F.mono }}>
          {status === "online" ? `bridge connected · ${projects.length} project${projects.length !== 1 ? "s" : ""}` : status === "checking" ? "looking for the bridge…" : "bridge offline"}
        </span>
        {status === "online" && <button onClick={refresh} style={{ marginLeft: "auto", background: "none", border: "none", color: F.faint, fontSize: "11px", cursor: "pointer", fontWeight: 600 }}>↻</button>}
      </div>

      {status === "offline" && (
        <div style={{ background: F.card, border: `1px dashed rgba(255,255,255,0.12)`, borderRadius: "14px", padding: "16px 18px", display: "flex", gap: "14px", alignItems: "flex-start", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: "240px" }}>
            <div style={{ fontSize: "12.5px", fontWeight: 700, color: F.ink, fontFamily: F.syne, marginBottom: "4px" }}>Footage-to-Short pipeline, on your machine</div>
            <div style={{ fontSize: "11.5px", color: F.sub, lineHeight: 1.6 }}>
              shorts-factory lives in this repo under <code style={{ fontFamily: F.mono, background: F.subtle, padding: "1px 5px", borderRadius: "4px" }}>factory/</code> — it transcribes your raw footage, picks the best clip, cuts dead air, adds captions and pop-ups, and enforces a review gate before export. Start the bridge and this panel comes alive with your projects.
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "6px", minWidth: "220px" }}>
            <code style={{ fontFamily: F.mono, fontSize: "11px", background: "#0B1120", color: "#7DE3B8", padding: "8px 12px", borderRadius: "8px", whiteSpace: "nowrap" }}>cd factory && python bridge.py</code>
            <button onClick={() => { navigator.clipboard.writeText("cd factory && python bridge.py").then(() => toast.push("Command copied.", { tone: "success" })).catch(() => toast.push("Clipboard blocked — copy it manually.", { tone: "warning" })); }}
              style={{ alignSelf: "flex-end", background: "none", border: "none", color: F.greenDeep, fontSize: "10px", fontWeight: 700, cursor: "pointer", fontFamily: F.syne }}>copy</button>
          </div>
        </div>
      )}

      {status === "online" && projects.length === 0 && (
        <EmptyState compact icon="film" tint={F.green} title="Bridge connected — no projects yet"
          sub={'Film something, then: python -m pipeline.cli new "my short" --video footage.mp4'} />
      )}

      {status === "online" && projects.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "repeat(auto-fill, minmax(230px, 1fr))", gap: "10px" }}>
          {projects.map((p, idx) => {
            const st = stageOf(p);
            return (
              <div key={p.name} onClick={() => p.has_review && openReview(p)} style={{
                background: F.card, border: `1px solid ${F.line}`, borderLeft: `3px solid ${st.color}`,
                borderRadius: "12px", padding: "12px 14px", cursor: p.has_review ? "pointer" : "default",
                animation: `cardIn 0.3s ${M.easeOut} both`, animationDelay: `${Math.min(idx, 8) * 30}ms`,
              }}>
                <div style={{ fontSize: "12px", fontWeight: 700, color: F.ink, fontFamily: F.syne, textTransform: "capitalize" }}>{p.title}</div>
                <div style={{ display: "flex", alignItems: "center", gap: "6px", marginTop: "5px", flexWrap: "wrap" }}>
                  <span style={{ fontSize: "9px", fontWeight: 700, color: st.color, background: st.color + "15", padding: "1px 7px", borderRadius: "5px", fontFamily: F.syne, textTransform: "uppercase", letterSpacing: "0.04em" }}>{st.label}</span>
                  {p.duration != null && <span style={{ fontSize: "10px", color: F.faint, fontFamily: F.mono }}>{Math.round(p.duration)}s raw</span>}
                </div>
                {p.has_review && <div style={{ fontSize: "10px", color: F.greenDeep, fontWeight: 600, marginTop: "7px" }}>Open review →</div>}
              </div>
            );
          })}
        </div>
      )}

      {review && <ReviewModal project={review.project} markdown={review.markdown} onClose={() => setReview(null)} onApprove={approve} approving={approving} />}
      <style>{`.factory-md h2, .factory-md h3, .factory-md h4, .factory-md h5 { font-family: 'Syne', system-ui; margin: 16px 0 6px; } .factory-md code { font-family: 'DM Mono', monospace; background: rgba(255,255,255,0.08); padding: 1px 5px; border-radius: 4px; font-size: 12px; } .factory-md ul { margin: 4px 0 10px; padding-left: 20px; } .factory-md p { margin: 4px 0; }`}</style>
    </div>
  );
}

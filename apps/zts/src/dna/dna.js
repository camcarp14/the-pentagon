// ════════════════════════════════════════════════════════════════════════════
// ZTS DNA — the genome layer for the Zero To Secure module of The Pentagon.
//
// Nodes are aspects of the marketing mind (identity, principles, knowledge,
// signals, skills, goals); edges are weighted synapses. The graph is FUNCTIONAL:
// compileGenome() deterministically turns it into the system prompt the built-in
// DNA worker runs on, and propagate() computes the activation wave the canvas
// animates. Persistence is `sm` (localStorage, the same `zts_` namespace the app
// already uses) — zero new infrastructure. The seed genome is DATA, not code, so
// ZTS's doctrine can be reshaped from the UI without touching this file's logic.
//
// Ported from Clarify's src/lib/dna.js, keeping the EXACT public API, then
// re-seeded + recolored for ZTS's actual domain (creator outreach + Shorts +
// SEO). It is SELF-CONTAINED: it imports nothing from App.jsx (which exports
// nothing) — the tiny `sm` primitive is re-declared here against the identical
// `zts_` localStorage namespace so genome state is shared with the running app.
// ZTS is a SINGLE mind: one genome, no multi-client registry.
// ════════════════════════════════════════════════════════════════════════════

// ─── sm — localStorage store, re-declared to match App.jsx lines 34-39 exactly.
// Same `zts_` prefix ⇒ the genome lives in the same namespace as the app's
// engine_ctrl / agent_kb / obs_log. NOT imported from App.jsx (nothing exported
// there); the DNA worker + view re-declare the identical shape for the same reason.
const sm = {
  get: (k) => { try { return JSON.parse(localStorage.getItem(`zts_${k}`)); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(`zts_${k}`, JSON.stringify(v)); } catch {} },
  del: (k) => { try { localStorage.removeItem(`zts_${k}`); } catch {} },
  keys: (prefix) => { const out = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(`zts_${prefix}`)) out.push(k.replace(`zts_${prefix}`, "")); } return out; },
};

// The genome's sm key. `sm` prepends "zts_", so the effective localStorage key is
// literally "zts_dna_genome" — the one and only ZTS mind. (Pass this to sm.*, not
// to raw localStorage, or the prefix would double.)
export const GENOME_KEY = "dna_genome";

// ─── the region vocabulary — LIGHT palette, AA-legible on the ZTS white canvas.
// Every consumer (canvas, view, worker) reads REGIONS[x].color, so this single
// map is the source of truth for hue. Mirrors the dark reference's structure but
// hues brightened for the dark midnight canvas (same families, so meaning holds).
export const REGIONS = {
  identity:  { label: "Identity",   color: "#2DD4A7", desc: "Who Zero To Secure is" },
  principle: { label: "Principles", color: "#A78BFA", desc: "Rules that govern every action" },
  knowledge: { label: "Knowledge",  color: "#6EA8FE", desc: "What it knows about the machine" },
  signal:    { label: "Signals",    color: "#E3B341", desc: "Inputs it weighs when deciding" },
  skill:     { label: "Skills",     color: "#3ECF8E", desc: "Actions it can take" },
  goal:      { label: "Goals",      color: "#F472B6", desc: "What it is driving toward" },
};

// Compile order is MEANING, not alphabet: who you are → what you must never do
// → what you want → what you're seeing → what you know → what you can do.
// ZTS_GOVERNANCE always precedes all of it (prepended verbatim in compileGenome).
export const REGION_ORDER = ["identity", "principle", "goal", "signal", "knowledge", "skill"];

// ─── ZTS_GOVERNANCE — the locked operating charter. Clarify imports GOVERNANCE_RULES
// from prompts.js; ZTS has no such export, so the doctrine is defined here and
// leads compileGenome()'s systemPrompt VERBATIM — no weight slider can ever
// out-rank the approval spine or the brand-trust bar. Distilled from the App's
// heuristic agents (published-beats-perfect, cadence, niche-fit, Haiku-first) and
// the human-approval / draft-into-review discipline that spans the whole app.
export const ZTS_GOVERNANCE = `ZERO TO SECURE — OPERATING CHARTER (non-negotiable; this overrides everything below):
- You are an ADVISORY tool for a human operator, not an autonomous publisher. You draft; a person decides.
- Every output lands in a review queue as a draft. A human approves every publish, send, or schedule — there is no code path that publishes an article, posts a Short, or contacts a creator on its own.
- Never auto-publish and never spam. Volume without a human's yes damages the brand more than a slow week ever could.
- Cite the signal behind every claim — the creator, the metric, the pipeline state it came from. If you cannot cite it, say so and lower your confidence rather than assert it.
- Run Haiku-first and respect the hourly cost cap. Spend tokens only where a free heuristic cannot do the job, and log every paid call.
- "Published beats perfect" governs CADENCE, not quality: ship steadily, but accuracy and craft protect brand trust — a wrong self-custody claim is worse than a missed post.
- Niche fit beats raw reach. A small, on-topic self-custody audience outranks a large off-topic one in every recommendation you make.`;


// ─── small pure helpers ───────────────────────────────────────────────────────
const clamp01 = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0; };

// ONE truthiness rule for `enabled`, everywhere: a node is awake unless it is
// EXPLICITLY disabled. Hand-authored/imported genomes may omit the field — the
// worker, canvas, and inspector all read `!== false`, and the compiler,
// propagator, seedsForTask and stats below MUST agree, or an imported mind
// renders fully awake while compiling to nothing. Exported so the canvas/view
// share the exact same convention (spec §2/§4).
export const isAwake = (n) => !!n && n.enabled !== false;

// djb2 — the classic Bernstein hash, kept in 32-bit int math and rendered as
// unsigned hex. Tiny, dependency-free, stable across sessions/browsers — all the
// "mind hash" needs to be.
function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (((h << 5) + h) + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

// Deterministic 0..1 "jitter" from the node id — the seed layout looks organic
// but two seedGenome() calls are structurally identical (resetting the genome
// doesn't reshuffle the map under you).
const jitter = (id, salt) => (parseInt(djb2(salt + id), 16) % 997) / 997;

let mutSeq = 0; // uniqueness within a single millisecond of rapid edits
const newId = (prefix) => `${prefix}_${Date.now().toString(36)}${(mutSeq++).toString(36)}`;

const slugify = (label) => String(label || "node").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 24) || "node";


// ─── seed layout — hexagonal region arrangement ──────────────────────────────
// Identity sits at the center (everything radiates from who ZTS is); the other
// five regions ring it at radius ~320, principles crowning the top. Nodes fan
// around their region anchor with deterministic jitter so the first paint
// already reads as a living thing, before physics ever runs.
const RING_R = 320;
const SPREAD_R = 92;
const RING_DEG = { principle: -90, knowledge: -18, signal: 54, skill: 126, goal: 198 };

function seedPosition(region, index, count, id) {
  const a = region === "identity" ? { x: 0, y: 0 }
    : { x: Math.cos((RING_DEG[region] * Math.PI) / 180) * RING_R, y: Math.sin((RING_DEG[region] * Math.PI) / 180) * RING_R };
  const deg = -90 + (index * 360) / count + (jitter(id, "a") - 0.5) * 26;
  const r = SPREAD_R * (0.72 + jitter(id, "r") * 0.55);
  return {
    x: Math.round(a.x + Math.cos((deg * Math.PI) / 180) * r),
    y: Math.round(a.y + Math.sin((deg * Math.PI) / 180) * r),
  };
}


// ─── the seed genome — ZTS's actual mind, mined from App.jsx ──────────────────
// Every text is a real directive. Identity = who ZTS is + the craft bar;
// principles = the LOCKED spine (cadence, niche-fit, human approval, no auto-
// publish, Haiku-first, replies-first); knowledge = the value model (nicheFit /
// creatorValue) + the heuristic-agent playbook; signals = the exact triggers the
// HEURISTIC_AGENTS watch; skills = the seams the DNA worker actually drives, each
// carrying its {model, maxTokens} default; goals = the four pillars the machine
// pushes toward. All six principles are LOCKED — the approval spine and brand-
// trust bar cannot be edited or silenced away.
const seedN = (id, label, weight, text, extra = {}) => ({ id, label, weight, text, ...extra });

// Haiku-first cost discipline: every skill defaults to Haiku except the long-form
// SEO article, where accuracy + ranking justify Sonnet. Sonnet id is the pinned
// "claude-sonnet-4-6"; Haiku is "claude-haiku-4-5-20251001" (App.jsx MODEL_PRICING).
const HAIKU = "claude-haiku-4-5-20251001";
const SONNET = "claude-sonnet-4-6";

const SEED_NODES = {
  identity: [
    seedN("n_id_brand", "Zero To Secure", 0.9,
      "Zero To Secure is a Bitcoin self-custody education brand. Everything published teaches ordinary people to hold their own keys safely — hardware wallets, seed-phrase hygiene, cold storage, privacy. That mission decides what is on-brand and what is noise."),
    seedN("n_id_center", "Content command center", 0.8,
      "This is the content-marketing command center, not the product. You run the machine that grows the audience — creators, Shorts, and SEO articles — you do not touch the education product itself or its customers."),
    seedN("n_id_voice", "Secure-green craft voice", 0.75,
      "Ship in the ZTS voice: calm, precise, secure-green / navy / amber craft. Plain language, concrete steps, no hype and no fear-mongering. If a draft reads like generic crypto hype, it is not done."),
    seedN("n_id_ship", "Published beats perfect", 0.8,
      "Published beats perfect. A steady stream of good-enough content compounds; a flawless piece that never ships is worth nothing. Bias toward drafting and moving work into review over endless polishing."),
  ],
  principle: [
    seedN("n_pr_cadence", "Ship on cadence", 0.9,
      "Ship on a steady cadence — the algorithm rewards consistency far more than any single viral swing. A Short every few days beats five in one week then silence. Protect the streak above chasing a home run.", { locked: true }),
    seedN("n_pr_niche", "Niche fit over raw reach", 0.95,
      "Niche fit beats raw reach. A 50k self-custody channel is worth more to ZTS than a 500k general-tech one. Weight every creator by relevance to Bitcoin self-custody before subscriber count, always.", { locked: true }),
    seedN("n_pr_review", "Drafts land in review", 1.0,
      "Every output is a draft that lands in a human review queue. A person approves each publish, send, or schedule — no exceptions and no code path around the queue.", { locked: true }),
    seedN("n_pr_no_publish", "Never auto-publish or spam", 1.0,
      "Never auto-publish, auto-post, or auto-send, and never spam. Do not move a Short to posted, an article to published, or a creator past contacted on your own. Every send is a human decision.", { locked: true }),
    seedN("n_pr_cost", "Haiku-first cost discipline", 0.8,
      "Run Haiku-first and respect the hourly cost cap. Use free heuristics wherever they suffice; spend tokens only when generation genuinely needs a model, and log every paid call so Ops sees the bill.", { locked: true }),
    seedN("n_pr_reply", "Warm replies first", 0.9,
      "Respond to warm creator replies before anything else. Collab interest goes cold fast — a waiting reply outranks drafting new content or scouting new prospects.", { locked: true }),
  ],
  knowledge: [
    seedN("n_kn_fit", "Niche-fit weights", 0.8,
      "Niche-fit weights, highest to lowest: self-custody 1.0, bitcoin 0.9, crypto 0.6, tech/security 0.5, finance 0.4, general 0.25. Match a creator's channel, niche, and description text against these to score relevance."),
    seedN("n_kn_tiers", "Creator tiering", 0.75,
      "Creator value = subscribers × niche-fit weight × engagement multiplier, bucketed into tiers: Prime ≥40k, Strong ≥12k, Fit ≥3k, else Light. Work Prime and Strong first — they convert best for ZTS."),
    seedN("n_kn_typemix", "Shorts type-mix signal", 0.65,
      "The mix of Short types posted is a learnable conversion signal. Track which types actually drive ZTS clicks and self-custody sign-ups, and lean production toward those — not toward whatever is easiest to make."),
    seedN("n_kn_seo", "SEO cadence compounds", 0.7,
      "SEO cadence compounds: steady article publishing builds domain authority and long-tail rankings over months. One article a week beats a burst then a drought. Target self-custody keywords a real beginner would search."),
    seedN("n_kn_engagement", "Engagement over vanity subs", 0.7,
      "Engagement-weighted reach beats vanity subscriber counts. A smaller channel with high engagement in the right niche delivers more qualified attention than a large, passive, off-topic one."),
    seedN("n_kn_hook", "Hook in first 2 seconds", 0.65,
      "Shorts live or die in the first two seconds. Open on the payoff or a sharp question — no logo intros, no slow build. The hook decides retention, and retention decides reach."),
  ],
  signal: [
    seedN("n_sg_fit", "Creator fit score / tier", 0.85,
      "A creator's fit score and tier (Prime / Strong / Fit / Light) is the primary input for outreach priority. High-tier, un-contacted creators are the warmest opportunities on the board — surface them first."),
    seedN("n_sg_stage", "Pipeline stage", 0.7,
      "Each creator moves prospected → contacted → replied → collab. Read where a creator sits before acting: a prospected Prime needs a pitch, a replied creator needs a human response, a collab is already won."),
    seedN("n_sg_gap", "Posting-cadence gap", 0.8,
      "Days since the last Short went live is the cadence alarm. Three-plus days dark means the streak is slipping and the algorithm is cooling — flag it and prioritize shipping something already ready."),
    seedN("n_sg_replies", "Creator replies waiting", 0.9,
      "Creator replies waiting on a response are the hottest signal in the pipeline. Warm collab interest decays by the hour — this outranks every other queue."),
    seedN("n_sg_backlog", "Article review backlog", 0.6,
      "Articles piling up in the review queue stall the whole SEO cadence. A growing backlog means a human needs to approve or reject — do not add more drafts on top of an unreviewed pile."),
    seedN("n_sg_wip", "Shorts WIP pileup", 0.65,
      "Watch two Shorts bottlenecks: pieces stuck mid-production (script / assets) and finished Shorts that are ready but unscheduled. Ready-not-scheduled is wasted work — get them on the calendar."),
  ],
  skill: [
    seedN("n_sk_short", "Draft a Short package", 0.8,
      "Draft a complete Short package: a hook that lands in the first two seconds, a tight script, and a caption — all in the ZTS voice. Output is a draft for human review; never schedule or post it.",
      { model: HAIKU, maxTokens: 800 }),
    seedN("n_sk_article", "Draft an SEO article", 0.75,
      "Draft a full SEO article targeting an uncovered self-custody keyword a beginner would actually search. Accurate, structured, on-voice. It lands in the review queue as a draft — a human approves every publish.",
      { model: SONNET, maxTokens: 1600 }),
    seedN("n_sk_pitch", "Draft an outreach pitch", 0.75,
      "Write a personal outreach pitch to a specific creator, grounded in something true about their channel and why ZTS fits their audience. Short, warm, specific, one soft ask. A draft for human send — never auto-sent.",
      { model: HAIKU, maxTokens: 500 }),
    seedN("n_sk_scout", "Scout & rank creators", 0.7,
      "Scan prospected creators, score them by value (subs × fit × engagement), and surface the top Prime and Strong targets. This is heuristic and free — rank and recommend; do not spend tokens unless a pitch is being drafted.",
      { model: HAIKU, maxTokens: 300 }),
    seedN("n_sk_strategy", "Daily strategy brief", 0.7,
      "Compile the pipeline's real state across creators, Shorts, and articles into the single highest-leverage move right now. One or two specific sentences — a recommendation for the operator, not a menu of options.",
      { model: HAIKU, maxTokens: 300 }),
    seedN("n_sk_grow", "Grow the mind", 0.5,
      "Scan the learnings the agents have logged and propose new knowledge nodes for this genome — the mind rewires itself from what actually worked. Propose only; a human wires them in.",
      { model: HAIKU, maxTokens: 400 }),
  ],
  goal: [
    seedN("n_gl_pipeline", "Grow creator pipeline", 0.85,
      "Grow a qualified creator pipeline: more Prime and Strong self-custody creators moving from prospected to collab. Every outreach action should shorten the path to a real collaboration."),
    seedN("n_gl_cadence", "Ship Shorts on cadence", 0.85,
      "Keep Shorts shipping on a steady, unbroken cadence. Consistency is the growth engine — never let the posting streak go dark."),
    seedN("n_gl_seo", "Rank self-custody SEO", 0.75,
      "Rank ZTS articles for the self-custody keywords beginners search. Compounding organic search is the durable acquisition channel — build it article by article."),
    seedN("n_gl_brand", "Protect brand trust", 0.9,
      "Protect brand trust above all: accuracy, no hype, no fear-mongering. One wrong self-custody claim or spammy send costs more than ten pieces never shipped. ZTS's name only rides on work that clears the bar."),
  ],
};

// Synapses. Excitatory (+1) wiring: goals prime signals, signals + knowledge
// drive skills, skills feed back into goals. Inhibitory (−1) wiring is where the
// character lives: the LOCKED principles and brand-protection TEMPER the action
// skills — these compile into the INTERNAL TENSIONS block, and in propagate()
// they dampen the very skills the signals are exciting (e.g. "never auto-publish"
// ⊣ "draft an article"; "niche fit over reach" ⊣ "scout creators").
const seedE = (from, to, weight, polarity = 1) => ({ id: `e_${from.slice(2)}_${to.slice(2)}`, from, to, weight, polarity });

const SEED_EDGES = [
  // signals → skills (what it sees drives what it does)
  seedE("n_sg_fit", "n_sk_scout", 0.9),
  seedE("n_sg_fit", "n_sk_pitch", 0.8),
  seedE("n_sg_stage", "n_sk_pitch", 0.7),
  seedE("n_sg_stage", "n_sk_scout", 0.5),
  seedE("n_sg_gap", "n_sk_short", 0.9),
  seedE("n_sg_gap", "n_sk_strategy", 0.4),
  seedE("n_sg_replies", "n_sk_pitch", 0.85),
  seedE("n_sg_replies", "n_sk_strategy", 0.4),
  seedE("n_sg_backlog", "n_sk_strategy", 0.5),
  seedE("n_sg_wip", "n_sk_short", 0.6),
  seedE("n_sg_wip", "n_sk_strategy", 0.4),
  // knowledge → skills (the playbook informs the acts)
  seedE("n_kn_fit", "n_sk_scout", 0.75),
  seedE("n_kn_fit", "n_sk_pitch", 0.5),
  seedE("n_kn_tiers", "n_sk_scout", 0.7),
  seedE("n_kn_tiers", "n_sk_strategy", 0.5),
  seedE("n_kn_typemix", "n_sk_short", 0.65),
  seedE("n_kn_typemix", "n_sk_grow", 0.5),
  seedE("n_kn_seo", "n_sk_article", 0.7),
  seedE("n_kn_seo", "n_sk_strategy", 0.45),
  seedE("n_kn_engagement", "n_sk_scout", 0.55),
  seedE("n_kn_hook", "n_sk_short", 0.7),
  // goals → signals (what it wants primes what it watches)
  seedE("n_gl_pipeline", "n_sg_fit", 0.8),
  seedE("n_gl_pipeline", "n_sg_stage", 0.6),
  seedE("n_gl_pipeline", "n_sg_replies", 0.7),
  seedE("n_gl_cadence", "n_sg_gap", 0.85),
  seedE("n_gl_cadence", "n_sg_wip", 0.6),
  seedE("n_gl_seo", "n_sg_backlog", 0.7),
  seedE("n_gl_brand", "n_sg_replies", 0.5),
  // skills → goals + skill chaining (acting moves the mission)
  seedE("n_sk_short", "n_gl_cadence", 0.75),
  seedE("n_sk_article", "n_gl_seo", 0.75),
  seedE("n_sk_pitch", "n_gl_pipeline", 0.7),
  seedE("n_sk_scout", "n_gl_pipeline", 0.6),
  seedE("n_sk_strategy", "n_gl_cadence", 0.4),
  seedE("n_sk_strategy", "n_gl_pipeline", 0.4),
  seedE("n_sk_scout", "n_sk_pitch", 0.55),
  seedE("n_sk_grow", "n_kn_typemix", 0.5),
  // identity → everything, lightly (tone + mission soak into all of it)
  seedE("n_id_voice", "n_sk_short", 0.45),
  seedE("n_id_voice", "n_sk_article", 0.4),
  seedE("n_id_voice", "n_sk_pitch", 0.4),
  seedE("n_id_brand", "n_gl_brand", 0.4),
  seedE("n_id_ship", "n_gl_cadence", 0.45),
  seedE("n_id_center", "n_sk_strategy", 0.4),
  seedE("n_id_brand", "n_sg_fit", 0.3),
  // a couple of principles that DRIVE (not just temper) the doing
  seedE("n_pr_cadence", "n_sk_short", 0.55),
  seedE("n_pr_niche", "n_sk_pitch", 0.4),
  // principles ⊣ skills — governance tempers the doing (the character gate)
  seedE("n_pr_review", "n_sk_article", 0.85, -1),
  seedE("n_pr_review", "n_sk_short", 0.8, -1),
  seedE("n_pr_no_publish", "n_sk_short", 0.85, -1),
  seedE("n_pr_no_publish", "n_sk_article", 0.8, -1),
  seedE("n_pr_no_publish", "n_sk_pitch", 0.75, -1),
  seedE("n_pr_niche", "n_sk_scout", 0.7, -1),
  seedE("n_pr_cost", "n_sk_strategy", 0.55, -1),
  seedE("n_pr_cost", "n_sk_grow", 0.5, -1),
  seedE("n_pr_reply", "n_sk_short", 0.6, -1),
  // brand protection ⊣ volume skills (the taste gate)
  seedE("n_gl_brand", "n_sk_article", 0.55, -1),
  seedE("n_gl_brand", "n_sk_short", 0.6, -1),
];


export function seedGenome() {
  const now = new Date().toISOString();
  const nodes = [];
  Object.entries(SEED_NODES).forEach(([region, defs]) => {
    defs.forEach((d, i) => {
      const pos = seedPosition(region, i, defs.length, d.id);
      const node = {
        id: d.id, label: d.label, region, weight: d.weight,
        enabled: true, locked: !!d.locked, text: d.text,
        x: pos.x, y: pos.y, source: "seed", created_at: now,
      };
      // Skill nodes carry the per-task {model, maxTokens} (+ optional effort) the
      // worker reads when it turns a skill into a real callClaude(). These fields
      // never touch compileGenome (which reads only text/weight/region/enabled),
      // so they cannot perturb the deterministic hash.
      if (d.model) node.model = d.model;
      if (d.maxTokens != null) node.maxTokens = d.maxTokens;
      if (d.effort) node.effort = d.effort;
      nodes.push(node);
    });
  });
  return {
    version: 1,
    genome_key: "zts_core",
    updated_at: now,
    nodes,
    edges: SEED_EDGES.map(e => ({ ...e })),
    mutations: [],
  };
}


// ─── persistence ─────────────────────────────────────────────────────────────
export function loadGenome() {
  const stored = sm.get(GENOME_KEY);
  if (stored && stored.version === 1 && validateGenome(stored).ok) return stored;
  return saveGenome(seedGenome()); // missing or corrupt → re-seed (never render a broken mind)
}

export function saveGenome(genome) {
  genome.updated_at = new Date().toISOString();
  sm.set(GENOME_KEY, genome);
  dnaBus.emit({ type: "genome", genome }); // every save announces itself — the view and canvas stay live
  return genome;
}

export function resetGenome() {
  return saveGenome(recordMutation(seedGenome(), "reset", "Genome reset to seed"));
}


// ─── mutation history ─────────────────────────────────────────────────────────
// Mutates the PASSED genome's `mutations` field (reassigns a fresh array, so a
// prior genome snapshot sharing the old array is never touched) and returns it.
// CRUD below always calls this on the freshly-copied genome, which is how the
// "pure-ish" contract holds: callers' original objects stay intact.
export function recordMutation(genome, kind, summary) {
  const entry = { id: newId("mut"), ts: new Date().toISOString(), kind, summary };
  genome.mutations = [entry, ...(genome.mutations || [])].slice(0, 200);
  return genome;
}


// ─── CRUD — take genome, return NEW genome; refusals return the SAME reference
//     so callers can cheaply detect a no-op (nextGenome === genome). ──────────
export function addNode(genome, { label, region, text, weight = 0.6, x = 0, y = 0, source = "user" }) {
  const reg = REGIONS[region] ? region : "knowledge"; // unknown region → knowledge, the least presumptuous home
  const base = `n_${slugify(label)}`;
  let id = base, n = 2;
  while (genome.nodes.some(nd => nd.id === id)) id = `${base}_${n++}`;
  const node = {
    id, label: String(label || "New node").slice(0, 28), region: reg, weight: clamp01(weight),
    enabled: true, locked: false, text: String(text || "").slice(0, MAX_NODE_TEXT), x, y, source,
    created_at: new Date().toISOString(),
  };
  const next = recordMutation(
    { ...genome, nodes: [...genome.nodes, node] },
    "add_node", `Grew "${node.label}" in ${REGIONS[reg].label}${source === "learned" ? " (learned)" : ""}`
  );
  return { genome: next, node };
}

export function updateNode(genome, id, patch) {
  const node = genome.nodes.find(n => n.id === id);
  if (!node) return genome;
  const p = { ...patch };
  if (node.locked) { // governance armor: a locked node cannot be disabled or unlocked
    if (p.enabled === false) delete p.enabled;
    if (p.locked === false) delete p.locked;
  }
  if (p.weight !== undefined) p.weight = clamp01(p.weight);
  if (p.label !== undefined) p.label = String(p.label).slice(0, 28);
  // Clamped to the bound validateGenome enforces: a longer directive saved here
  // would fail validation on the NEXT loadGenome, and that path re-seeds — one
  // oversized paste into the inspector would silently destroy the whole mind.
  if (p.text !== undefined) p.text = String(p.text).slice(0, MAX_NODE_TEXT);
  if (Object.keys(p).length === 0) return genome;
  const next = { ...genome, nodes: genome.nodes.map(n => (n.id === id ? { ...n, ...p } : n)) };
  // Position-only patches are layout, not thought — the canvas writes x,y on
  // every drag end and that must not flood the mutation history.
  if (Object.keys(p).every(k => k === "x" || k === "y")) return next;
  let summary;
  if (p.weight !== undefined && p.weight !== node.weight) {
    summary = `${p.weight > node.weight ? "Strengthened" : "Weakened"} "${node.label}" ${node.weight.toFixed(2)} → ${p.weight.toFixed(2)}`;
  } else if (p.enabled === false && isAwake(node)) summary = `Silenced "${node.label}"`;
  else if (p.enabled === true && !isAwake(node)) summary = `Awakened "${node.label}"`;
  else summary = `Rewrote "${p.label || node.label}"`;
  return recordMutation(next, "update_node", summary);
}

export function removeNode(genome, id) {
  const node = genome.nodes.find(n => n.id === id);
  if (!node || node.locked) return genome; // locked = load-bearing; deletion refused
  const cut = genome.edges.filter(e => e.from === id || e.to === id).length;
  const next = {
    ...genome,
    nodes: genome.nodes.filter(n => n.id !== id),
    edges: genome.edges.filter(e => e.from !== id && e.to !== id), // cascade — no dangling synapses, ever
  };
  return recordMutation(next, "remove_node", `Removed "${node.label}"${cut ? ` and ${cut} synapse${cut !== 1 ? "s" : ""}` : ""}`);
}

const nodeLabel = (genome, id) => genome.nodes.find(n => n.id === id)?.label || id;

export function addEdge(genome, { from, to, weight = 0.6, polarity = 1 }) {
  if (!from || !to || from === to) return genome;                        // no self-loops
  if (!genome.nodes.some(n => n.id === from) || !genome.nodes.some(n => n.id === to)) return genome; // no dangling
  if (genome.edges.some(e => e.from === from && e.to === to)) return genome; // one synapse per direction pair
  const base = `e_${from.replace(/^n_/, "")}_${to.replace(/^n_/, "")}`;
  let id = base, n = 2;
  while (genome.edges.some(e => e.id === id)) id = `${base}_${n++}`;
  const pol = polarity === -1 ? -1 : 1;
  const edge = { id, from, to, weight: clamp01(weight), polarity: pol };
  return recordMutation(
    { ...genome, edges: [...genome.edges, edge] },
    "add_edge", `Wired "${nodeLabel(genome, from)}" ${pol === -1 ? "⊣" : "→"} "${nodeLabel(genome, to)}" at ${edge.weight.toFixed(2)}`
  );
}

export function updateEdge(genome, id, patch) {
  const edge = genome.edges.find(e => e.id === id);
  if (!edge) return genome;
  const p = { ...patch };
  delete p.from; delete p.to; // rewiring endpoints is remove+add, not a patch — keeps dupe/self-loop guards honest
  if (p.weight !== undefined) p.weight = clamp01(p.weight);
  if (p.polarity !== undefined) p.polarity = p.polarity === -1 ? -1 : 1;
  if (Object.keys(p).length === 0) return genome;
  const next = { ...genome, edges: genome.edges.map(e => (e.id === id ? { ...e, ...p } : e)) };
  const pair = `"${nodeLabel(genome, edge.from)}" → "${nodeLabel(genome, edge.to)}"`;
  const summary = p.polarity !== undefined && p.polarity !== edge.polarity
    ? `Flipped ${pair} to ${p.polarity === -1 ? "tempering" : "excitatory"}`
    : `Retuned ${pair} ${edge.weight.toFixed(2)} → ${(p.weight !== undefined ? p.weight : edge.weight).toFixed(2)}`;
  return recordMutation(next, "update_edge", summary);
}

export function removeEdge(genome, id) {
  const edge = genome.edges.find(e => e.id === id);
  if (!edge) return genome;
  return recordMutation(
    { ...genome, edges: genome.edges.filter(e => e.id !== id) },
    "remove_edge", `Cut synapse "${nodeLabel(genome, edge.from)}" → "${nodeLabel(genome, edge.to)}"`
  );
}


// ─── validation — guards imports and self-inflicted corruption ───────────────
// Rejects: non-array nodes/edges, non-object/scalar entries, missing/duplicate
// ids, unknown regions, out-of-range weights, missing labels, dangling edge
// endpoints, self-loops, duplicate from→to synapses, and bad polarity. Entry
// guards run first so garbage returns {ok:false} instead of throwing — loadGenome's
// re-seed path and the view's import toast both depend on that.
//
// Skill execution fields are validated here too, because import is the ONLY path
// that reaches them without the inspector: the worker puts node.model and
// node.maxTokens straight into the Anthropic request body, and the inspector's
// own allowlist/64..4000 clamp is UI-only, so a shared genome JSON could pin a
// skill to any model id and any token budget. Bounds match the inspector exactly.
// The text bound is deliberately generous — validateGenome also gates loadGenome,
// where a false positive re-seeds and throws away the operator's real mind, so it
// only catches a runaway payload, not a long hand-written directive. addNode and
// updateNode clamp text to the same bound for that reason: locally-authored nodes
// must never be able to save something the next load would reject and re-seed over.
const ALLOWED_MODELS = [HAIKU, SONNET];
export const MAX_NODE_TEXT = 8000;

export function validateGenome(g) {
  const errors = [];
  if (!g || typeof g !== "object") return { ok: false, errors: ["genome is not an object"] };
  if (!Array.isArray(g.nodes)) errors.push("nodes is not an array");
  if (!Array.isArray(g.edges)) errors.push("edges is not an array");
  if (errors.length) return { ok: false, errors };
  const ids = new Set();
  g.nodes.forEach(n => {
    if (!n || typeof n !== "object") { errors.push("node is not an object"); return; }
    if (!n.id || typeof n.id !== "string") errors.push("node with missing id");
    else if (ids.has(n.id)) errors.push(`duplicate node id ${n.id}`);
    else ids.add(n.id);
    if (!REGIONS[n.region]) errors.push(`node ${n.id}: unknown region "${n.region}"`);
    if (typeof n.weight !== "number" || !Number.isFinite(n.weight) || n.weight < 0 || n.weight > 1) errors.push(`node ${n.id}: weight out of 0..1`);
    if (typeof n.label !== "string" || !n.label) errors.push(`node ${n.id}: missing label`);
    if (n.text !== undefined && (typeof n.text !== "string" || n.text.length > MAX_NODE_TEXT)) errors.push(`node ${n.id}: text must be a string under ${MAX_NODE_TEXT} chars`);
    if (n.model !== undefined && !ALLOWED_MODELS.includes(n.model)) errors.push(`node ${n.id}: unknown model "${n.model}"`);
    if (n.maxTokens !== undefined && (!Number.isInteger(n.maxTokens) || n.maxTokens < 64 || n.maxTokens > 4000)) errors.push(`node ${n.id}: maxTokens out of 64..4000`);
  });
  const eids = new Set();
  const pairs = new Set();
  g.edges.forEach(e => {
    if (!e || typeof e !== "object") { errors.push("edge is not an object"); return; }
    if (!e.id || eids.has(e.id)) errors.push(`edge with missing or duplicate id ${e.id || "?"}`);
    else eids.add(e.id);
    if (e.from === e.to) errors.push(`edge ${e.id}: self-loop on "${e.from}"`);
    else {
      const pair = `${e.from}->${e.to}`;
      if (pairs.has(pair)) errors.push(`edge ${e.id}: duplicate synapse ${pair}`);
      else pairs.add(pair);
    }
    if (!ids.has(e.from)) errors.push(`edge ${e.id}: dangling from "${e.from}"`);
    if (!ids.has(e.to)) errors.push(`edge ${e.id}: dangling to "${e.to}"`);
    if (typeof e.weight !== "number" || !Number.isFinite(e.weight) || e.weight < 0 || e.weight > 1) errors.push(`edge ${e.id}: weight out of 0..1`);
    if (e.polarity !== 1 && e.polarity !== -1) errors.push(`edge ${e.id}: polarity must be 1 or -1`);
  });
  return { ok: errors.length === 0, errors };
}


// ─── the compiler — the graph IS the prompt ──────────────────────────────────
// DETERMINISTIC: same genome ⇒ byte-identical string ⇒ same hash. Everything
// that could wobble is pinned — region order is REGION_ORDER, in-region order is
// weight desc then id asc, tension order is edge id asc. ZTS_GOVERNANCE leads
// verbatim so no weight slider can out-rank the approval spine. Weight bands
// translate a slider into prompt emphasis: ≥0.75 commands (PRIMARY), ≥0.4
// informs, <0.4 barely whispers (Minor). Disabled nodes don't exist. Inhibitory
// edges between two ENABLED nodes become explicit conflict-resolution lines — the
// model is TOLD which impulse wins, not left to average them.
export function compileGenome(genome) {
  const byId = new Map(genome.nodes.map(n => [n.id, n]));
  const sections = [];
  for (const region of REGION_ORDER) {
    const lines = genome.nodes
      .filter(n => isAwake(n) && n.region === region)
      .sort((a, b) => (b.weight - a.weight) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(n => (n.weight >= 0.75 ? `PRIMARY — ${n.text}` : n.weight >= 0.4 ? n.text : `Minor — ${n.text}`));
    if (lines.length) sections.push({ region, lines });
  }
  const tensions = genome.edges
    .filter(e => e.polarity === -1 && isAwake(byId.get(e.from)) && isAwake(byId.get(e.to)))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(e => `TENSION: ${byId.get(e.from).label} tempers ${byId.get(e.to).label} — when they conflict, ${byId.get(e.from).label} wins.`);

  const parts = [ZTS_GOVERNANCE];
  sections.forEach(s => {
    parts.push(`${REGIONS[s.region].label.toUpperCase()} — ${REGIONS[s.region].desc}:\n${s.lines.map(l => `- ${l}`).join("\n")}`);
  });
  if (tensions.length) {
    parts.push(`INTERNAL TENSIONS:\n${tensions.map(l => `- ${l}`).join("\n")}`);
    sections.push({ region: "tension", lines: tensions }); // pseudo-section so UIs can render the tension block too
  }
  const systemPrompt = parts.join("\n\n");
  return { systemPrompt, sections, hash: djb2(systemPrompt) };
}


// ─── activation spread — pure, for pulses and task traces ────────────────────
// Seeds light at 1.0 and the wave rolls outward along edge direction. Per step,
// every edge reads its source's level FROM THE PREVIOUS STEP (synchronous
// update, so within-step edge order can never change the result):
//   excitatory:  target = max(target, source·weight·decay)   — order-free (max)
//   inhibitory:  target = max(0, target − source·weight·decay) — dampens, clamps at 0
// Excitation applies before inhibition inside a step, so tempering always gets
// the last word — the same rule the compiler states in its TENSION lines.
// Disabled nodes never activate and never relay. max() + multiplicative decay
// makes levels monotone-bounded, so the wave provably dies; we stop the moment a
// step changes nothing, or at `steps`, whichever comes first.
export function propagate(genome, seedIds, { steps = 4, decay = 0.55 } = {}) {
  const EPS = 0.01; // below this a node is "dark" — keeps ripples finite and traces readable
  const enabled = new Set(genome.nodes.filter(n => isAwake(n)).map(n => n.id));
  const levels = {};
  genome.nodes.forEach(n => { levels[n.id] = 0; });
  const step0 = [];
  (seedIds || []).forEach(id => {
    if (enabled.has(id) && levels[id] !== 1) { levels[id] = 1; step0.push(id); }
  });
  const order = [step0];
  const edgesFired = [];
  const firedSet = new Set();

  for (let s = 0; s < steps; s++) {
    const prev = { ...levels };
    for (const e of genome.edges) { // excitation pass — reads prev, max() into levels
      if (e.polarity === -1 || !enabled.has(e.from) || !enabled.has(e.to)) continue;
      const src = prev[e.from];
      if (src <= EPS) continue;
      const push = src * e.weight * decay;
      if (push > levels[e.to]) {
        levels[e.to] = push;
        if (!firedSet.has(e.id)) { firedSet.add(e.id); edgesFired.push(e.id); }
      }
    }
    for (const e of genome.edges) { // inhibition pass — tempering gets the last word
      if (e.polarity !== -1 || !enabled.has(e.from) || !enabled.has(e.to)) continue;
      const src = prev[e.from];
      if (src <= EPS || levels[e.to] <= 0) continue;
      levels[e.to] = Math.max(0, levels[e.to] - src * e.weight * decay);
      if (!firedSet.has(e.id)) { firedSet.add(e.id); edgesFired.push(e.id); }
    }
    let changed = false;
    const newly = [];
    genome.nodes.forEach(n => {
      if (levels[n.id] !== prev[n.id]) changed = true;
      if (prev[n.id] <= EPS && levels[n.id] > EPS) newly.push(n.id);
    });
    if (newly.length) order.push(newly);
    if (!changed) break; // fixpoint — the wave died before the step budget did
  }
  return { levels, order, edgesFired };
}


// Task kind → seed ids for the activation trace. The mapped skill node leads,
// followed by its strongest ENABLED excitatory inputs (the signals/knowledge
// that argue FOR the act) so each task kind lights a distinct causal
// neighborhood — the tempering principles then fire via propagate itself. Keys
// match the DNA worker's taskTypes { short, article, pitch, scout, strategy, grow }.
const TASK_SKILL = {
  short: "n_sk_short", article: "n_sk_article", pitch: "n_sk_pitch",
  scout: "n_sk_scout", strategy: "n_sk_strategy", grow: "n_sk_grow",
};

export function seedsForTask(genome, kind) {
  const skillId = TASK_SKILL[kind];
  if (!skillId || !genome.nodes.some(n => n.id === skillId)) return [];
  const enabled = new Set(genome.nodes.filter(n => isAwake(n)).map(n => n.id));
  const inputs = genome.edges
    .filter(e => e.to === skillId && e.polarity === 1 && enabled.has(e.from))
    .sort((a, b) => (b.weight - a.weight) || (a.id < b.id ? -1 : 1))
    .slice(0, 4)
    .map(e => e.from);
  return [skillId, ...inputs];
}


// ─── event bus — module-level singleton ──────────────────────────────────────
// One channel, two event shapes:
//   {type:"activation", seeds, trace, label}  — worker/pulse fires the canvas
//   {type:"genome", genome}                   — every saveGenome, so all views converge
// Listeners are isolated: one throwing subscriber never silences the rest.
export const dnaBus = (() => {
  const subs = new Set();
  return {
    on(fn) { subs.add(fn); return () => subs.delete(fn); },
    emit(evt) { subs.forEach(fn => { try { fn(evt); } catch {} }); },
  };
})();


// ─── stats — the header pills read this ──────────────────────────────────────
export function genomeStats(genome) {
  const byRegion = {};
  Object.keys(REGIONS).forEach(r => { byRegion[r] = 0; });
  let enabled = 0;
  genome.nodes.forEach(n => {
    byRegion[n.region] = (byRegion[n.region] || 0) + 1;
    if (isAwake(n)) enabled++;
  });
  return { nodes: genome.nodes.length, edges: genome.edges.length, enabled, byRegion };
}

// ═══════════════════════════════════════════════════════════════════════════
// @cc/ops/infer — NEVER ASK A QUESTION THE SYSTEM CAN ANSWER ITSELF.
//
// The first version of the engine panel opened with a form: "Tell it what to
// work on. Missing: who the writing is for, what is being sold, at least one
// topic." Five fields, on both tools, before anything could happen.
//
// Every one of those answers was already in the database.
//
//   • 41 prospects, each with website_context and a written brief, in exactly
//     four verticals of ten — HVAC, physical therapy, plastic surgery,
//     orthodontics — all Chicago. That IS the ICP, and it is a deliberate
//     4x10 test somebody designed on purpose.
//   • Three drafted emails that all lead with the same pitch: you are invisible
//     in paid results for searches your customers are already making. That IS
//     the offer.
//   • One Shopify product, and thirteen published articles whose titles are
//     literally the topic list.
//
// Asking the operator to retype what the system already knows is not "operator
// input driving direction". It is a config screen wearing a nicer sentence.
//
// DELIBERATELY NOT AN LLM CALL. Almost all of this is counting and grouping,
// so it runs instantly, costs nothing, needs no API key, and — most
// importantly — is DETERMINISTIC and testable. A model would be slower, could
// hallucinate a vertical that is not in the data, and would make the one thing
// that must be trustworthy (what the system thinks you do) unverifiable.
//
// EVERY CONCLUSION CARRIES ITS EVIDENCE. The panel renders "X, because Y" so
// the operator is confirming a reading of their own data rather than trusting a
// black box. Confirming beats authoring; auditing beats confirming.
//
// Pure: no fetch, no Date.now(), no database.
// ═══════════════════════════════════════════════════════════════════════════

const str = (v) => (typeof v === "string" ? v.trim() : "");
const uniq = (xs) => [...new Set(xs.filter(Boolean))];

/** Turn ["a","b","c"] into "a, b and c" without an Oxford comma pile-up. */
export function joinList(items) {
  const xs = items.filter(Boolean);
  if (xs.length === 0) return "";
  if (xs.length === 1) return xs[0];
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** Categories that describe a lead SOURCE rather than a vertical. Counting
 *  "inbound" as an industry would put it in the ICP sentence. */
const NON_VERTICAL = new Set(["inbound", "unknown", "other", ""]);

/** Naive plural — enough for the vertical labels this actually sees. */
function pluralise(noun) {
  const n = str(noun);
  if (!n) return "";
  if (/(s|x|z|ch|sh)$/i.test(n)) return `${n}es`;
  if (/[^aeiou]y$/i.test(n)) return `${n.slice(0, -1)}ies`;
  return `${n}s`;
}

/**
 * What business is this actually doing outbound to, and offering?
 *
 * Reads the pipeline rather than asking about it.
 */
export function inferOutbound({ prospects = [], drafts = [] } = {}) {
  const evidence = [];

  // ── ICP, from the verticals actually in the pipeline ─────────────────────
  // Grouped case-insensitively, but DISPLAYED with the original casing —
  // lowercasing for the group key turned "HVAC contractor" into "hvac
  // contractor" in the sentence the operator reads.
  const counts = new Map();
  const labels = new Map();
  for (const p of prospects) {
    const raw = str(p && p.category);
    const key = raw.toLowerCase();
    if (NON_VERTICAL.has(key)) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
    if (!labels.has(key)) labels.set(key, raw);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  // Only verticals with real presence. A single stray row is not a segment.
  const verticals = ranked.filter(([, n]) => n >= 2).map(([c]) => labels.get(c) || c);

  const cities = uniq(prospects.map((p) => str(p && p.city)).filter((c) => c && c.toLowerCase() !== "unknown"));
  const geography = cities.length === 1 ? cities[0] : joinList(cities.slice(0, 3));

  let icp = "";
  if (verticals.length) {
    icp = joinList(verticals.map(pluralise));
    if (geography) icp += ` in ${geography}`;
    evidence.push({
      field: "icp",
      because: `${ranked.filter(([, n]) => n >= 2).map(([c, n]) => `${n} ${labels.get(c) || c}`).join(", ")} already in your pipeline`,
    });
  }
  if (geography) {
    evidence.push({ field: "geography", because: `every prospect on file is in ${geography}` });
  }

  // ── Offer, from what the sent emails actually pitch ───────────────────────
  // Theme detection over real sent copy, not a guess. Each theme needs two
  // distinct signals present so one stray word cannot name the offer.
  const corpus = drafts.map((d) => str(d && (d.draft_body || d.body))).join(" \n ").toLowerCase();
  const THEMES = [
    {
      id: "paid-search",
      needs: [/paid results|google ads|paid search|adwords/, /search(ing|ed)?\b|near me|campaign/],
      offer: "Google Ads management — getting them visible in paid results for the high-intent searches their customers are already making",
    },
    {
      id: "seo",
      needs: [/\bseo\b|organic|rank(ing)?\b/, /search(ing|ed)?\b|keyword/],
      offer: "search visibility work — getting them found for the terms their customers search",
    },
  ];
  const hit = THEMES.find((t) => t.needs.every((re) => re.test(corpus)));
  const offer = hit ? hit.offer : "";
  if (hit) {
    // Quote them back to themselves. The most convincing evidence that the
    // system read the data is a sentence the operator recognises as their own.
    const sample = drafts.map((d) => str(d && (d.draft_body || d.body))).find((b) => b.length > 40) || "";
    const firstLine = sample.split(/\n/).map((l) => l.trim()).find((l) => l.length > 30) || "";
    evidence.push({
      field: "offer",
      because: firstLine ? `your own sent copy opens: "${firstLine.slice(0, 140)}…"` : "detected from your sent emails",
    });
  }

  const filled = [icp, offer].filter(Boolean).length;
  return {
    direction: { icp, offer, geography, avoid: [], voice: "", perDay: 10 },
    evidence,
    confidence: filled === 2 ? "high" : filled === 1 ? "medium" : "low",
    unresolved: [!icp && "icp", !offer && "offer"].filter(Boolean),
  };
}

/** Strip a title down to its subject words, so two articles about the same
 *  thing collapse into one topic instead of two. */
const STOP = new Set(("a an and or the of to in for on with your you what where when why how "
  + "is are was were do does did can could should would if then than that this these those "
  + "from about into over under after before its it's their there here as at by not no yes "
  + "guide overview introduction basics 101 explained understanding").split(" "));

function keywords(title, max = 4) {
  return str(title).toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .slice(0, max);
}

/**
 * What is this store selling, to whom, and what has it already written about?
 *
 * Topics come from published titles because that is the most honest possible
 * answer to "what does this brand write about" — it is what the brand has
 * actually written.
 */
export function inferContent({ product = null, articles = [] } = {}) {
  const evidence = [];

  const productName = str(product && product.title);
  const price = product && product.price ? ` ($${product.price})` : "";
  const productLine = productName ? `${productName}${price}` : "";
  if (productName) {
    evidence.push({
      field: "product",
      because: product && product.otherActive
        ? `your only active Shopify product of ${product.otherActive + 1}`
        : "the only active product in your Shopify store",
    });
  }

  // Topics: one per published article, deduped on keyword overlap so a blog
  // with four scam articles yields one scam topic rather than four.
  const seen = new Set();
  const topics = [];
  for (const a of articles) {
    const title = str(a && a.title);
    if (!title) continue;
    const key = keywords(title).sort().join(" ");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    topics.push(title);
  }
  if (topics.length) {
    evidence.push({
      field: "topics",
      because: `${articles.length} article${articles.length === 1 ? "" : "s"} you have already published — the engine writes adjacent angles, never repeats these`,
    });
  }

  // Audience: derived from the product's own category language rather than
  // invented. Left EMPTY when there is nothing to derive it from, so the panel
  // asks one honest question instead of presenting a confident fiction.
  const blob = `${productName} ${str(product && product.description)} ${topics.join(" ")}`.toLowerCase();
  const AUDIENCES = [
    { test: /seed phrase|recovery key|self-custody|cold storage|hardware wallet|crypto/, who: "people holding their own crypto who are worried about losing access to it — self-custody beginners past their first wallet, not traders" },
    { test: /supplement|vitamin|wellness/, who: "people managing their own health who want to understand what they are taking" },
  ];
  const match = AUDIENCES.find((a) => a.test.test(blob));
  const audience = match ? match.who : "";
  if (match) {
    evidence.push({ field: "audience", because: "inferred from what the product is and what you have written about" });
  }

  const filled = [audience, productLine, topics.length].filter(Boolean).length;
  return {
    direction: {
      audience, product: productLine, topics, avoid: [], voice: "",
      perDay: 1, blogHandle: str(articles[0] && articles[0].blogHandle),
    },
    evidence,
    confidence: filled === 3 ? "high" : filled >= 2 ? "medium" : "low",
    unresolved: [!audience && "audience", !productLine && "product", !topics.length && "topics"].filter(Boolean),
  };
}

/**
 * Merge an inferred proposal under anything the operator has explicitly set.
 *
 * The operator's word always wins. Inference fills the blanks and never
 * overwrites — otherwise a re-run would quietly discard a correction, which is
 * the fastest way to make someone stop trusting an automatic system.
 */
export function applyInference(saved, inferred) {
  const out = { ...(inferred || {}) };
  for (const [k, v] of Object.entries(saved || {})) {
    const isEmpty = Array.isArray(v) ? v.length === 0 : !str(v) && typeof v !== "number";
    if (!isEmpty) out[k] = v;
  }
  return out;
}

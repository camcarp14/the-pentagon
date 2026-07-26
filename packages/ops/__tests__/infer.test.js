// Fixtures are the REAL production pipeline, not invented shapes:
// 10 HVAC + 10 physical therapy + 10 plastic surgeon + 10 orthodontist + 1
// inbound, all Chicago; and the actual drafted email copy.
import { describe, it, expect } from "vitest";
import { inferOutbound, inferContent, applyInference, joinList } from "../infer.js";

const many = (category, n, over = {}) =>
  Array.from({ length: n }, (_, i) => ({ id: `${category}-${i}`, category, city: "Chicago", ...over }));

const REAL_PROSPECTS = [
  ...many("HVAC contractor", 10),
  ...many("physical therapy clinic", 10),
  ...many("plastic surgeon", 10),
  ...many("orthodontist", 10),
  { id: "lead", category: "inbound", city: "Chicago" },
];

const REAL_DRAFTS = [
  { draft_body: "Jason — searched for pelvic floor PT and vestibular therapy in the West Loop. Core PT doesn't show up anywhere in paid results, even though you have 24/7 online booking and a 5.0 rating that would make your ads convert well." },
  { draft_body: 'Chicagoans search "physical therapy near me" thousands of times a month — and Loop PT isn\'t showing up in paid results for any of it.' },
];

describe("inferOutbound() against the real pipeline", () => {
  const out = inferOutbound({ prospects: REAL_PROSPECTS, drafts: REAL_DRAFTS });

  it("names every real vertical", () => {
    for (const v of ["HVAC contractors", "physical therapy clinics", "plastic surgeons", "orthodontists"]) {
      expect(out.direction.icp.toLowerCase()).toContain(v.toLowerCase());
    }
  });

  it("excludes 'inbound' — a lead source is not an industry", () => {
    expect(out.direction.icp.toLowerCase()).not.toContain("inbound");
  });

  it("picks up the city", () => {
    expect(out.direction.icp).toContain("in Chicago");
    expect(out.direction.geography).toBe("Chicago");
  });

  it("derives the offer from the sent copy, not a guess", () => {
    expect(out.direction.offer.toLowerCase()).toContain("google ads");
    expect(out.direction.offer.toLowerCase()).toContain("paid results");
  });

  it("is high confidence with nothing left to ask", () => {
    expect(out.confidence).toBe("high");
    expect(out.unresolved).toEqual([]);
  });

  it("quotes the operator's own sentence back as evidence", () => {
    const e = out.evidence.find((x) => x.field === "offer");
    expect(e.because).toContain("Core PT doesn't show up");
  });

  it("cites the vertical counts as evidence, preserving acronym casing", () => {
    // Grouping is case-insensitive; DISPLAY must not be. Lowercasing the group
    // key rendered "HVAC contractor" as "hvac contractor" in the sentence the
    // operator reads — this test originally asserted that bug.
    const e = out.evidence.find((x) => x.field === "icp");
    expect(e.because).toContain("10 HVAC contractor");
    expect(out.direction.icp).toContain("HVAC contractors");
    expect(out.direction.icp).not.toContain("hvac");
  });

  it("still groups case-insensitively despite preserving casing", () => {
    const mixed = [
      { id: "a", category: "HVAC contractor", city: "Chicago" },
      { id: "b", category: "hvac contractor", city: "Chicago" },
      { id: "c", category: "Hvac Contractor", city: "Chicago" },
    ];
    const r = inferOutbound({ prospects: mixed });
    const e = r.evidence.find((x) => x.field === "icp");
    expect(e.because).toContain("3 ");           // one group of three, not three of one
    expect(r.direction.icp.match(/contractor/gi)).toHaveLength(1);
  });
});

describe("inferOutbound() edge cases", () => {
  it("ignores a one-off vertical rather than calling it a segment", () => {
    const out = inferOutbound({ prospects: [...many("dentist", 5), { id: "x", category: "zoo", city: "Chicago" }] });
    expect(out.direction.icp).toContain("dentists");
    expect(out.direction.icp).not.toContain("zoo");
  });

  it("does not invent an offer when no email has ever been written", () => {
    const out = inferOutbound({ prospects: REAL_PROSPECTS, drafts: [] });
    expect(out.direction.offer).toBe("");
    expect(out.unresolved).toContain("offer");
    expect(out.confidence).toBe("medium");
  });

  it("needs two independent signals before naming a theme", () => {
    // The word "campaign" alone must not conclude "Google Ads".
    const out = inferOutbound({ prospects: REAL_PROSPECTS, drafts: [{ draft_body: "loved your campaign" }] });
    expect(out.direction.offer).toBe("");
  });

  it("handles multiple cities", () => {
    const out = inferOutbound({ prospects: [...many("dentist", 3), ...many("dentist", 3, { city: "Denver" })] });
    expect(out.direction.geography).toContain("Chicago");
    expect(out.direction.geography).toContain("Denver");
  });

  it("returns low confidence and no crash on nothing at all", () => {
    const out = inferOutbound({});
    expect(out.confidence).toBe("low");
    expect(out.direction.icp).toBe("");
    expect(() => inferOutbound()).not.toThrow();
  });

  it("pluralises correctly", () => {
    expect(inferOutbound({ prospects: many("bakery", 3) }).direction.icp).toContain("bakeries");
    expect(inferOutbound({ prospects: many("church", 3) }).direction.icp).toContain("churches");
  });
});

describe("inferContent() against the real store", () => {
  const REAL_PRODUCT = { title: "Zero To Secure™ Recovery Key Kit", price: "150.00", description: "A permanent, offline stainless steel backup for your recovery key (seed phrase)." };
  const REAL_ARTICLES = [
    { title: "Where Seed Phrases Come From and How to Secure Them", blogHandle: "news" },
    { title: "Most Common Crypto Scams to Watch Out For" },
    { title: "Resources and Next Steps if You (or Someone You Know) Lost Access to Crypto or Were Scammed" },
    { title: "Why People Really Lose Their Crypto" },
  ];
  const out = inferContent({ product: REAL_PRODUCT, articles: REAL_ARTICLES });

  it("names the product with its price", () => {
    expect(out.direction.product).toContain("Recovery Key Kit");
    expect(out.direction.product).toContain("$150.00");
  });

  it("derives a self-custody audience from the product and the writing", () => {
    expect(out.direction.audience.toLowerCase()).toContain("self-custody");
  });

  it("uses published titles as the topic list", () => {
    expect(out.direction.topics.length).toBeGreaterThan(2);
    expect(out.direction.topics).toContain("Most Common Crypto Scams to Watch Out For");
  });

  it("carries the blog handle through", () => {
    expect(out.direction.blogHandle).toBe("news");
  });

  it("is high confidence — nothing left to ask", () => {
    expect(out.confidence).toBe("high");
    expect(out.unresolved).toEqual([]);
  });

  it("collapses duplicate topics instead of listing the same thing twice", () => {
    const dupes = [{ title: "Crypto Scams To Watch Out For" }, { title: "The crypto scams to watch out for!" }];
    expect(inferContent({ product: REAL_PRODUCT, articles: dupes }).direction.topics).toHaveLength(1);
  });

  it("leaves audience EMPTY rather than inventing one it cannot derive", () => {
    // An honest single question beats a confident fiction.
    const out2 = inferContent({ product: { title: "Widget", description: "a widget" }, articles: [] });
    expect(out2.direction.audience).toBe("");
    expect(out2.unresolved).toContain("audience");
  });

  it("survives nothing at all", () => {
    expect(() => inferContent()).not.toThrow();
    expect(inferContent({}).confidence).toBe("low");
  });
});

describe("applyInference()", () => {
  it("the operator's word always wins", () => {
    const merged = applyInference({ icp: "only dentists" }, { icp: "everything", offer: "ads" });
    expect(merged.icp).toBe("only dentists");
    expect(merged.offer).toBe("ads");
  });

  it("inference fills blanks, including empty arrays and whitespace", () => {
    const merged = applyInference({ icp: "   ", topics: [] }, { icp: "derived", topics: ["a", "b"] });
    expect(merged.icp).toBe("derived");
    expect(merged.topics).toEqual(["a", "b"]);
  });

  it("keeps a deliberate numeric override, including a low one", () => {
    expect(applyInference({ perDay: 1 }, { perDay: 10 }).perDay).toBe(1);
  });

  it("handles null on either side", () => {
    expect(applyInference(null, { icp: "x" }).icp).toBe("x");
    expect(() => applyInference({ a: 1 }, null)).not.toThrow();
  });
});

describe("joinList()", () => {
  it("reads like a sentence", () => {
    expect(joinList(["a"])).toBe("a");
    expect(joinList(["a", "b"])).toBe("a and b");
    expect(joinList(["a", "b", "c"])).toBe("a, b and c");
    expect(joinList([])).toBe("");
  });
});

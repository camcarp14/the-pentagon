// Fixtures below are the ACTUAL rows in the production outreach table, pulled
// verbatim. Two of the three drafts on this store are malformed, and the third
// fixture is the one that was really sent to a real prospect in that state.
import { describe, it, expect } from "vitest";
import { cleanBody, cleanSubject, isMalformed, normalizeDraft } from "../draft.js";

// Row 33e9f65e — status 'draft', still in the queue.
const LOOP_PT_BODY = '{"subject": "Loop PT + Google Ads — missed appointments in the Loop", "body": "Chicagoans search "physical therapy near me" thousands of times a month — and Loop PT isn\'t showing up.\\n\\nWorth a quick look?"}';
const LOOP_PT_SUBJECT = "Quick question about your Google Ads";

// Row 9a0b18bd — the one that is FINE. Must pass through untouched.
const CORE_PT_BODY = "Jason — searched for pelvic floor PT and vestibular therapy in the West Loop. Core PT doesn't show up anywhere in paid results, even though you have 24/7 online booking and a 5.0.";
const CORE_PT_SUBJECT = "Core PT's pelvic health + vestibular services are invisible in search";

describe("the real production rows", () => {
  it("recovers the body from the malformed Loop PT draft", () => {
    const out = cleanBody(LOOP_PT_BODY);
    expect(out).not.toMatch(/^\{/);
    expect(out).not.toContain('"body"');
    expect(out).toContain("Chicagoans search");
    expect(out).toContain("Worth a quick look?");
  });

  it("recovers the real subject that was buried in the blob", () => {
    // The row's own draft_subject is the generic placeholder written for every
    // prospect; the good one is inside the JSON.
    expect(cleanSubject(LOOP_PT_BODY, LOOP_PT_SUBJECT))
      .toBe("Loop PT + Google Ads — missed appointments in the Loop");
  });

  it("survives the unescaped inner quotes that break JSON.parse", () => {
    // '"physical therapy near me"' inside the value makes this invalid JSON.
    // A parse-only implementation recovers nothing here.
    expect(() => JSON.parse(LOOP_PT_BODY)).toThrow();
    expect(cleanBody(LOOP_PT_BODY).length).toBeGreaterThan(50);
  });

  it("does not truncate at the first inner quote", () => {
    // The bug this guards: cutting at the first `"` yields
    // 'Chicagoans search ' and throws the rest of the email away.
    expect(cleanBody(LOOP_PT_BODY)).toContain("physical therapy near me");
  });

  it("turns literal \\n into real newlines", () => {
    expect(cleanBody(LOOP_PT_BODY)).toContain("\n");
    expect(cleanBody(LOOP_PT_BODY)).not.toContain("\\n");
  });

  it("leaves the healthy Core PT draft completely alone", () => {
    expect(cleanBody(CORE_PT_BODY)).toBe(CORE_PT_BODY);
    expect(cleanSubject(CORE_PT_BODY, CORE_PT_SUBJECT)).toBe(CORE_PT_SUBJECT);
    expect(isMalformed(CORE_PT_BODY)).toBe(false);
  });

  it("flags malformed rows and only malformed rows", () => {
    expect(isMalformed(LOOP_PT_BODY)).toBe(true);
    expect(isMalformed(CORE_PT_BODY)).toBe(false);
    expect(isMalformed("")).toBe(false);
    expect(isMalformed(null)).toBe(false);
  });
});

describe("cleanSubject() preference order", () => {
  it("prefers a real row subject over the embedded one", () => {
    expect(cleanSubject('{"subject":"embedded","body":"b"}', "A specific real subject"))
      .toBe("A specific real subject");
  });

  it("ignores the generic placeholder and uses the embedded one", () => {
    expect(cleanSubject('{"subject":"the good one","body":"b"}', "Quick question about your Google Ads"))
      .toBe("the good one");
  });

  it("is case-insensitive about the placeholder", () => {
    expect(cleanSubject('{"subject":"good","body":"b"}', "QUICK QUESTION ABOUT YOUR GOOGLE ADS"))
      .toBe("good");
  });

  it("falls back to the generic subject rather than returning nothing", () => {
    // A blank subject line is worse than a boring one.
    expect(cleanSubject("plain body text", "Quick question about your Google Ads"))
      .toBe("Quick question about your Google Ads");
  });

  it("handles a plain-text body with no subject at all", () => {
    expect(cleanSubject("just a body", null)).toBe("just a body");
  });
});

describe("robustness", () => {
  it("never returns empty for non-empty input", () => {
    for (const s of ["hi", "{", "{}", '{"body":""}', '{"nope":1}', "   x   "]) {
      expect(typeof cleanBody(s)).toBe("string");
    }
    expect(cleanBody("hi")).toBe("hi");
  });

  it("degrades to the raw text when the blob has no body key", () => {
    const weird = '{"foo":"bar"}';
    expect(cleanBody(weird)).toBe(weird);
  });

  it("survives null, undefined and non-strings", () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      expect(cleanBody(bad)).toBe("");
      expect(() => cleanSubject(bad)).not.toThrow();
    }
  });

  it("parses well-formed JSON the fast path", () => {
    const good = JSON.stringify({ subject: "s", body: "line1\nline2" });
    expect(cleanBody(good)).toBe("line1\nline2");
    expect(cleanSubject(good, null)).toBe("s");
  });
});

describe("normalizeDraft()", () => {
  it("returns send-ready text and flags the repair", () => {
    const out = normalizeDraft({ subject: LOOP_PT_SUBJECT, body: LOOP_PT_BODY });
    expect(out.repaired).toBe(true);
    expect(out.subject).toBe("Loop PT + Google Ads — missed appointments in the Loop");
    expect(out.body).toContain("Chicagoans search");
    expect(out.body).not.toMatch(/^\{/);
  });

  it("passes a healthy draft through unrepaired", () => {
    const out = normalizeDraft({ subject: CORE_PT_SUBJECT, body: CORE_PT_BODY });
    expect(out).toEqual({ subject: CORE_PT_SUBJECT, body: CORE_PT_BODY, repaired: false });
  });

  it("handles an empty draft without throwing", () => {
    expect(() => normalizeDraft({})).not.toThrow();
    expect(normalizeDraft({}).body).toBe("");
  });
});

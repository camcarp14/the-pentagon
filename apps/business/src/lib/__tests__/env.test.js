import { describe, it, expect } from "vitest";
import { classifyKey, jwtRole, urlHost, isLoopback, checkAgentEnv } from "../env.js";

// Real Supabase keys are unsigned-verifiable JWTs whose payload carries `role`.
// Built inline so the fixtures are readable and no secret material lives in the
// repo — the signature segment is never decoded, so any filler works.
const seg = (obj) => btoa(JSON.stringify(obj));
const jwt = (payload) => `${seg({ alg: "HS256", typ: "JWT" })}.${seg(payload)}.c2lnbmF0dXJl`;

const ANON_JWT = jwt({ iss: "supabase", ref: "abcdefghijklmnop", role: "anon", iat: 1_700_000_000, exp: 2_000_000_000 });
const SERVICE_JWT = jwt({ iss: "supabase", ref: "abcdefghijklmnop", role: "service_role", iat: 1_700_000_000, exp: 2_000_000_000 });

describe("classifyKey refuses secrets", () => {
  // This is the failure that looks exactly like success. A service_role key
  // pasted into the anon slot WORKS: every query returns rows, RLS is bypassed
  // so nothing 403s, no console error appears — and the browser bundle now ships
  // a credential that can read and rewrite the entire business. There is no
  // symptom. The only place it can be caught is here.
  it("a service_role JWT is refused, however valid it looks", () => {
    const v = classifyKey(SERVICE_JWT);
    expect(v.safe).toBe(false);
    expect(v.kind).toBe("service_role");
    expect(v.reason).toMatch(/service role/i);
  });

  it("an sb_secret_ key is refused", () => {
    const v = classifyKey("sb_secret_AbCdEf0123456789");
    expect(v.safe).toBe(false);
    expect(v.kind).toBe("secret");
    expect(v.reason).toMatch(/secret/i);
  });

  it("surrounding whitespace does not smuggle a secret past the check", () => {
    // A key pasted into a .env or a Netlify UI field routinely carries a
    // trailing newline or space. Failing to trim would drop it into the
    // "unrecognised shape" branch — which happens to also refuse, but a
    // publishable key with a trailing space would then be refused too, and a
    // check that rejects the correct key is a check that gets switched off.
    expect(classifyKey(`  ${SERVICE_JWT}\n`).kind).toBe("service_role");
    expect(classifyKey("  sb_secret_abc  ").safe).toBe(false);
    expect(classifyKey(`\n${ANON_JWT}  `).safe).toBe(true);
    expect(classifyKey("  sb_publishable_abc\n").safe).toBe(true);
  });
});

describe("classifyKey accepts exactly the two public key generations", () => {
  it("a legacy anon JWT is publishable", () => {
    const v = classifyKey(ANON_JWT);
    expect(v.safe).toBe(true);
    expect(v.kind).toBe("anon");
  });

  it("an sb_publishable_ key is publishable", () => {
    // A validator that only understood JWTs would reject a perfectly good new
    // format key — and a check that blocks a correct deploy gets deleted, which
    // is how the service key gets in later.
    const v = classifyKey("sb_publishable_AbCdEf0123456789");
    expect(v.safe).toBe(true);
    expect(v.kind).toBe("publishable");
  });
});

describe("classifyKey fails closed on everything else", () => {
  it("an unset key is named as missing rather than silently allowed", () => {
    for (const k of ["", null, undefined, "   "]) {
      const v = classifyKey(k);
      expect(v.safe, `key=${JSON.stringify(k)}`).toBe(false);
      expect(v.kind).toBe("missing");
    }
  });

  it("an unrecognised shape is refused, not assumed to be anon", () => {
    // Failing open on an unknown key shape costs the business; failing closed
    // costs a config error and a deploy.
    for (const k of [
      "hunter2",
      "eyJhbGciOiJIUzI1NiJ9",                 // one segment
      `${seg({ alg: "HS256" })}.${seg({ role: "anon" })}`, // two segments, not a JWT
      "not.a.jwt",                            // three segments, undecodable payload
      "sb_something_else_abc",
      "SB_PUBLISHABLE_abc",                   // case matters; this is not the prefix
      ANON_JWT.replace(/\./g, "-"),
    ]) {
      const v = classifyKey(k);
      expect(v.safe, `key=${k}`).toBe(false);
      expect(v.kind).toBe("unknown");
    }
  });

  it("a JWT with any role other than anon is refused and the role is named", () => {
    for (const role of ["authenticated", "postgres", "supabase_admin", "ANON"]) {
      const v = classifyKey(jwt({ role }));
      expect(v.safe, `role=${role}`).toBe(false);
      expect(v.kind).toBe("unknown");
      expect(v.reason).toContain(role);
    }
  });

  it("a JWT with no role claim, or a non-string one, is refused rather than defaulting", () => {
    // "No role claim" must never read as "the default role, which is anon".
    for (const payload of [{}, { role: null }, { role: 1 }, { role: ["anon"] }, { rôle: "anon" }]) {
      const v = classifyKey(jwt(payload));
      expect(v.safe, `payload=${JSON.stringify(payload)}`).toBe(false);
      expect(v.kind).toBe("unknown");
    }
  });

  it("never leaks the key material into the reason string it renders", () => {
    // The reason is displayed on the misconfiguration screen. Echoing the key
    // back would put a service credential on screen and into any screenshot.
    for (const k of [SERVICE_JWT, "sb_secret_TOPSECRETVALUE"]) {
      expect(classifyKey(k).reason).not.toContain(k);
    }
    expect(classifyKey("sb_secret_TOPSECRETVALUE").reason).not.toContain("TOPSECRETVALUE");
  });
});

describe("jwtRole", () => {
  it("reads the role claim out of a well-formed three-segment token", () => {
    expect(jwtRole(ANON_JWT)).toBe("anon");
    expect(jwtRole(SERVICE_JWT)).toBe("service_role");
  });

  it("returns null rather than throwing on anything that is not a JWT", () => {
    // A throw here would take down the whole boot gate, and a gate that crashes
    // is a gate that gets wrapped in a try/catch that ignores it.
    for (const k of [null, undefined, "", "abc", "a.b", "a.b.c.d", 12345, {}, "!!!.!!!.!!!"]) {
      expect(() => jwtRole(k)).not.toThrow();
      expect(jwtRole(k), `key=${String(k)}`).toBe(null);
    }
  });

  it("returns null when the payload decodes but is not JSON with a string role", () => {
    expect(jwtRole(`${seg({ alg: "HS256" })}.${btoa("not json")}.sig`)).toBe(null);
    expect(jwtRole(jwt({ role: 7 }))).toBe(null);
    expect(jwtRole(jwt({}))).toBe(null);
  });

  it("handles base64url payloads, which is what Supabase actually emits", () => {
    // Real tokens use `-` and `_` and drop the `=` padding. Decoding only
    // standard base64 would fail on a genuine service key and let it through as
    // "no role claim" — failing OPEN on the one input that matters most.
    const payload = JSON.stringify({ role: "service_role", note: "??>>??" });
    const b64url = btoa(payload).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(jwtRole(`${seg({ alg: "HS256" })}.${b64url}.sig`)).toBe("service_role");
    expect(classifyKey(`${seg({ alg: "HS256" })}.${b64url}.sig`).safe).toBe(false);
  });
});

describe("urlHost and isLoopback", () => {
  it("returns the host only — never a path, never credentials", () => {
    expect(urlHost("https://abcd.supabase.co/rest/v1")).toBe("abcd.supabase.co");
    expect(urlHost("http://127.0.0.1:54321")).toBe("127.0.0.1:54321");
  });

  it("returns null for an unparseable URL instead of throwing", () => {
    for (const u of ["", null, undefined, "not a url", "abcd.supabase.co"]) {
      expect(urlHost(u), `url=${String(u)}`).toBe(null);
    }
  });

  it("recognises the local Supabase stack so the https rule does not have to be disabled in dev", () => {
    // A rule that forbids `supabase start`'s http://127.0.0.1:54321 forces the
    // check off during development — and a check that is off in dev is a check
    // that is off when it ships.
    expect(isLoopback("http://127.0.0.1:54321")).toBe(true);
    expect(isLoopback("http://localhost:54321")).toBe(true);
    expect(isLoopback("http://[::1]:54321")).toBe(true);
  });

  it("does not mistake a remote host for loopback", () => {
    for (const u of ["https://abcd.supabase.co", "http://127.0.0.1.evil.com", "http://localhost.evil.com", "junk"]) {
      expect(isLoopback(u), `url=${u}`).toBe(false);
    }
  });
});

describe("checkAgentEnv", () => {
  const ok = "https://agent-project-fixture.supabase.co";

  it("refuses to boot on a service key, and names why", () => {
    const v = checkAgentEnv(ok, SERVICE_JWT);
    expect(v.ok).toBe(false);
    expect(v.keyKind).toBe("service_role");
    expect(v.problems.some((p) => /service role/i.test(p))).toBe(true);
  });

  it("refuses a missing URL and a missing key separately, so the screen can say which", () => {
    const v = checkAgentEnv("", "");
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => /VITE_AGENT_SUPABASE_URL is not set/.test(p))).toBe(true);
    expect(v.problems.some((p) => /VITE_AGENT_SUPABASE_ANON_KEY is not set/.test(p))).toBe(true);
    expect(v.host).toBe(null);
  });

  it("refuses plain http to a remote host — an anon key over http is a readable key", () => {
    const v = checkAgentEnv("http://agent-project-fixture.example.com", ANON_JWT);
    expect(v.ok).toBe(false);
    expect(v.problems.some((p) => /https/i.test(p))).toBe(true);
  });

  it("allows http for loopback only", () => {
    const v = checkAgentEnv("http://127.0.0.1:59999", ANON_JWT);
    expect(v.problems.some((p) => /https/i.test(p))).toBe(false);
    expect(v.host).toBe("127.0.0.1:59999");
  });

  it("a correctly configured pair boots, and reports the host without the key", () => {
    const v = checkAgentEnv(ok, ANON_JWT);
    expect(v.ok).toBe(true);
    expect(v.problems).toEqual([]);
    expect(v.keyKind).toBe("anon");
    expect(v.host).toBe("agent-project-fixture.supabase.co");
    expect(v.sameProject).toBe(false);
    expect(JSON.stringify(v)).not.toContain(ANON_JWT);
  });

  it("reports every problem at once rather than one per redeploy", () => {
    const v = checkAgentEnv("http://agent-project-fixture.example.com", SERVICE_JWT);
    expect(v.problems.length).toBeGreaterThanOrEqual(2);
  });
});

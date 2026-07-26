// Tests for the store-truth transforms.
//
// The fixtures are not invented. Every shape below was copied from a real
// Admin GraphQL response against the live Zero To Secure store, because the
// last thing this layer should do is pass against a shape Shopify never sends.
import { describe, it, expect } from "vitest";
import {
  storefrontBlockers, classifyOrder, agingUnfulfilled, summarizeOrders,
  buildSnapshot, nodes, BLOCKER, SEVERITY,
} from "../store.js";

const OWNER = "cam.carp14@gmail.com";
const NOW = Date.parse("2026-07-26T00:00:00Z");

// The live product, verbatim. Note tracksInventory:false with quantity 0 and a
// DENY policy — the exact combination that looks broken and is not.
const LIVE_PRODUCT = {
  id: "gid://shopify/Product/10061873315972",
  title: "Zero To Secure™ Recovery Key Kit",
  status: "ACTIVE",
  tracksInventory: false,
  publishedAt: "2025-07-13T22:17:25Z",
  variants: {
    edges: [{
      node: {
        id: "gid://shopify/ProductVariant/50862059585668",
        title: "Default Title",
        price: "150.00",
        availableForSale: true,
        inventoryQuantity: 0,
        inventoryPolicy: "DENY",
        inventoryItem: { tracked: false },
      },
    }],
  },
};

// Both real orders on the store: owner's own address, refunded, unfulfilled.
const TEST_ORDERS = [
  {
    id: "gid://shopify/Order/6146379513988",
    name: "#1002",
    createdAt: "2025-12-17T19:19:23Z",
    displayFinancialStatus: "REFUNDED",
    displayFulfillmentStatus: "UNFULFILLED",
    cancelledAt: null,
    totalPriceSet: { shopMoney: { amount: "150.0", currencyCode: "USD" } },
    customer: { email: OWNER },
  },
  {
    id: "gid://shopify/Order/6133749186692",
    name: "#1001",
    createdAt: "2025-12-09T01:24:27Z",
    displayFinancialStatus: "REFUNDED",
    displayFulfillmentStatus: "UNFULFILLED",
    cancelledAt: null,
    totalPriceSet: { shopMoney: { amount: "150.0", currencyCode: "USD" } },
    customer: { email: OWNER },
  },
];

const realOrder = (over = {}) => ({
  id: "gid://shopify/Order/1",
  name: "#2001",
  createdAt: "2026-07-20T00:00:00Z",
  displayFinancialStatus: "PAID",
  displayFulfillmentStatus: "UNFULFILLED",
  cancelledAt: null,
  totalPriceSet: { shopMoney: { amount: "150.00", currencyCode: "USD" } },
  customer: { email: "a.real.customer@example.com" },
  ...over,
});

describe("nodes()", () => {
  it("reads the edges/node shape Shopify actually sends", () => {
    expect(nodes({ edges: [{ node: { id: 1 } }, { node: { id: 2 } }] })).toEqual([{ id: 1 }, { id: 2 }]);
  });
  it("accepts plain arrays and the nodes shorthand", () => {
    expect(nodes([{ id: 1 }])).toEqual([{ id: 1 }]);
    expect(nodes({ nodes: [{ id: 1 }] })).toEqual([{ id: 1 }]);
  });
  it("never throws on null/garbage", () => {
    expect(nodes(null)).toEqual([]);
    expect(nodes(undefined)).toEqual([]);
    expect(nodes(42)).toEqual([]);
    expect(nodes({ edges: [null, { node: null }] })).toEqual([]);
  });
});

describe("storefrontBlockers()", () => {
  it("reports the LIVE product as sellable — untracked zero is not out of stock", () => {
    // The regression this guards: reading inventoryQuantity 0 without checking
    // `tracked` would fire a blocking alert on a perfectly healthy storefront,
    // every single pass, forever.
    expect(storefrontBlockers(LIVE_PRODUCT)).toEqual([]);
  });

  it("catches the tracking trap: tracking ON, zero stock, DENY policy", () => {
    const trapped = {
      ...LIVE_PRODUCT,
      tracksInventory: true,
      variants: { edges: [{ node: { ...LIVE_PRODUCT.variants.edges[0].node, availableForSale: false, inventoryItem: { tracked: true } } }] },
    };
    const codes = storefrontBlockers(trapped).map((b) => b.code);
    expect(codes).toContain(BLOCKER.OUT_OF_STOCK_DENY);
    expect(codes).toContain(BLOCKER.NO_SELLABLE_VARIANT);
  });

  it("does not fire OUT_OF_STOCK_DENY when the policy is CONTINUE", () => {
    const oversell = {
      ...LIVE_PRODUCT,
      variants: { edges: [{ node: { ...LIVE_PRODUCT.variants.edges[0].node, inventoryPolicy: "CONTINUE", inventoryItem: { tracked: true } } }] },
    };
    expect(storefrontBlockers(oversell).map((b) => b.code)).not.toContain(BLOCKER.OUT_OF_STOCK_DENY);
  });

  it("flags a draft product and an unpublished one", () => {
    expect(storefrontBlockers({ ...LIVE_PRODUCT, status: "DRAFT" }).map((b) => b.code)).toContain(BLOCKER.NOT_ACTIVE);
    expect(storefrontBlockers({ ...LIVE_PRODUCT, publishedAt: null }).map((b) => b.code)).toContain(BLOCKER.NOT_PUBLISHED);
  });

  it("flags a zero price as a warning, not a blocker", () => {
    const free = {
      ...LIVE_PRODUCT,
      variants: { edges: [{ node: { ...LIVE_PRODUCT.variants.edges[0].node, price: "0.00" } }] },
    };
    const found = storefrontBlockers(free).find((b) => b.code === BLOCKER.ZERO_PRICE);
    expect(found.severity).toBe(SEVERITY.WARNING);
  });

  it("reports all problems at once rather than the first", () => {
    const broken = { ...LIVE_PRODUCT, status: "DRAFT", publishedAt: null };
    expect(storefrontBlockers(broken).length).toBeGreaterThanOrEqual(2);
  });

  it("treats a missing product as blocking, not as fine", () => {
    expect(storefrontBlockers(null)[0].severity).toBe(SEVERITY.BLOCKING);
  });

  it("does not blow up on a product with no variants", () => {
    expect(() => storefrontBlockers({ ...LIVE_PRODUCT, variants: { edges: [] } })).not.toThrow();
  });
});

describe("classifyOrder()", () => {
  it("classifies both live orders as NOT real", () => {
    for (const o of TEST_ORDERS) {
      expect(classifyOrder(o, { staffEmails: [OWNER] }).real).toBe(false);
    }
  });

  it("matches staff email case-insensitively and ignoring whitespace", () => {
    const o = realOrder({ customer: { email: "  CAM.CARP14@Gmail.com " } });
    expect(classifyOrder(o, { staffEmails: [OWNER] }).real).toBe(false);
  });

  it("counts a paid stranger's order as real", () => {
    expect(classifyOrder(realOrder(), { staffEmails: [OWNER] })).toEqual({ real: true, reason: "paid" });
  });

  it("counts a partial refund as real revenue", () => {
    const o = realOrder({ displayFinancialStatus: "PARTIALLY_REFUNDED" });
    expect(classifyOrder(o, { staffEmails: [OWNER] }).real).toBe(true);
  });

  it("excludes cancelled and voided", () => {
    expect(classifyOrder(realOrder({ cancelledAt: "2026-07-21T00:00:00Z" })).real).toBe(false);
    expect(classifyOrder(realOrder({ displayFinancialStatus: "VOIDED" })).real).toBe(false);
  });

  it("falls back to the top-level email when there is no customer object", () => {
    const o = realOrder({ customer: null, email: OWNER });
    expect(classifyOrder(o, { staffEmails: [OWNER] }).real).toBe(false);
  });

  it("does not treat an empty staff list as matching everything", () => {
    expect(classifyOrder(realOrder({ customer: { email: "" } }), { staffEmails: [] }).real).toBe(true);
  });

  it("ignores blank entries in the staff list", () => {
    // A misconfigured "" in the env var must not classify every guest checkout
    // (which has no email) as a staff test order.
    const guest = realOrder({ customer: { email: "" } });
    expect(classifyOrder(guest, { staffEmails: ["", "   "] }).real).toBe(true);
  });

  it("survives malformed input", () => {
    expect(classifyOrder(null).real).toBe(false);
    expect(classifyOrder("nope").real).toBe(false);
  });
});

describe("agingUnfulfilled()", () => {
  it("returns nothing for the live store — both orders are refunded tests", () => {
    expect(agingUnfulfilled(TEST_ORDERS, NOW, { staffEmails: [OWNER] })).toEqual([]);
  });

  it("surfaces a real order sitting unfulfilled past the threshold", () => {
    const out = agingUnfulfilled([realOrder()], NOW, { thresholdDays: 2, staffEmails: [OWNER] });
    expect(out).toHaveLength(1);
    expect(out[0].ageDays).toBe(6);
    expect(out[0].totalUsd).toBe(150);
  });

  it("stays quiet inside the threshold", () => {
    const fresh = realOrder({ createdAt: "2026-07-25T12:00:00Z" });
    expect(agingUnfulfilled([fresh], NOW, { thresholdDays: 2 })).toEqual([]);
  });

  it("excludes fulfilled orders", () => {
    const done = realOrder({ displayFulfillmentStatus: "FULFILLED" });
    expect(agingUnfulfilled([done], NOW, { thresholdDays: 0 })).toEqual([]);
  });

  it("keeps an order with an unparseable date instead of dropping it", () => {
    // "Nothing dropped" has to survive bad data too — a silent filter here is
    // exactly the failure this list exists to prevent.
    const weird = realOrder({ createdAt: "not-a-date" });
    const out = agingUnfulfilled([weird], NOW, { thresholdDays: 2 });
    expect(out).toHaveLength(1);
    expect(out[0].ageDays).toBeNull();
  });

  it("sorts oldest first", () => {
    const a = realOrder({ id: "a", createdAt: "2026-07-24T00:00:00Z" });
    const b = realOrder({ id: "b", createdAt: "2026-07-01T00:00:00Z" });
    expect(agingUnfulfilled([a, b], NOW, { thresholdDays: 1 }).map((o) => o.id)).toEqual(["b", "a"]);
  });

  it("handles an empty/absent list", () => {
    expect(agingUnfulfilled([], NOW)).toEqual([]);
    expect(agingUnfulfilled(null, NOW)).toEqual([]);
  });
});

describe("summarizeOrders()", () => {
  it("reports the live store as zero real revenue", () => {
    const s = summarizeOrders(TEST_ORDERS, { staffEmails: [OWNER] });
    expect(s.total).toBe(2);
    expect(s.real).toBe(0);
    expect(s.test).toBe(2);
    expect(s.refunded).toBe(2);
    expect(s.realRevenueUsd).toBe(0);
    // Gross still shows the $300 that moved, so the two numbers can be
    // compared rather than one quietly replacing the other.
    expect(s.grossUsd).toBe(300);
  });

  it("does not let float drift into a money figure", () => {
    const cents = (n) => realOrder({ id: `o${n}`, totalPriceSet: { shopMoney: { amount: "0.10" } } });
    const s = summarizeOrders([cents(1), cents(2), cents(3)]);
    expect(s.realRevenueUsd).toBe(0.3);
  });

  it("counts unfulfilled only among real orders", () => {
    const s = summarizeOrders([...TEST_ORDERS, realOrder()], { staffEmails: [OWNER] });
    expect(s.real).toBe(1);
    expect(s.unfulfilled).toBe(1);
  });
});

describe("buildSnapshot()", () => {
  it("describes the live store honestly: sellable, no real orders, nothing overdue", () => {
    const snap = buildSnapshot({ products: [LIVE_PRODUCT], orders: TEST_ORDERS, now: NOW, staffEmails: [OWNER] });
    expect(snap.activeProducts).toBe(1);
    expect(snap.blockedProducts).toBe(0);
    expect(snap.orders.real).toBe(0);
    expect(snap.findings.storefrontBlocked).toEqual([]);
    expect(snap.findings.unfulfilled).toEqual([]);
    expect(snap.capturedAt).toBe("2026-07-26T00:00:00.000Z");
  });

  it("raises the storefront the moment it cannot take money", () => {
    const dead = { ...LIVE_PRODUCT, status: "DRAFT" };
    const snap = buildSnapshot({ products: [dead], orders: [], now: NOW });
    expect(snap.blockedProducts).toBe(1);
    expect(snap.findings.storefrontBlocked[0].title).toBe(LIVE_PRODUCT.title);
  });

  it("works with nothing at all", () => {
    const snap = buildSnapshot({ now: NOW });
    expect(snap.activeProducts).toBe(0);
    expect(snap.orders.total).toBe(0);
  });
});

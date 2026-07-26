// ═══════════════════════════════════════════════════════════════════════════
// @cc/ops/store — STORE TRUTH. Pure transforms over Shopify read data.
//
// Same discipline as guard.js: no fetch, no Date.now(), no database. Shopify's
// API shapes go in, decisions come out, and every time-dependent answer takes
// `now` as a parameter. The I/O half lives in netlify/functions/lib/shopify-read.mjs.
//
// WHY THESE CHECKS AND NOT REORDER POINTS. The original plan called for an
// inventory subsystem — reorder points, cash-tied-up, stockout runway. Reading
// the actual store killed that: one active product, inventory tracking OFF, and
// two lifetime orders that were both self-placed tests and both refunded. A
// reorder engine there would be a control system wired to a machine that is not
// running, and it would need maintaining forever.
//
// What a pre-revenue storefront can actually lose to silence is different, and
// it is what this file checks: the store quietly becoming unable to take an
// order, and a real order arriving and going unnoticed. Both are cheap to watch
// and both are unrecoverable if missed.
//
// THE TRAP THIS ENCODES. Today the product survives on `tracksInventory: false`
// — quantity reads 0 but Shopify sells it anyway because nothing is being
// counted. Turn tracking on with 0 on hand and the DENY policy silently stops
// every sale, with no error anywhere and the product still showing ACTIVE. That
// is a storefront that looks fine and cannot take money. `storefrontBlockers`
// exists for exactly that state.
// ═══════════════════════════════════════════════════════════════════════════

/** Severity ladder. `blocking` means the store cannot take money in this state. */
export const SEVERITY = Object.freeze({
  BLOCKING: "blocking",
  WARNING: "warning",
});

export const BLOCKER = Object.freeze({
  NOT_ACTIVE: "product is not ACTIVE",
  NOT_PUBLISHED: "product is not published to the online store",
  NO_SELLABLE_VARIANT: "no variant is available for sale",
  OUT_OF_STOCK_DENY: "tracked inventory is at or below zero and the policy is DENY",
  ZERO_PRICE: "variant price is zero",
});

const num = (v, fallback = 0) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

/** Shopify returns `{edges:[{node}]}` in most places but plain arrays in some
 *  client libraries. Accept either rather than exploding on the other. */
export function nodes(connection) {
  if (Array.isArray(connection)) return connection;
  if (!connection || typeof connection !== "object") return [];
  if (Array.isArray(connection.nodes)) return connection.nodes;
  if (Array.isArray(connection.edges)) {
    return connection.edges.map((e) => (e && e.node) || null).filter(Boolean);
  }
  return [];
}

/**
 * Everything currently preventing this product from being bought.
 *
 * Returns an array so a product with several problems reports all of them —
 * fixing one and finding it still cannot sell is the worst possible debugging
 * experience for something that costs revenue per hour.
 */
export function storefrontBlockers(product) {
  if (!product || typeof product !== "object") {
    return [{ code: BLOCKER.NOT_ACTIVE, severity: SEVERITY.BLOCKING, detail: "product missing from the read" }];
  }
  const out = [];
  const variants = nodes(product.variants);

  if (product.status !== "ACTIVE") {
    out.push({ code: BLOCKER.NOT_ACTIVE, severity: SEVERITY.BLOCKING, detail: `status is ${product.status || "unknown"}` });
  }
  if (!product.publishedAt) {
    out.push({ code: BLOCKER.NOT_PUBLISHED, severity: SEVERITY.BLOCKING, detail: "publishedAt is null" });
  }

  // `availableForSale` is Shopify's own verdict and the one the storefront
  // honours, so it is the primary signal. Checked across all variants: a
  // product is sellable if ANY variant is.
  if (variants.length && !variants.some((v) => v && v.availableForSale === true)) {
    out.push({ code: BLOCKER.NO_SELLABLE_VARIANT, severity: SEVERITY.BLOCKING, detail: `${variants.length} variant(s), none available for sale` });
  }

  for (const v of variants) {
    if (!v) continue;
    const label = v.title && v.title !== "Default Title" ? ` (${v.title})` : "";

    // The tracking trap. Only meaningful when inventory is actually tracked —
    // an untracked variant reports quantity 0 and sells fine, so reading that
    // 0 as "out of stock" would fire a false alarm on every healthy pass.
    const tracked = v.inventoryItem ? v.inventoryItem.tracked === true : product.tracksInventory === true;
    if (tracked && v.inventoryPolicy === "DENY" && num(v.inventoryQuantity, 0) <= 0) {
      out.push({
        code: BLOCKER.OUT_OF_STOCK_DENY,
        severity: SEVERITY.BLOCKING,
        detail: `${num(v.inventoryQuantity, 0)} on hand${label} — DENY policy stops the sale`,
      });
    }

    if (num(v.price, 0) === 0) {
      out.push({ code: BLOCKER.ZERO_PRICE, severity: SEVERITY.WARNING, detail: `price is 0${label}` });
    }
  }
  return out;
}

/**
 * Is this a real customer order, or the operator's own test?
 *
 * Both lifetime orders on this store were placed from the owner's address and
 * refunded. Counting those as revenue would make every dashboard built on top
 * of this lie in the most flattering direction available, so they are
 * classified out explicitly rather than filtered somewhere downstream.
 */
export function classifyOrder(order, { staffEmails = [] } = {}) {
  if (!order || typeof order !== "object") return { real: false, reason: "malformed order" };

  const staff = staffEmails
    .filter((e) => typeof e === "string" && e.trim())
    .map((e) => e.trim().toLowerCase());
  const email = (order.customer && typeof order.customer.email === "string"
    ? order.customer.email
    : order.email || "").trim().toLowerCase();

  if (order.cancelledAt) return { real: false, reason: "cancelled" };
  if (email && staff.includes(email)) return { real: false, reason: "placed by staff — test order" };

  const fin = order.displayFinancialStatus;
  if (fin === "REFUNDED") return { real: false, reason: "fully refunded" };
  if (fin === "VOIDED") return { real: false, reason: "voided" };

  return { real: true, reason: fin === "PARTIALLY_REFUNDED" ? "partially refunded" : "paid" };
}

const DAY_MS = 86_400_000;

/**
 * Orders that are paid, real, and still unfulfilled — with age.
 *
 * This is the "nothing dropped" check. On a store doing two orders a year the
 * failure mode is not volume, it is that a single order arrives during a week
 * nobody is looking at Shopify and sits there.
 */
export function agingUnfulfilled(orders, now, { thresholdDays = 2, staffEmails = [] } = {}) {
  const cutoffMs = Math.max(0, num(thresholdDays, 2)) * DAY_MS;
  const out = [];

  for (const o of orders || []) {
    if (!classifyOrder(o, { staffEmails }).real) continue;
    if (o.displayFulfillmentStatus === "FULFILLED") continue;

    const placed = Date.parse(o.createdAt);
    // An unparseable date must not silently vanish from a "nothing dropped"
    // list. Age 0 keeps it in the data with an honest null age.
    const ageMs = Number.isFinite(placed) ? Math.max(0, now - placed) : 0;
    if (Number.isFinite(placed) && ageMs < cutoffMs) continue;

    out.push({
      id: o.id,
      name: o.name,
      createdAt: o.createdAt,
      ageDays: Number.isFinite(placed) ? Math.floor(ageMs / DAY_MS) : null,
      status: o.displayFulfillmentStatus || "UNKNOWN",
      totalUsd: num(o.totalPriceSet && o.totalPriceSet.shopMoney && o.totalPriceSet.shopMoney.amount, 0),
    });
  }
  return out.sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0));
}

/**
 * One pass's worth of order facts, split real vs test so no downstream reader
 * has to remember to do it.
 */
export function summarizeOrders(orders, { staffEmails = [] } = {}) {
  const list = orders || [];
  let real = 0, test = 0, refunded = 0, cancelled = 0, unfulfilled = 0;
  let realRevenueUsd = 0, grossUsd = 0;

  for (const o of list) {
    const amount = num(o && o.totalPriceSet && o.totalPriceSet.shopMoney && o.totalPriceSet.shopMoney.amount, 0);
    grossUsd += amount;

    if (o && o.cancelledAt) cancelled += 1;
    if (o && o.displayFinancialStatus === "REFUNDED") refunded += 1;

    const verdict = classifyOrder(o, { staffEmails });
    if (verdict.real) {
      real += 1;
      realRevenueUsd += amount;
      if (o.displayFulfillmentStatus !== "FULFILLED") unfulfilled += 1;
    } else {
      test += 1;
    }
  }

  return {
    total: list.length,
    real,
    test,
    refunded,
    cancelled,
    unfulfilled,
    // Rounded at the edge: these are money figures that get displayed, and
    // float drift across a summed list surfaces as $149.99999999 in the UI.
    realRevenueUsd: Math.round(realRevenueUsd * 100) / 100,
    grossUsd: Math.round(grossUsd * 100) / 100,
  };
}

/**
 * Fold a store read into the row that gets persisted, plus the findings worth
 * a human's attention. Pure, so the whole daily snapshot is testable without a
 * network or a database.
 */
export function buildSnapshot({ products = [], orders = [], now, staffEmails = [] } = {}) {
  const orderStats = summarizeOrders(orders, { staffEmails });
  const overdue = agingUnfulfilled(orders, now, { staffEmails });

  const blocked = [];
  for (const p of products) {
    const blockers = storefrontBlockers(p).filter((b) => b.severity === SEVERITY.BLOCKING);
    if (blockers.length) blocked.push({ id: p.id, title: p.title, blockers });
  }

  return {
    capturedAt: new Date(now).toISOString(),
    activeProducts: products.length,
    blockedProducts: blocked.length,
    orders: orderStats,
    findings: {
      // Ordered by what costs money soonest: a store that cannot sell outranks
      // an order that is late.
      storefrontBlocked: blocked,
      unfulfilled: overdue,
    },
  };
}

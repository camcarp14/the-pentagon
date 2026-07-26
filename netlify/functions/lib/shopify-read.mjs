// ═══════════════════════════════════════════════════════════════════════════
// SHOPIFY READ — the I/O half of store ingestion. Reads only. Never writes.
//
// Same split as ops-runtime.mjs: everything worth getting right lives in the
// pure @cc/ops/store module, and this file only fetches. Keeping it thin is
// deliberate.
//
// READ-ONLY IS ENFORCED, NOT DOCUMENTED. `adminGraphQL` refuses to send an
// operation containing a mutation. A comment saying "reads only" survives
// exactly until someone adds one convenient write; a throw does not. The one
// existing writer in this codebase (shopify-publish.js) keeps its own separate
// path and its own human-gated endpoint — nothing autonomous shares it.
//
// SCOPES. This needs read_orders and read_products on the Shopify custom app.
// The token that exists today has write_content (blog articles) and nothing
// else, so every call here fails with a 403 until those scopes are added. That
// failure is loud and named on purpose.
//
// WHAT THIS CANNOT SEE. Sessions, traffic sources, and conversion rate are NOT
// in the Admin API — they belong to Shopify's analytics surface, which a custom
// app token cannot reach. Any funnel numbers in this system came from an
// interactive analytics tool and cannot be ingested on a schedule. Nothing here
// pretends otherwise.
// ═══════════════════════════════════════════════════════════════════════════

// Overridable because Shopify retires API versions on a rolling ~12-month
// window, and a hard-coded one turns into a silent 400 long after it was
// written. Set SHOPIFY_API_VERSION when this default ages out.
const DEFAULT_API_VERSION = '2026-01';

// Well inside the 30-second scheduled-function budget, leaving room to still
// write the audit row and close the run after a slow upstream.
const TIMEOUT_MS = 10_000;

/** Env or a named throw. Never a null that reads as "fine". */
export function shopifyEnv() {
  const store = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  const missing = [!store && 'SHOPIFY_STORE', !token && 'SHOPIFY_ADMIN_TOKEN'].filter(Boolean);
  if (missing.length) {
    throw new Error(`SHOPIFY_ENV_MISSING: ${missing.join(', ')} — store ingestion stays off until set`);
  }
  // A bare handle ("zero-to-secure") and a full domain are both things a human
  // will paste into this var; normalise rather than 404 on the difference.
  const host = String(store).trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return {
    host: host.includes('.') ? host : `${host}.myshopify.com`,
    token: String(token).trim(),
    version: (process.env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION).trim(),
  };
}

// Matches a top-level `mutation` keyword. Deliberately crude: this is a
// tripwire, not a parser, and it errs toward refusing.
const MUTATION_RE = /(^|[\s{])mutation[\s({]/i;

/**
 * Execute a read query against the Admin GraphQL API.
 *
 * Throws named errors for every failure class rather than returning a shape the
 * caller has to remember to check. GraphQL is especially dangerous here: it
 * answers HTTP 200 with an `errors` array, so a naive `res.ok` check reports
 * success on a permission denial.
 */
export async function adminGraphQL(query, variables = {}, env = shopifyEnv()) {
  if (typeof query !== 'string' || !query.trim()) {
    throw new Error('SHOPIFY_QUERY_INVALID: empty query');
  }
  if (MUTATION_RE.test(query)) {
    throw new Error('SHOPIFY_WRITE_REFUSED: this adapter is read-only and will not send a mutation');
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`https://${env.host}/admin/api/${env.version}/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': env.token,
      },
      body: JSON.stringify({ query, variables }),
      signal: ctl.signal,
    });
  } catch (ex) {
    if (ex.name === 'AbortError') throw new Error(`SHOPIFY_TIMEOUT: no response in ${TIMEOUT_MS}ms`);
    throw new Error(`SHOPIFY_UNREACHABLE: ${ex.message}`);
  } finally {
    clearTimeout(timer);
  }

  // 401/403 is the expected state until read scopes are granted. Name it
  // precisely so the audit log says "scopes" and not "something went wrong".
  if (res.status === 401 || res.status === 403) {
    throw new Error(`SHOPIFY_FORBIDDEN: ${res.status} — token lacks read_orders/read_products scope`);
  }
  if (res.status === 429) throw new Error('SHOPIFY_RATE_LIMITED: 429 from Admin API');
  if (!res.ok) throw new Error(`SHOPIFY_HTTP_${res.status}: ${(await res.text()).slice(0, 300)}`);

  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error('SHOPIFY_BAD_JSON: response was not JSON');
  }

  if (Array.isArray(body.errors) && body.errors.length) {
    throw new Error(`SHOPIFY_GRAPHQL_ERROR: ${body.errors.map((e) => e.message).join('; ').slice(0, 300)}`);
  }
  if (!body.data) throw new Error('SHOPIFY_EMPTY_DATA: response carried no data');
  return body.data;
}

// The fields the pure store module reads, and nothing more. Asking for less
// keeps the query inside Shopify's cost budget and keeps customer PII out of a
// database that has no reason to hold it — only the email is fetched, and only
// because distinguishing a staff test order from a real one requires it.
const STORE_QUERY = `
  query PentagonStoreTruth($orderCount: Int!, $productCount: Int!) {
    products(first: $productCount, query: "status:active") {
      edges {
        node {
          id
          title
          status
          tracksInventory
          publishedAt
          onlineStoreUrl
          variants(first: 25) {
            edges {
              node {
                id
                title
                price
                availableForSale
                inventoryQuantity
                inventoryPolicy
                inventoryItem { tracked }
              }
            }
          }
        }
      }
    }
    orders(first: $orderCount, sortKey: CREATED_AT, reverse: true) {
      edges {
        node {
          id
          name
          createdAt
          displayFinancialStatus
          displayFulfillmentStatus
          cancelledAt
          totalPriceSet { shopMoney { amount currencyCode } }
          customer { email }
        }
      }
    }
  }
`;

/** One round trip for everything a pass needs. */
export async function fetchStoreTruth({ orderCount = 50, productCount = 50 } = {}, env = shopifyEnv()) {
  const data = await adminGraphQL(STORE_QUERY, { orderCount, productCount }, env);
  return {
    products: (data.products?.edges || []).map((e) => e.node).filter(Boolean),
    orders: (data.orders?.edges || []).map((e) => e.node).filter(Boolean),
  };
}

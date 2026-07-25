// Publishes an approved article to the Shopify blog.
// Env vars required (set in Netlify → Site configuration → Environment variables):
//   SHOPIFY_STORE       — e.g. "zero-to-secure.myshopify.com"
//   SHOPIFY_ADMIN_TOKEN — Admin API access token (from a custom app with write_content scope)
//   SHOPIFY_BLOG_ID     — the numeric blog id (Shopify admin → Online Store → Blog posts → check URL, or GET /admin/api/2024-01/blogs.json)

const { json, error, methodGuard } = require("./_shared/response.cjs");
const { requireAuth } = require("./_shared/requireAuth.cjs");

exports.handler = async (event) => {
  const guard = methodGuard(event, "POST");
  if (guard) return guard;

  // This endpoint publishes a LIVE, publicly-visible blog article using the
  // store's admin token. Every other operator function gates on the session;
  // this one did not, so an unauthenticated caller who knew the URL could post
  // arbitrary HTML to the storefront. Gate before touching Shopify.
  const auth = await requireAuth(event);
  if (!auth.ok) return error(auth.status, auth.error);

  const { SHOPIFY_STORE, SHOPIFY_ADMIN_TOKEN, SHOPIFY_BLOG_ID } = process.env;
  if (!SHOPIFY_STORE || !SHOPIFY_ADMIN_TOKEN || !SHOPIFY_BLOG_ID) {
    return error(500, "Missing SHOPIFY_STORE / SHOPIFY_ADMIN_TOKEN / SHOPIFY_BLOG_ID env vars");
  }

  try {
    const { title, body_html, summary, tags, handle } = JSON.parse(event.body || "{}");
    const res = await fetch(`https://${SHOPIFY_STORE}/admin/api/2024-01/blogs/${SHOPIFY_BLOG_ID}/articles.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": SHOPIFY_ADMIN_TOKEN },
      body: JSON.stringify({
        article: {
          title,
          body_html,
          summary_html: summary || "",
          tags: tags || "",
          handle: handle || undefined,
          published: true,
        },
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.article) {
      return error(502, JSON.stringify(data.errors || data));
    }
    const url = `https://${SHOPIFY_STORE.replace(".myshopify.com", "")}.com/blogs/news/${data.article.handle}`;
    return json(200, { success: true, id: data.article.id, handle: data.article.handle, url });
  } catch (e) {
    return error(500, e.message);
  }
};

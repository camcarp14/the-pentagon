// ─── Click tracking — GET /r/<link-uuid> ─────────────────────────────────────
// Looks the link up by its unguessable uuid through a narrowly scoped database
// RPC, records a click event (email_events: anon INSERT-only), and 302s to the real
// destination. The destination comes from OUR table, never from a query param,
// so there is no open-redirect surface. Tracking must never break the link:
// the event insert is best-effort; the redirect always happens if the link
// resolves.
const { sbRest, UUID_RE } = require("./_shared/supabaseRest.cjs");

exports.handler = async (event) => {
  const id = (event.path || "").split("/").filter(Boolean).pop() || "";
  if (!UUID_RE.test(id)) return { statusCode: 404, body: "Not found" };

  let link;
  try {
    const rows = await sbRest("/rpc/resolve_tracking_link", { method: "POST", body: { p_link_id: id } });
    link = rows && rows[0];
  } catch {
    link = null;
  }
  if (!link || !/^https?:\/\//i.test(link.url)) return { statusCode: 404, body: "Not found" };

  try {
    await sbRest(`/email_events`, {
      method: "POST",
      prefer: "return=minimal",
      body: {
        message_id: link.message_id,
        event_type: "click",
        url: link.url,
        user_agent: (event.headers && (event.headers["user-agent"] || event.headers["User-Agent"])) || null,
      },
    });
  } catch {
    // best-effort — never block the redirect on tracking
  }

  return {
    statusCode: 302,
    headers: { Location: link.url, "Cache-Control": "no-store" },
    body: "",
  };
};

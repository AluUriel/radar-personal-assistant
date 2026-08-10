import { updateInboxStatus } from "../../../../db/queries";
import { getRadarAuthorization } from "../../../lib/radar-auth";

const allowedStatuses = new Set(["open", "waiting", "resolved", "dismissed"] as const);

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const authorization = await getRadarAuthorization();
  if (!authorization.allowed) {
    return Response.json(
      { error: authorization.reason ?? "not-authorized" },
      { status: authorization.reason === "signin-required" ? 401 : 403 },
    );
  }

  const body = await request.json().catch(() => ({})) as { status?: string };
  if (!body.status || !allowedStatuses.has(body.status as never)) {
    return Response.json({ error: "Invalid status" }, { status: 400 });
  }

  const { id } = await context.params;
  const updated = await updateInboxStatus(id, body.status as "open" | "waiting" | "resolved" | "dismissed");
  if (!updated) return Response.json({ error: "Inbox item not found" }, { status: 404 });
  return Response.json({ item: updated }, { headers: { "cache-control": "private, no-store" } });
}

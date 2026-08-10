import { listOpenInbox } from "../../../db/queries";
import { getRadarAuthorization } from "../../lib/radar-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const authorization = await getRadarAuthorization();
  if (!authorization.allowed) {
    return Response.json(
      { error: authorization.reason ?? "not-authorized" },
      { status: authorization.reason === "signin-required" ? 401 : 403 },
    );
  }

  try {
    const items = await listOpenInbox();
    return Response.json(
      { mode: "live", synthetic: items.length > 0 && items.every((item) => item.externalId.startsWith("demo:")), items },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Database unavailable";
    const uninitialized = /no such table|inbox_items|D1 binding/i.test(message);
    return Response.json(
      { mode: "uninitialized", items: [], error: uninitialized ? "Radar storage is not initialized" : "Inbox unavailable" },
      { status: 503, headers: { "cache-control": "private, no-store" } },
    );
  }
}

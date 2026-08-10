import { listLatestSourceSyncs } from "../../../db/queries";
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
  const sources = await listLatestSourceSyncs();
  return Response.json({ sources }, { headers: { "cache-control": "private, no-store" } });
}

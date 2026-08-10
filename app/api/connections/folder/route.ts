import { proxyLocalSetup, sameOriginMutation } from "../../../lib/local-setup-proxy";
import { getRadarAuthorization } from "../../../lib/radar-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const authorization = await getRadarAuthorization();
  if (!authorization.allowed) return Response.json({ error: "not-authorized" }, { status: 403 });
  if (!await sameOriginMutation(request)) return Response.json({ error: "invalid-origin" }, { status: 403 });
  try {
    const response = await proxyLocalSetup("/folders/obsidian", { method: "POST", body: "{}" });
    return new Response(await response.text(), {
      status: response.status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" },
    });
  } catch {
    return Response.json({ error: "local-setup-unavailable" }, { status: 503 });
  }
}

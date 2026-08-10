import { proxyLocalSetup, sameOriginMutation } from "../../lib/local-setup-proxy";
import { getRadarAuthorization } from "../../lib/radar-auth";

export const dynamic = "force-dynamic";

async function authorized() {
  const authorization = await getRadarAuthorization();
  return authorization.allowed;
}

async function pass(response: Response) {
  return new Response(await response.text(), {
    status: response.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "private, no-store" },
  });
}

export async function GET() {
  if (!await authorized()) return Response.json({ error: "not-authorized" }, { status: 403 });
  try {
    return pass(await proxyLocalSetup("/connections"));
  } catch {
    return Response.json({ error: "local-setup-unavailable" }, { status: 503 });
  }
}

export async function PATCH(request: Request) {
  if (!await authorized()) return Response.json({ error: "not-authorized" }, { status: 403 });
  if (!await sameOriginMutation(request)) return Response.json({ error: "invalid-origin" }, { status: 403 });
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > 64 * 1024) return Response.json({ error: "request-too-large" }, { status: 413 });
  try {
    return pass(await proxyLocalSetup("/connections", { method: "PATCH", body }));
  } catch {
    return Response.json({ error: "local-setup-unavailable" }, { status: 503 });
  }
}

import { buildIntegrationReadiness } from "../../lib/readiness";
import { probeGeneratorHealth } from "../../lib/generator-health";
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

  const generatorRuntime = await probeGeneratorHealth(process.env.TEXT_GENERATOR_URL);
  return Response.json(
    { integrations: buildIntegrationReadiness(process.env), generatorRuntime },
    { headers: { "cache-control": "private, no-store" } },
  );
}

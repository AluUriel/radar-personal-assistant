import { initializeDatabase, seedSyntheticDemo } from "../../../../db/bootstrap";
import { getRadarAuthorization } from "../../../lib/radar-auth";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const authorization = await getRadarAuthorization();
  if (!authorization.allowed) {
    return Response.json(
      { error: authorization.reason ?? "not-authorized" },
      { status: authorization.reason === "signin-required" ? 401 : 403 },
    );
  }

  const payload = await request.json().catch(() => ({})) as { seedSyntheticDemo?: boolean };
  const initialized = await initializeDatabase();
  const seeded = payload.seedSyntheticDemo && authorization.user?.userId === "local-development"
    ? await seedSyntheticDemo()
    : null;
  return Response.json({ initialized, seeded }, { headers: { "cache-control": "private, no-store" } });
}

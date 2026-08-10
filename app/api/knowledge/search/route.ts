import { searchKnowledgeCandidates } from "../../../../db/queries";
import { getRadarAuthorization } from "../../../lib/radar-auth";
import { retrieveEvidence, type KnowledgeCandidate } from "../../../lib/retrieval";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const authorization = await getRadarAuthorization();
  if (!authorization.allowed) {
    return Response.json(
      { error: authorization.reason ?? "not-authorized" },
      { status: authorization.reason === "signin-required" ? 401 : 403 },
    );
  }

  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (query.length < 3 || query.length > 2_000) return Response.json({ error: "Query must contain between 3 and 2000 characters" }, { status: 400 });

  const rows = await searchKnowledgeCandidates(query);
  const candidates: KnowledgeCandidate[] = rows.map((row) => ({
    id: row.id,
    canonicalKey: row.canonicalKey,
    kind: row.kind,
    title: row.title,
    content: row.content,
    sourceUri: row.sourceUri ?? undefined,
    updatedAt: row.updatedAt,
  }));
  const evidence = retrieveEvidence(query, candidates, 8);
  return Response.json({ evidence, candidateCount: candidates.length }, { headers: { "cache-control": "private, no-store" } });
}

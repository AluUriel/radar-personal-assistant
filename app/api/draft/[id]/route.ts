import { getInboxDraftContext, saveDraftSuggestion, searchKnowledgeCandidates } from "../../../../db/queries";
import { getRadarAuthorization } from "../../../lib/radar-auth";
import { retrieveEvidence, type KnowledgeCandidate } from "../../../lib/retrieval";
import { buildTextOnlyEnvelope } from "../../../lib/safe-draft";
import { generateTextOnlyDraft } from "../../../lib/text-generator";

export const dynamic = "force-dynamic";

function evidenceForBrowser(document: ReturnType<typeof retrieveEvidence>[number]) {
  const normalized = document.content.replace(/\s+/g, " ").trim();
  const matchIndex = document.matchedTerms
    .map((term) => normalized.toLowerCase().indexOf(term.toLowerCase()))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? 0;
  const start = Math.max(0, matchIndex - 120);
  const excerpt = normalized.slice(start, start + 500);
  return {
    id: document.id,
    kind: document.kind,
    title: document.title,
    content: `${start ? "…" : ""}${excerpt}${start + excerpt.length < normalized.length ? "…" : ""}`,
    sourceUri: document.sourceUri ?? null,
  };
}

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const authorization = await getRadarAuthorization();
  if (!authorization.allowed) {
    return Response.json({ error: authorization.reason ?? "not-authorized" }, { status: authorization.reason === "signin-required" ? 401 : 403 });
  }

  const { id } = await context.params;
  const item = await getInboxDraftContext(id);
  if (!item) return Response.json({ error: "Inbox item not found" }, { status: 404 });
  const query = [item.title, item.requestSummary, ...item.messages.slice(-8).map((message) => message.content)].join("\n").slice(0, 20_000);
  const rows = await searchKnowledgeCandidates(query, 250);
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
  const browserEvidence = evidence.map(evidenceForBrowser);
  const envelope = buildTextOnlyEnvelope({
    request: item.requestSummary,
    conversation: item.messages.slice(-20).map((message) => ({ author: message.sender, body: message.content })),
    evidence: evidence.map((document) => ({ title: document.title, content: document.content, sourceUri: document.sourceUri })),
  });
  const generated = await generateTextOnlyDraft(envelope);
  if (!generated) {
    return Response.json({ error: "text-generator-disabled", evidence: browserEvidence, safetyVersion: envelope.safetyVersion }, { status: 503 });
  }

  const saved = await saveDraftSuggestion({
    id: crypto.randomUUID(),
    inboxItemId: item.id,
    body: generated.text,
    evidenceIds: evidence.map((document) => document.id),
    generator: generated.generator,
    safetyVersion: envelope.safetyVersion,
  });
  return Response.json({ draft: saved, evidence: browserEvidence }, { status: 201, headers: { "cache-control": "private, no-store" } });
}

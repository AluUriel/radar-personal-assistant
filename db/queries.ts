import { asc, desc, eq, inArray, like, notInArray, or } from "drizzle-orm";
import { extractTerms } from "../app/lib/retrieval";
import { getDb } from ".";
import { conversations, draftSuggestions, inboxItems, knowledgeDocuments, messages, sourceSyncRuns } from "./schema";

export async function listLatestSourceSyncs() {
  const rows = await getDb().select().from(sourceSyncRuns).orderBy(desc(sourceSyncRuns.completedAt)).limit(100);
  const latest = new Map<string, typeof rows[number]>();
  for (const row of rows) if (!latest.has(row.source)) latest.set(row.source, row);
  return [...latest.values()];
}

export async function listOpenInbox() {
  const db = getDb();
  const rows = await db
    .select({
      id: inboxItems.id,
      conversationId: inboxItems.conversationId,
      status: inboxItems.status,
      priority: inboxItems.priority,
      score: inboxItems.score,
      requestSummary: inboxItems.requestSummary,
      rationaleJson: inboxItems.rationaleJson,
      lastActivityAt: inboxItems.lastActivityAt,
      source: conversations.source,
      externalId: conversations.externalId,
      title: conversations.title,
      location: conversations.location,
      participantsJson: conversations.participantsJson,
      permalink: conversations.permalink,
    })
    .from(inboxItems)
    .innerJoin(conversations, eq(inboxItems.conversationId, conversations.id))
    .where(notInArray(inboxItems.status, ["resolved", "dismissed"]))
    .orderBy(desc(inboxItems.score), desc(inboxItems.lastActivityAt));

  const ids = rows.map((row) => row.conversationId);
  const messageRows = ids.length
    ? await db.select().from(messages)
      .where(inArray(messages.conversationId, ids))
      .orderBy(asc(messages.sentAt))
    : [];

  const inboxIds = rows.map((row) => row.id);
  const draftRows = inboxIds.length
    ? await db.select().from(draftSuggestions)
      .where(inArray(draftSuggestions.inboxItemId, inboxIds))
      .orderBy(desc(draftSuggestions.createdAt))
    : [];
  const latestDraftByItem = new Map<string, typeof draftRows[number]>();
  for (const draft of draftRows) {
    if (!latestDraftByItem.has(draft.inboxItemId)) latestDraftByItem.set(draft.inboxItemId, draft);
  }

  const evidenceIds = Array.from(new Set(draftRows.flatMap((draft) => parseJsonArray(draft.evidenceJson))));
  const evidenceRows = evidenceIds.length
    ? await db.select().from(knowledgeDocuments).where(inArray(knowledgeDocuments.id, evidenceIds))
    : [];
  const evidenceById = new Map(evidenceRows.map((document) => [document.id, document]));

  const byConversation = new Map<string, typeof messageRows>();
  for (const message of messageRows) {
    const current = byConversation.get(message.conversationId) ?? [];
    current.push(message);
    byConversation.set(message.conversationId, current);
  }

  return rows.map((row) => {
    const draft = latestDraftByItem.get(row.id);
    const evidence = draft ? parseJsonArray(draft.evidenceJson).flatMap((id) => {
      const document = evidenceById.get(id);
      return document ? [{
        id: document.id,
        kind: document.kind,
        title: document.title,
        content: document.content.slice(0, 500),
        sourceUri: document.sourceUri,
      }] : [];
    }) : [];
    return {
      ...row,
      participants: parseJsonArray(row.participantsJson),
      rationale: parseJsonArray(row.rationaleJson),
      messages: byConversation.get(row.conversationId) ?? [],
      draft: draft ? { id: draft.id, body: draft.body, generator: draft.generator, safetyVersion: draft.safetyVersion, evidence } : null,
    };
  });
}

export async function updateInboxStatus(id: string, status: "open" | "waiting" | "resolved" | "dismissed") {
  const db = getDb();
  const [updated] = await db.update(inboxItems).set({ status, updatedAt: new Date().toISOString() }).where(eq(inboxItems.id, id)).returning();
  return updated ?? null;
}

export async function searchKnowledgeCandidates(query: string, limit = 200) {
  const terms = extractTerms(query).slice(0, 8);
  if (!terms.length) return [];
  const predicate = or(...terms.flatMap((term) => [
    like(knowledgeDocuments.title, `%${term}%`),
    like(knowledgeDocuments.canonicalKey, `%${term}%`),
    like(knowledgeDocuments.content, `%${term}%`),
  ]));
  return getDb().select().from(knowledgeDocuments).where(predicate).orderBy(desc(knowledgeDocuments.updatedAt)).limit(Math.max(1, Math.min(limit, 500)));
}

export async function getInboxDraftContext(id: string) {
  const db = getDb();
  const [item] = await db
    .select({
      id: inboxItems.id,
      requestSummary: inboxItems.requestSummary,
      conversationId: inboxItems.conversationId,
      title: conversations.title,
      source: conversations.source,
      location: conversations.location,
    })
    .from(inboxItems)
    .innerJoin(conversations, eq(inboxItems.conversationId, conversations.id))
    .where(eq(inboxItems.id, id))
    .limit(1);
  if (!item) return null;
  const conversationMessages = await db.select().from(messages)
    .where(eq(messages.conversationId, item.conversationId))
    .orderBy(asc(messages.sentAt));
  return { ...item, messages: conversationMessages };
}

export async function saveDraftSuggestion({ id, inboxItemId, body, evidenceIds, generator, safetyVersion }: {
  id: string;
  inboxItemId: string;
  body: string;
  evidenceIds: string[];
  generator: string;
  safetyVersion: string;
}) {
  const [saved] = await getDb().insert(draftSuggestions).values({
    id,
    inboxItemId,
    body,
    evidenceJson: JSON.stringify(evidenceIds),
    generator,
    safetyVersion,
    createdAt: new Date().toISOString(),
  }).returning();
  return saved;
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

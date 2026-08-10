import { env } from "cloudflare:workers";
import { canIngest } from "../../../lib/ingest-auth";
import { buildConversationKnowledge } from "../../../lib/conversation-knowledge";
import { buildIssueHistoryKnowledge } from "../../../lib/issue-history";
import { isActionable, scoreTriage, type TriageSignals } from "../../../lib/triage";

export const dynamic = "force-dynamic";

type Source = "slack" | "gmail" | "discord" | "intercom";
interface IncomingMessage {
  id?: string;
  externalId?: string;
  sender?: string;
  senderIsOwner?: boolean;
  content?: string;
  sentAt?: string;
  contentHash?: string;
  deleted?: boolean;
}

interface IncomingConversation {
  id?: string;
  source?: Source;
  externalId?: string;
  title?: string;
  location?: string;
  participantNames?: string[];
  permalink?: string;
  updatedAt?: string;
  messages?: IncomingMessage[];
  request?: { summary?: string; signals?: TriageSignals; lastActivityAt?: string } | null;
}

interface IncomingBatch {
  syncRunId?: string;
  source?: Source;
  startedAt?: string;
  completedAt?: string;
  nextCursor?: string;
  coverage?: { complete?: boolean; detail?: string };
  conversations?: IncomingConversation[];
}

const allowedSources = new Set<Source>(["slack", "gmail", "discord", "intercom"]);

export async function POST(request: Request) {
  if (!(await canIngest(request))) return Response.json({ error: "Not authorized" }, { status: 401 });
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > 8_000_000) return Response.json({ error: "Batch is too large" }, { status: 413 });
  const payload = await request.json().catch(() => null) as IncomingBatch | null;
  const batchError = validateBatch(payload);
  if (batchError) return Response.json({ error: batchError }, { status: 400 });

  const batch = payload as Required<Pick<IncomingBatch, "syncRunId" | "source" | "startedAt" | "completedAt" | "coverage" | "conversations">> & IncomingBatch;
  const statements: D1PreparedStatement[] = [];
  let messageCount = 0;
  let actionableCount = 0;
  let knowledgeCount = 0;

  for (const conversation of batch.conversations) {
    const error = validateConversation(conversation, batch.source);
    if (error) return Response.json({ error }, { status: 400 });
    const valid = conversation as Required<Pick<IncomingConversation, "id" | "source" | "externalId" | "title" | "location" | "participantNames" | "updatedAt" | "messages">> & IncomingConversation;
    statements.push(env.DB.prepare(`
      INSERT INTO conversations (id, source, external_id, title, location, participants_json, permalink, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, external_id) DO UPDATE SET
        title=excluded.title,
        location=excluded.location,
        participants_json=excluded.participants_json,
        permalink=excluded.permalink,
        updated_at=excluded.updated_at
    `).bind(valid.id, valid.source, valid.externalId, valid.title, valid.location, JSON.stringify(valid.participantNames), valid.permalink?.slice(0, 2_000) || null, new Date(valid.updatedAt).toISOString()));

    for (const message of valid.messages) {
      const messageError = validateMessage(message);
      if (messageError) return Response.json({ error: messageError }, { status: 400 });
      const item = message as Required<Pick<IncomingMessage, "id" | "externalId" | "sender" | "content" | "sentAt" | "contentHash">> & IncomingMessage;
      statements.push(env.DB.prepare(`
        INSERT INTO messages (id, conversation_id, external_id, sender, sender_is_user, content, sent_at, content_hash, deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id, external_id) DO UPDATE SET
          sender=excluded.sender,
          sender_is_user=excluded.sender_is_user,
          content=excluded.content,
          sent_at=excluded.sent_at,
          content_hash=excluded.content_hash,
          deleted=excluded.deleted
      `).bind(item.id, valid.id, item.externalId, item.sender, item.senderIsOwner ? 1 : 0, item.content, new Date(item.sentAt).toISOString(), item.contentHash, item.deleted ? 1 : 0));
      messageCount += 1;
    }

    const knowledgeInput = {
      source: valid.source,
      externalId: valid.externalId,
      title: valid.title,
      location: valid.location,
      participantNames: valid.participantNames,
      permalink: valid.permalink,
      updatedAt: valid.updatedAt,
      messages: valid.messages.map((message) => ({
        sender: message.sender!,
        senderIsOwner: message.senderIsOwner,
        content: message.content!,
        sentAt: message.sentAt!,
        contentHash: message.contentHash!,
        deleted: message.deleted,
      })),
    };
    const knowledgeDocuments = [
      await buildConversationKnowledge(knowledgeInput),
      await buildIssueHistoryKnowledge({ ...knowledgeInput, request: valid.request }),
    ].filter((document) => document !== null);
    for (const knowledge of knowledgeDocuments) {
      statements.push(env.DB.prepare(`
        INSERT INTO knowledge_documents (id, canonical_key, kind, title, content, source_uri, content_hash, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(canonical_key) DO UPDATE SET
          title=excluded.title,
          content=excluded.content,
          source_uri=excluded.source_uri,
          content_hash=excluded.content_hash,
          updated_at=excluded.updated_at
      `).bind(
        knowledge.id,
        knowledge.canonicalKey,
        knowledge.kind,
        knowledge.title,
        knowledge.content,
        knowledge.sourceUri,
        knowledge.contentHash,
        knowledge.updatedAt,
      ));
      knowledgeCount += 1;
    }

    if (valid.request?.summary && valid.request.signals) {
      const triage = scoreTriage(valid.request.signals);
      const lastActivityAt = valid.request.lastActivityAt && !Number.isNaN(Date.parse(valid.request.lastActivityAt))
        ? new Date(valid.request.lastActivityAt).toISOString()
        : new Date(valid.updatedAt).toISOString();
      if (isActionable(valid.request.signals)) {
        actionableCount += 1;
        statements.push(env.DB.prepare(`
          INSERT INTO inbox_items (id, conversation_id, status, priority, score, request_summary, rationale_json, last_activity_at, updated_at)
          VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?)
          ON CONFLICT(conversation_id) DO UPDATE SET
            status=CASE WHEN inbox_items.status IN ('resolved', 'dismissed') THEN inbox_items.status ELSE 'open' END,
            priority=excluded.priority,
            score=excluded.score,
            request_summary=excluded.request_summary,
            rationale_json=excluded.rationale_json,
            last_activity_at=excluded.last_activity_at,
            updated_at=excluded.updated_at
        `).bind(`inbox:${valid.id}`, valid.id, triage.priority, triage.score, valid.request.summary.slice(0, 2_000), JSON.stringify(triage.positiveReasons), lastActivityAt, batch.completedAt));
      } else {
        const inactiveStatus = valid.request.signals.ownerAlreadyAnswered ? "resolved" : "dismissed";
        statements.push(env.DB.prepare("UPDATE inbox_items SET status=?, updated_at=? WHERE conversation_id=? AND status IN ('open', 'waiting')")
          .bind(inactiveStatus, batch.completedAt, valid.id));
      }
    }
  }

  statements.push(env.DB.prepare(`
    INSERT INTO source_sync_runs (id, source, status, coverage_complete, coverage_detail, cursor, conversations_count, messages_count, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      status=excluded.status,
      coverage_complete=excluded.coverage_complete,
      coverage_detail=excluded.coverage_detail,
      cursor=excluded.cursor,
      conversations_count=excluded.conversations_count,
      messages_count=excluded.messages_count,
      completed_at=excluded.completed_at
  `).bind(
    batch.syncRunId,
    batch.source,
    batch.coverage.complete ? "completed" : "partial",
    batch.coverage.complete ? 1 : 0,
    batch.coverage.detail?.slice(0, 2_000) || "No coverage detail supplied",
    batch.nextCursor?.slice(0, 2_000) || null,
    batch.conversations.length,
    messageCount,
    new Date(batch.startedAt).toISOString(),
    new Date(batch.completedAt).toISOString(),
  ));

  await env.DB.batch(statements);
  await env.DB.prepare("PRAGMA optimize").run();
  return Response.json({ upsertedConversations: batch.conversations.length, upsertedMessages: messageCount, upsertedKnowledge: knowledgeCount, actionable: actionableCount, coverageComplete: Boolean(batch.coverage.complete) }, { status: 202, headers: { "cache-control": "private, no-store" } });
}

function validateBatch(payload: IncomingBatch | null) {
  if (!payload) return "Invalid JSON payload";
  if (!payload.syncRunId || payload.syncRunId.length > 200) return "syncRunId is required";
  if (!payload.source || !allowedSources.has(payload.source)) return "Invalid source";
  if (!payload.startedAt || Number.isNaN(Date.parse(payload.startedAt))) return "Invalid startedAt";
  if (!payload.completedAt || Number.isNaN(Date.parse(payload.completedAt))) return "Invalid completedAt";
  if (!payload.coverage || typeof payload.coverage.complete !== "boolean" || !payload.coverage.detail) return "Coverage evidence is required";
  if (!Array.isArray(payload.conversations) || payload.conversations.length > 20) return "conversations must contain at most 20 records";
  return null;
}

function validateConversation(conversation: IncomingConversation, batchSource: Source) {
  if (!conversation.id || conversation.id.length > 300) return "Each conversation requires a bounded id";
  if (conversation.source !== batchSource) return "Conversation source must match batch source";
  if (!conversation.externalId || conversation.externalId.length > 500) return "Each conversation requires a bounded externalId";
  if (!conversation.title || conversation.title.length > 500) return "Each conversation requires a bounded title";
  if (!conversation.location || conversation.location.length > 500) return "Each conversation requires a bounded location";
  if (!Array.isArray(conversation.participantNames) || conversation.participantNames.length > 100) return "Invalid participants";
  if (!conversation.updatedAt || Number.isNaN(Date.parse(conversation.updatedAt))) return "Invalid conversation updatedAt";
  if (!Array.isArray(conversation.messages) || conversation.messages.length > 100) return "A conversation may contain at most 100 messages per batch";
  if (conversation.request?.summary && conversation.request.summary.length > 2_000) return "Request summary is too large";
  return null;
}

function validateMessage(message: IncomingMessage) {
  if (!message.id || message.id.length > 400) return "Each message requires a bounded id";
  if (!message.externalId || message.externalId.length > 500) return "Each message requires a bounded externalId";
  if (!message.sender || message.sender.length > 300) return "Each message requires a bounded sender";
  if (typeof message.content !== "string" || message.content.length > 100_000) return "Message content is too large";
  if (!message.sentAt || Number.isNaN(Date.parse(message.sentAt))) return "Invalid message sentAt";
  if (!message.contentHash || !/^[a-f0-9:]{8,200}$/i.test(message.contentHash)) return "Invalid message contentHash";
  return null;
}

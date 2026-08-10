import { env } from "cloudflare:workers";
import { demoItems } from "../app/data/demo";

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS conversations (
    id text PRIMARY KEY NOT NULL,
    source text NOT NULL,
    external_id text NOT NULL,
    title text NOT NULL,
    location text NOT NULL,
    participants_json text DEFAULT '[]' NOT NULL,
    permalink text,
    updated_at text NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_source_external ON conversations(source, external_id)",
  "CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at)",
  `CREATE TABLE IF NOT EXISTS messages (
    id text PRIMARY KEY NOT NULL,
    conversation_id text NOT NULL,
    external_id text NOT NULL,
    sender text NOT NULL,
    sender_is_user integer DEFAULT false NOT NULL,
    content text NOT NULL,
    sent_at text NOT NULL,
    content_hash text NOT NULL,
    deleted integer DEFAULT false NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE cascade
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_conversation_external ON messages(conversation_id, external_id)",
  "CREATE INDEX IF NOT EXISTS idx_messages_conversation_sent ON messages(conversation_id, sent_at)",
  `CREATE TABLE IF NOT EXISTS inbox_items (
    id text PRIMARY KEY NOT NULL,
    conversation_id text NOT NULL,
    status text DEFAULT 'open' NOT NULL,
    priority text NOT NULL,
    score integer NOT NULL,
    request_summary text NOT NULL,
    rationale_json text DEFAULT '[]' NOT NULL,
    last_activity_at text NOT NULL,
    updated_at text NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE cascade
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_conversation ON inbox_items(conversation_id)",
  "CREATE INDEX IF NOT EXISTS idx_inbox_status_priority_score ON inbox_items(status, priority, score)",
  `CREATE TABLE IF NOT EXISTS knowledge_documents (
    id text PRIMARY KEY NOT NULL,
    canonical_key text NOT NULL,
    kind text NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    source_uri text,
    content_hash text NOT NULL,
    updated_at text NOT NULL
  )`,
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_canonical_key ON knowledge_documents(canonical_key)",
  "CREATE INDEX IF NOT EXISTS idx_knowledge_kind_updated ON knowledge_documents(kind, updated_at)",
  `CREATE TABLE IF NOT EXISTS draft_suggestions (
    id text PRIMARY KEY NOT NULL,
    inbox_item_id text NOT NULL,
    body text NOT NULL,
    evidence_json text DEFAULT '[]' NOT NULL,
    generator text NOT NULL,
    safety_version text NOT NULL,
    created_at text NOT NULL,
    FOREIGN KEY (inbox_item_id) REFERENCES inbox_items(id) ON DELETE cascade
  )`,
  "CREATE INDEX IF NOT EXISTS idx_drafts_item_created ON draft_suggestions(inbox_item_id, created_at)",
  `CREATE TABLE IF NOT EXISTS source_sync_runs (
    id text PRIMARY KEY NOT NULL,
    source text NOT NULL,
    status text NOT NULL,
    coverage_complete integer DEFAULT false NOT NULL,
    coverage_detail text NOT NULL,
    cursor text,
    conversations_count integer DEFAULT 0 NOT NULL,
    messages_count integer DEFAULT 0 NOT NULL,
    started_at text NOT NULL,
    completed_at text NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_sync_runs_source_completed ON source_sync_runs(source, completed_at)",
];

export async function initializeDatabase() {
  await env.DB.batch(schemaStatements.map((statement) => env.DB.prepare(statement)));
  await env.DB.prepare("PRAGMA optimize").run();
  return { tables: 6, indexes: 10 };
}

export async function seedSyntheticDemo() {
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];

  for (const item of demoItems) {
    const conversationId = `demo:conversation:${item.id}`;
    const source = item.source === "Email" ? "gmail" : item.source.toLowerCase();
    statements.push(env.DB.prepare(`
      INSERT INTO conversations (id, source, external_id, title, location, participants_json, permalink, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
      ON CONFLICT(id) DO UPDATE SET external_id=excluded.external_id, title=excluded.title, location=excluded.location, updated_at=excluded.updated_at
    `).bind(conversationId, source, `demo:${item.id}`, item.title, item.location, JSON.stringify([item.sender]), now));

    for (const [index, message] of item.messages.entries()) {
      statements.push(env.DB.prepare(`
        INSERT INTO messages (id, conversation_id, external_id, sender, sender_is_user, content, sent_at, content_hash, deleted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT(id) DO UPDATE SET content=excluded.content, content_hash=excluded.content_hash
      `).bind(
        `demo:message:${item.id}:${index}`,
        conversationId,
        `${item.id}:${index}`,
        message.author,
        message.mine ? 1 : 0,
        message.body,
        new Date(Date.now() - (item.messages.length - index) * 60_000).toISOString(),
        `synthetic:${item.id}:${index}:${message.body.length}`,
      ));
    }

    const priority = item.priority === "Now" ? "now" : item.priority === "Today" ? "today" : "waiting";
    statements.push(env.DB.prepare(`
      INSERT INTO inbox_items (id, conversation_id, status, priority, score, request_summary, rationale_json, last_activity_at, updated_at)
      VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET priority=excluded.priority, score=excluded.score, request_summary=excluded.request_summary, rationale_json=excluded.rationale_json, updated_at=excluded.updated_at
    `).bind(`demo:inbox:${item.id}`, conversationId, priority, item.score, item.ask, JSON.stringify(item.why), now, now));

    const evidenceIds: string[] = [];
    for (const [index, evidence] of item.evidence.entries()) {
      const evidenceId = `demo:knowledge:${item.id}:${index}`;
      evidenceIds.push(evidenceId);
      const kind = evidence.kind === "conversation" ? "conversation" : evidence.kind;
      statements.push(env.DB.prepare(`
        INSERT INTO knowledge_documents (id, canonical_key, kind, title, content, source_uri, content_hash, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, content=excluded.content, content_hash=excluded.content_hash, updated_at=excluded.updated_at
      `).bind(evidenceId, evidenceId, kind, evidence.title, evidence.detail, `synthetic:${item.id}`, `synthetic:${evidence.detail.length}`, now));
    }

    statements.push(env.DB.prepare(`
      INSERT INTO draft_suggestions (id, inbox_item_id, body, evidence_json, generator, safety_version, created_at)
      VALUES (?, ?, ?, ?, 'synthetic-demo', '2026-08-10.v1', ?)
      ON CONFLICT(id) DO UPDATE SET body=excluded.body, evidence_json=excluded.evidence_json, created_at=excluded.created_at
    `).bind(`demo:draft:${item.id}`, `demo:inbox:${item.id}`, item.suggestion, JSON.stringify(evidenceIds), now));
  }

  await env.DB.batch(statements);
  await env.DB.prepare("PRAGMA optimize").run();
  return { conversations: demoItems.length, synthetic: true };
}

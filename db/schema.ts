import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const conversations = sqliteTable("conversations", {
  id: text("id").primaryKey(),
  source: text("source", { enum: ["slack", "gmail", "discord", "intercom", "obsidian"] }).notNull(),
  externalId: text("external_id").notNull(),
  title: text("title").notNull(),
  location: text("location").notNull(),
  participantsJson: text("participants_json").notNull().default("[]"),
  permalink: text("permalink"),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("idx_conversations_source_external").on(table.source, table.externalId),
  index("idx_conversations_updated").on(table.updatedAt),
]);

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  externalId: text("external_id").notNull(),
  sender: text("sender").notNull(),
  senderIsUser: integer("sender_is_user", { mode: "boolean" }).notNull().default(false),
  content: text("content").notNull(),
  sentAt: text("sent_at").notNull(),
  contentHash: text("content_hash").notNull(),
  deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
}, (table) => [
  uniqueIndex("idx_messages_conversation_external").on(table.conversationId, table.externalId),
  index("idx_messages_conversation_sent").on(table.conversationId, table.sentAt),
]);

export const inboxItems = sqliteTable("inbox_items", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["open", "waiting", "resolved", "dismissed"] }).notNull().default("open"),
  priority: text("priority", { enum: ["now", "today", "waiting"] }).notNull(),
  score: integer("score").notNull(),
  requestSummary: text("request_summary").notNull(),
  rationaleJson: text("rationale_json").notNull().default("[]"),
  lastActivityAt: text("last_activity_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("idx_inbox_conversation").on(table.conversationId),
  index("idx_inbox_status_priority_score").on(table.status, table.priority, table.score),
]);

export const knowledgeDocuments = sqliteTable("knowledge_documents", {
  id: text("id").primaryKey(),
  canonicalKey: text("canonical_key").notNull(),
  kind: text("kind", { enum: ["issue", "decision", "runbook", "conversation", "person", "project", "note"] }).notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  sourceUri: text("source_uri"),
  contentHash: text("content_hash").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [
  uniqueIndex("idx_knowledge_canonical_key").on(table.canonicalKey),
  index("idx_knowledge_kind_updated").on(table.kind, table.updatedAt),
]);

export const draftSuggestions = sqliteTable("draft_suggestions", {
  id: text("id").primaryKey(),
  inboxItemId: text("inbox_item_id").notNull().references(() => inboxItems.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  evidenceJson: text("evidence_json").notNull().default("[]"),
  generator: text("generator").notNull(),
  safetyVersion: text("safety_version").notNull(),
  createdAt: text("created_at").notNull(),
}, (table) => [index("idx_drafts_item_created").on(table.inboxItemId, table.createdAt)]);

export const sourceSyncRuns = sqliteTable("source_sync_runs", {
  id: text("id").primaryKey(),
  source: text("source", { enum: ["slack", "gmail", "discord", "intercom"] }).notNull(),
  status: text("status", { enum: ["completed", "partial", "failed"] }).notNull(),
  coverageComplete: integer("coverage_complete", { mode: "boolean" }).notNull().default(false),
  coverageDetail: text("coverage_detail").notNull(),
  cursor: text("cursor"),
  conversationsCount: integer("conversations_count").notNull().default(0),
  messagesCount: integer("messages_count").notNull().default(0),
  startedAt: text("started_at").notNull(),
  completedAt: text("completed_at").notNull(),
}, (table) => [index("idx_sync_runs_source_completed").on(table.source, table.completedAt)]);

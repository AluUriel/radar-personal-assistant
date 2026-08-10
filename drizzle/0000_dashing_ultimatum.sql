CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`external_id` text NOT NULL,
	`title` text NOT NULL,
	`location` text NOT NULL,
	`participants_json` text DEFAULT '[]' NOT NULL,
	`permalink` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_conversations_source_external` ON `conversations` (`source`,`external_id`);--> statement-breakpoint
CREATE INDEX `idx_conversations_updated` ON `conversations` (`updated_at`);--> statement-breakpoint
CREATE TABLE `draft_suggestions` (
	`id` text PRIMARY KEY NOT NULL,
	`inbox_item_id` text NOT NULL,
	`body` text NOT NULL,
	`evidence_json` text DEFAULT '[]' NOT NULL,
	`generator` text NOT NULL,
	`safety_version` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`inbox_item_id`) REFERENCES `inbox_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_drafts_item_created` ON `draft_suggestions` (`inbox_item_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `inbox_items` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`priority` text NOT NULL,
	`score` integer NOT NULL,
	`request_summary` text NOT NULL,
	`rationale_json` text DEFAULT '[]' NOT NULL,
	`last_activity_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_inbox_conversation` ON `inbox_items` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `idx_inbox_status_priority_score` ON `inbox_items` (`status`,`priority`,`score`);--> statement-breakpoint
CREATE TABLE `knowledge_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`canonical_key` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`source_uri` text,
	`content_hash` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_knowledge_canonical_key` ON `knowledge_documents` (`canonical_key`);--> statement-breakpoint
CREATE INDEX `idx_knowledge_kind_updated` ON `knowledge_documents` (`kind`,`updated_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`external_id` text NOT NULL,
	`sender` text NOT NULL,
	`sender_is_user` integer DEFAULT false NOT NULL,
	`content` text NOT NULL,
	`sent_at` text NOT NULL,
	`content_hash` text NOT NULL,
	`deleted` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_messages_conversation_external` ON `messages` (`conversation_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_conversation_sent` ON `messages` (`conversation_id`,`sent_at`);
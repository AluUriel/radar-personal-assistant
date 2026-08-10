CREATE TABLE `source_sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`status` text NOT NULL,
	`coverage_complete` integer DEFAULT false NOT NULL,
	`coverage_detail` text NOT NULL,
	`cursor` text,
	`conversations_count` integer DEFAULT 0 NOT NULL,
	`messages_count` integer DEFAULT 0 NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sync_runs_source_completed` ON `source_sync_runs` (`source`,`completed_at`);
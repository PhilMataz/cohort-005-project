ALTER TABLE `enrollments` ADD `ended_at` text;--> statement-breakpoint
ALTER TABLE `refunds` ADD `decision_reason` text;--> statement-breakpoint
ALTER TABLE `refunds` ADD `lessons_completed_at_request` integer;--> statement-breakpoint
ALTER TABLE `refunds` ADD `seconds_watched_at_request` real;
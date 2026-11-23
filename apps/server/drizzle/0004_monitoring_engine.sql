ALTER TABLE "monitor_checks" DROP CONSTRAINT "monitor_checks_failure_reason_valid";--> statement-breakpoint
ALTER TABLE "monitor_checks" ADD COLUMN "source" varchar(10) DEFAULT 'SCHEDULED' NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor_checks" ADD COLUMN "attempt_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "manual_check_requested_at" timestamp (3) with time zone;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "last_manual_check_at" timestamp (3) with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "monitor_checks_attempt_id_uq" ON "monitor_checks" USING btree ("attempt_id");--> statement-breakpoint
CREATE INDEX "monitor_checks_monitor_source_checked_idx" ON "monitor_checks" USING btree ("monitor_id","source","checked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "monitors_manual_queue_idx" ON "monitors" USING btree ("manual_check_requested_at") WHERE "monitors"."manual_check_requested_at" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "monitor_checks" ADD CONSTRAINT "monitor_checks_source_valid" CHECK ("monitor_checks"."source" IN ('SCHEDULED', 'MANUAL'));--> statement-breakpoint
ALTER TABLE "monitor_checks" ADD CONSTRAINT "monitor_checks_failure_reason_valid" CHECK ("monitor_checks"."failure_reason" IS NULL OR "monitor_checks"."failure_reason" IN ('UNEXPECTED_STATUS', 'TIMEOUT', 'DNS_ERROR', 'CONNECTION_ERROR', 'TLS_ERROR', 'BLOCKED_DESTINATION', 'REQUEST_ERROR', 'CONFIGURATION_ERROR'));--> statement-breakpoint
-- Leases taken before lease tokens existed cannot be verified; drop them so the pair constraint holds.
UPDATE "monitors" SET "lease_until" = NULL WHERE "lease_token" IS NULL;--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_lease_complete" CHECK (("monitors"."lease_until" IS NULL) = ("monitors"."lease_token" IS NULL));

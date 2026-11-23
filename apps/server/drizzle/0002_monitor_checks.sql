CREATE TABLE "monitor_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"monitor_id" uuid NOT NULL,
	"checked_at" timestamp (3) with time zone NOT NULL,
	"outcome" varchar(10) NOT NULL,
	"status_code" integer,
	"latency_ms" integer,
	"failure_reason" varchar(30),
	"error_message" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitor_checks_outcome_valid" CHECK ("monitor_checks"."outcome" IN ('SUCCESS', 'DEGRADED', 'FAILURE')),
	CONSTRAINT "monitor_checks_failure_reason_valid" CHECK ("monitor_checks"."failure_reason" IS NULL OR "monitor_checks"."failure_reason" IN ('UNEXPECTED_STATUS', 'TIMEOUT', 'DNS_ERROR', 'CONNECTION_ERROR', 'TLS_ERROR', 'BLOCKED_DESTINATION', 'REQUEST_ERROR')),
	CONSTRAINT "monitor_checks_reason_matches_outcome" CHECK (("monitor_checks"."outcome" = 'FAILURE') = ("monitor_checks"."failure_reason" IS NOT NULL)),
	CONSTRAINT "monitor_checks_latency_requires_response" CHECK (("monitor_checks"."status_code" IS NULL) = ("monitor_checks"."latency_ms" IS NULL)),
	CONSTRAINT "monitor_checks_response_matches_reason" CHECK (("monitor_checks"."status_code" IS NOT NULL) = ("monitor_checks"."failure_reason" IS NULL OR "monitor_checks"."failure_reason" = 'UNEXPECTED_STATUS')),
	CONSTRAINT "monitor_checks_status_code_range" CHECK ("monitor_checks"."status_code" IS NULL OR "monitor_checks"."status_code" BETWEEN 100 AND 599),
	CONSTRAINT "monitor_checks_latency_non_negative" CHECK ("monitor_checks"."latency_ms" IS NULL OR "monitor_checks"."latency_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "monitor_checks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "monitors" ADD COLUMN "status_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "monitor_checks" ADD CONSTRAINT "monitor_checks_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "monitor_checks_monitor_checked_idx" ON "monitor_checks" USING btree ("monitor_id","checked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "monitor_checks_checked_at_idx" ON "monitor_checks" USING btree ("checked_at");
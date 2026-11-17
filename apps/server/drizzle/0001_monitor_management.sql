CREATE TABLE "monitor_headers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"monitor_id" uuid NOT NULL,
	"header_name" varchar(100) NOT NULL,
	"value_ciphertext" text NOT NULL,
	"value_iv" text NOT NULL,
	"value_auth_tag" text NOT NULL,
	"encryption_key_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitor_headers_name_not_blank" CHECK (char_length("monitor_headers"."header_name") > 0),
	CONSTRAINT "monitor_headers_key_version_positive" CHECK ("monitor_headers"."encryption_key_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "monitor_headers" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "monitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"url" varchar(2048) NOT NULL,
	"method" varchar(10) NOT NULL,
	"expected_status_code" integer NOT NULL,
	"timeout_ms" integer NOT NULL,
	"latency_threshold_ms" integer NOT NULL,
	"check_interval_seconds" integer NOT NULL,
	"request_body_ciphertext" text,
	"request_body_iv" text,
	"request_body_auth_tag" text,
	"request_body_key_version" integer,
	"body_content_type" varchar(150),
	"enabled" boolean DEFAULT true NOT NULL,
	"current_status" varchar(20) DEFAULT 'UNKNOWN' NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"consecutive_successes" integer DEFAULT 0 NOT NULL,
	"last_checked_at" timestamp with time zone,
	"next_check_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitors_name_not_blank" CHECK (char_length(btrim("monitors"."name")) > 0),
	CONSTRAINT "monitors_description_length" CHECK ("monitors"."description" IS NULL OR char_length("monitors"."description") <= 500),
	CONSTRAINT "monitors_method_valid" CHECK ("monitors"."method" IN ('GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH')),
	CONSTRAINT "monitors_status_valid" CHECK ("monitors"."current_status" IN ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'DOWN')),
	CONSTRAINT "monitors_expected_status_range" CHECK ("monitors"."expected_status_code" BETWEEN 100 AND 599),
	CONSTRAINT "monitors_timeout_range" CHECK ("monitors"."timeout_ms" BETWEEN 1000 AND 30000),
	CONSTRAINT "monitors_latency_threshold_range" CHECK ("monitors"."latency_threshold_ms" BETWEEN 1 AND "monitors"."timeout_ms"),
	CONSTRAINT "monitors_interval_range" CHECK ("monitors"."check_interval_seconds" BETWEEN 60 AND 86400),
	CONSTRAINT "monitors_request_body_complete" CHECK (num_nonnulls("monitors"."request_body_ciphertext", "monitors"."request_body_iv", "monitors"."request_body_auth_tag", "monitors"."request_body_key_version") IN (0, 4)),
	CONSTRAINT "monitors_body_method" CHECK ("monitors"."request_body_ciphertext" IS NULL OR "monitors"."method" IN ('POST', 'PUT', 'PATCH')),
	CONSTRAINT "monitors_body_content_type" CHECK ("monitors"."body_content_type" IS NULL OR "monitors"."request_body_ciphertext" IS NOT NULL),
	CONSTRAINT "monitors_counters_non_negative" CHECK ("monitors"."consecutive_failures" >= 0 AND "monitors"."consecutive_successes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "monitors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "monitor_headers" ADD CONSTRAINT "monitor_headers_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitors" ADD CONSTRAINT "monitors_owner_id_profiles_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "monitor_headers_monitor_name_uq" ON "monitor_headers" USING btree ("monitor_id",lower("header_name"));--> statement-breakpoint
CREATE INDEX "monitors_owner_id_idx" ON "monitors" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "monitors_owner_created_idx" ON "monitors" USING btree ("owner_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "monitors_due_idx" ON "monitors" USING btree ("enabled","next_check_at") WHERE "monitors"."enabled" = true;
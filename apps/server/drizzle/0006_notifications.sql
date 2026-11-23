CREATE TABLE "monitor_notification_settings" (
	"monitor_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"email_enabled" boolean DEFAULT false NOT NULL,
	"webhook_enabled" boolean DEFAULT false NOT NULL,
	"webhook_url" varchar(2048),
	"webhook_secret_ciphertext" text,
	"webhook_secret_iv" text,
	"webhook_secret_auth_tag" text,
	"webhook_secret_key_version" integer,
	"webhook_header_name" varchar(100),
	"webhook_header_ciphertext" text,
	"webhook_header_iv" text,
	"webhook_header_auth_tag" text,
	"webhook_header_key_version" integer,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitor_notification_settings_webhook_complete" CHECK (num_nonnulls("monitor_notification_settings"."webhook_url", "monitor_notification_settings"."webhook_secret_ciphertext", "monitor_notification_settings"."webhook_secret_iv", "monitor_notification_settings"."webhook_secret_auth_tag", "monitor_notification_settings"."webhook_secret_key_version") IN (0, 5)),
	CONSTRAINT "monitor_notification_settings_webhook_enabled_configured" CHECK (NOT "monitor_notification_settings"."webhook_enabled" OR "monitor_notification_settings"."webhook_url" IS NOT NULL),
	CONSTRAINT "monitor_notification_settings_header_complete" CHECK (num_nonnulls("monitor_notification_settings"."webhook_header_name", "monitor_notification_settings"."webhook_header_ciphertext", "monitor_notification_settings"."webhook_header_iv", "monitor_notification_settings"."webhook_header_auth_tag", "monitor_notification_settings"."webhook_header_key_version") IN (0, 5)),
	CONSTRAINT "monitor_notification_settings_header_needs_webhook" CHECK ("monitor_notification_settings"."webhook_header_name" IS NULL OR "monitor_notification_settings"."webhook_url" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "monitor_notification_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notification_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delivery_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"started_at" timestamp (3) with time zone NOT NULL,
	"finished_at" timestamp (3) with time zone NOT NULL,
	"outcome" varchar(20) NOT NULL,
	"http_status" integer,
	"error" varchar(500),
	CONSTRAINT "notification_attempts_outcome_valid" CHECK ("notification_attempts"."outcome" IN ('SUCCESS', 'TEMPORARY_FAILURE', 'PERMANENT_FAILURE'))
);
--> statement-breakpoint
ALTER TABLE "notification_attempts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event_type" varchar(30) NOT NULL,
	"channel" varchar(10) NOT NULL,
	"payload" jsonb NOT NULL,
	"destination" varchar(300) NOT NULL,
	"status" varchar(12) DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"next_attempt_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp (3) with time zone,
	"lease_token" uuid,
	"last_attempted_at" timestamp (3) with time zone,
	"delivered_at" timestamp (3) with time zone,
	"last_error" varchar(500),
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_deliveries_event_type_valid" CHECK ("notification_deliveries"."event_type" IN ('INCIDENT_CREATED', 'INCIDENT_RESOLVED')),
	CONSTRAINT "notification_deliveries_channel_valid" CHECK ("notification_deliveries"."channel" IN ('EMAIL', 'WEBHOOK')),
	CONSTRAINT "notification_deliveries_status_valid" CHECK ("notification_deliveries"."status" IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED')),
	CONSTRAINT "notification_deliveries_attempts_bounds" CHECK ("notification_deliveries"."attempts" >= 0 AND "notification_deliveries"."max_attempts" >= 1),
	CONSTRAINT "notification_deliveries_lease_complete" CHECK (("notification_deliveries"."lease_until" IS NULL) = ("notification_deliveries"."lease_token" IS NULL)),
	CONSTRAINT "notification_deliveries_processing_leased" CHECK (("notification_deliveries"."status" = 'PROCESSING') = ("notification_deliveries"."lease_token" IS NOT NULL)),
	CONSTRAINT "notification_deliveries_sent_consistent" CHECK (("notification_deliveries"."status" = 'SENT') = ("notification_deliveries"."delivered_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "monitor_notification_settings" ADD CONSTRAINT "monitor_notification_settings_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitor_notification_settings" ADD CONSTRAINT "monitor_notification_settings_owner_id_profiles_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_attempts" ADD CONSTRAINT "notification_attempts_delivery_id_notification_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."notification_deliveries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_owner_id_profiles_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_attempts_delivery_number_uq" ON "notification_attempts" USING btree ("delivery_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_event_channel_uq" ON "notification_deliveries" USING btree ("event_id","channel");--> statement-breakpoint
CREATE INDEX "notification_deliveries_due_idx" ON "notification_deliveries" USING btree ("next_attempt_at") WHERE "notification_deliveries"."status" = 'PENDING';--> statement-breakpoint
CREATE INDEX "notification_deliveries_processing_idx" ON "notification_deliveries" USING btree ("lease_until") WHERE "notification_deliveries"."status" = 'PROCESSING';--> statement-breakpoint
CREATE INDEX "notification_deliveries_owner_created_idx" ON "notification_deliveries" USING btree ("owner_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notification_deliveries_incident_idx" ON "notification_deliveries" USING btree ("incident_id");
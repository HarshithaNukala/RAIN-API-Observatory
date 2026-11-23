CREATE TABLE "incident_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"event_type" varchar(30) NOT NULL,
	"actor_id" uuid,
	"occurred_at" timestamp (3) with time zone NOT NULL,
	"description" varchar(500) NOT NULL,
	"check_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incident_events_type_valid" CHECK ("incident_events"."event_type" IN ('INCIDENT_CREATED', 'INCIDENT_ACKNOWLEDGED', 'INCIDENT_RESOLVED', 'INCIDENT_UPDATED'))
);
--> statement-breakpoint
ALTER TABLE "incident_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"monitor_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text,
	"severity" varchar(10) DEFAULT 'HIGH' NOT NULL,
	"status" varchar(15) DEFAULT 'OPEN' NOT NULL,
	"started_at" timestamp (3) with time zone NOT NULL,
	"acknowledged_at" timestamp (3) with time zone,
	"acknowledged_by" uuid,
	"resolved_at" timestamp (3) with time zone,
	"trigger_check_id" uuid,
	"resolved_by_check_id" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incidents_status_valid" CHECK ("incidents"."status" IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
	CONSTRAINT "incidents_severity_valid" CHECK ("incidents"."severity" IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
	CONSTRAINT "incidents_title_not_blank" CHECK (char_length(btrim("incidents"."title")) > 0),
	CONSTRAINT "incidents_description_length" CHECK ("incidents"."description" IS NULL OR char_length("incidents"."description") <= 2000),
	CONSTRAINT "incidents_acknowledged_consistent" CHECK (("incidents"."status" = 'ACKNOWLEDGED') <= ("incidents"."acknowledged_at" IS NOT NULL)),
	CONSTRAINT "incidents_resolved_consistent" CHECK (("incidents"."status" = 'RESOLVED') = ("incidents"."resolved_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "incidents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_actor_id_profiles_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_owner_id_profiles_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_acknowledged_by_profiles_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incident_events_incident_occurred_idx" ON "incident_events" USING btree ("incident_id","occurred_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "incident_events_check_once_uq" ON "incident_events" USING btree ("incident_id","event_type","check_id") WHERE "incident_events"."check_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_one_active_per_monitor_uq" ON "incidents" USING btree ("monitor_id") WHERE "incidents"."status" <> 'RESOLVED';--> statement-breakpoint
CREATE INDEX "incidents_owner_started_idx" ON "incidents" USING btree ("owner_id","started_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "incidents_owner_status_idx" ON "incidents" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "incidents_monitor_started_idx" ON "incidents" USING btree ("monitor_id","started_at" DESC NULLS LAST);--> statement-breakpoint
-- The incident timeline is a permanent record: rows may be inserted (and removed with their
-- incident by cascade) but never changed, whoever is connected.
CREATE FUNCTION "incident_events_reject_update"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'incident_events rows are append-only' USING ERRCODE = 'restrict_violation';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "incident_events_append_only"
  BEFORE UPDATE ON "incident_events"
  FOR EACH ROW EXECUTE FUNCTION "incident_events_reject_update"();

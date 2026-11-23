CREATE TABLE "status_page_monitors" (
	"status_page_id" uuid NOT NULL,
	"monitor_id" uuid NOT NULL,
	"display_name" varchar(100) NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_page_monitors_status_page_id_monitor_id_pk" PRIMARY KEY("status_page_id","monitor_id"),
	CONSTRAINT "status_page_monitors_position_non_negative" CHECK ("status_page_monitors"."position" >= 0),
	CONSTRAINT "status_page_monitors_display_name_not_blank" CHECK (char_length(btrim("status_page_monitors"."display_name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "status_page_monitors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "status_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" varchar(120) NOT NULL,
	"description" text,
	"slug" varchar(64) NOT NULL,
	"published" boolean DEFAULT false NOT NULL,
	"published_at" timestamp (3) with time zone,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_pages_slug_format" CHECK ("status_pages"."slug" ~ '^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){1,62}[a-z0-9]$'),
	CONSTRAINT "status_pages_title_not_blank" CHECK (char_length(btrim("status_pages"."title")) > 0),
	CONSTRAINT "status_pages_description_length" CHECK ("status_pages"."description" IS NULL OR char_length("status_pages"."description") <= 1000),
	CONSTRAINT "status_pages_published_consistent" CHECK (NOT "status_pages"."published" OR "status_pages"."published_at" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "status_pages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "status_page_monitors" ADD CONSTRAINT "status_page_monitors_status_page_id_status_pages_id_fk" FOREIGN KEY ("status_page_id") REFERENCES "public"."status_pages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_page_monitors" ADD CONSTRAINT "status_page_monitors_monitor_id_monitors_id_fk" FOREIGN KEY ("monitor_id") REFERENCES "public"."monitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "status_pages" ADD CONSTRAINT "status_pages_owner_id_profiles_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "status_page_monitors_page_position_idx" ON "status_page_monitors" USING btree ("status_page_id","position");--> statement-breakpoint
CREATE INDEX "status_page_monitors_monitor_idx" ON "status_page_monitors" USING btree ("monitor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "status_pages_slug_uq" ON "status_pages" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "status_pages_owner_created_idx" ON "status_pages" USING btree ("owner_id","created_at" DESC NULLS LAST);--> statement-breakpoint
-- A status page may only show its owner's monitors. The API checks this; the trigger makes it a
-- database rule too, for every insert and every update of the pair.
CREATE FUNCTION "status_page_monitors_same_owner"() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "status_pages" sp
    JOIN "monitors" m ON m."id" = NEW."monitor_id"
    WHERE sp."id" = NEW."status_page_id" AND m."owner_id" = sp."owner_id"
  ) THEN
    RAISE EXCEPTION 'monitor and status page must have the same owner'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "status_page_monitors_same_owner"
  BEFORE INSERT OR UPDATE OF "status_page_id", "monitor_id" ON "status_page_monitors"
  FOR EACH ROW EXECUTE FUNCTION "status_page_monitors_same_owner"();

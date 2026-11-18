CREATE TABLE "institutions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"aliases" text[] DEFAULT '{}'::text[] NOT NULL,
	"country" text,
	"departments" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"merged_into_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "institutions_status_check" CHECK ("institutions"."status" in ('active', 'retired'))
);
--> statement-breakpoint
CREATE TABLE "research_areas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"group_label" text,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "research_areas_status_check" CHECK ("research_areas"."status" in ('active', 'retired')),
	CONSTRAINT "research_areas_level_check" CHECK (("research_areas"."parent_id" is null) = ("research_areas"."group_label" is not null))
);
--> statement-breakpoint
CREATE TABLE "societies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"acronym" text NOT NULL,
	"url" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "societies_status_check" CHECK ("societies"."status" in ('active', 'inactive'))
);
--> statement-breakpoint
ALTER TABLE "institutions" ADD CONSTRAINT "institutions_merged_into_id_institutions_id_fk" FOREIGN KEY ("merged_into_id") REFERENCES "public"."institutions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "institutions" ADD CONSTRAINT "institutions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_areas" ADD CONSTRAINT "research_areas_parent_id_research_areas_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."research_areas"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "research_areas" ADD CONSTRAINT "research_areas_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "societies" ADD CONSTRAINT "societies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "institutions_key_unique" ON "institutions" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "institutions_name_unique" ON "institutions" USING btree (lower("name"));--> statement-breakpoint
CREATE INDEX "research_areas_parent_idx" ON "research_areas" USING btree ("parent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "research_areas_name_unique" ON "research_areas" USING btree (coalesce("parent_id", '00000000-0000-0000-0000-000000000000'::uuid),lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "societies_key_unique" ON "societies" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "societies_acronym_unique" ON "societies" USING btree (lower("acronym"));
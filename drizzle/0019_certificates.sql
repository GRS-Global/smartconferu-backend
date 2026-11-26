CREATE TABLE "certificate_designs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conference_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type_key" text NOT NULL,
	"design" jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "certificate_distributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conference_id" uuid NOT NULL,
	"design_id" uuid NOT NULL,
	"name" text NOT NULL,
	"audience" jsonb NOT NULL,
	"email" jsonb NOT NULL,
	"manual" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"sent_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "certificate_distributions_status_check" CHECK ("certificate_distributions"."status" in ('draft', 'sent'))
);
--> statement-breakpoint
CREATE TABLE "certificate_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conference_id" uuid NOT NULL,
	"name" text NOT NULL,
	"designation" text DEFAULT '' NOT NULL,
	"institution" text DEFAULT '' NOT NULL,
	"storage_path" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issued_certificates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conference_id" uuid NOT NULL,
	"distribution_id" uuid NOT NULL,
	"serial" text NOT NULL,
	"name" text NOT NULL,
	"email" text DEFAULT '' NOT NULL,
	"affiliation" text DEFAULT '' NOT NULL,
	"role_label" text DEFAULT '' NOT NULL,
	"paper_label" text DEFAULT '' NOT NULL,
	"paper_title" text DEFAULT '' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'sent' NOT NULL,
	"bounce_reason" text,
	"opened" boolean DEFAULT false NOT NULL,
	"downloaded" boolean DEFAULT false NOT NULL,
	"verified_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "issued_certificates_status_check" CHECK ("issued_certificates"."status" in ('sent', 'bounced'))
);
--> statement-breakpoint
ALTER TABLE "certificate_designs" ADD CONSTRAINT "certificate_designs_conference_id_conferences_id_fk" FOREIGN KEY ("conference_id") REFERENCES "public"."conferences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate_designs" ADD CONSTRAINT "certificate_designs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate_distributions" ADD CONSTRAINT "certificate_distributions_conference_id_conferences_id_fk" FOREIGN KEY ("conference_id") REFERENCES "public"."conferences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate_distributions" ADD CONSTRAINT "certificate_distributions_design_id_certificate_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."certificate_designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate_distributions" ADD CONSTRAINT "certificate_distributions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate_signatures" ADD CONSTRAINT "certificate_signatures_conference_id_conferences_id_fk" FOREIGN KEY ("conference_id") REFERENCES "public"."conferences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate_signatures" ADD CONSTRAINT "certificate_signatures_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issued_certificates" ADD CONSTRAINT "issued_certificates_conference_id_conferences_id_fk" FOREIGN KEY ("conference_id") REFERENCES "public"."conferences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issued_certificates" ADD CONSTRAINT "issued_certificates_distribution_id_certificate_distributions_id_fk" FOREIGN KEY ("distribution_id") REFERENCES "public"."certificate_distributions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "certificate_designs_conference_idx" ON "certificate_designs" USING btree ("conference_id");--> statement-breakpoint
CREATE INDEX "certificate_distributions_conference_idx" ON "certificate_distributions" USING btree ("conference_id");--> statement-breakpoint
CREATE INDEX "certificate_distributions_design_idx" ON "certificate_distributions" USING btree ("design_id");--> statement-breakpoint
CREATE INDEX "certificate_signatures_conference_idx" ON "certificate_signatures" USING btree ("conference_id");--> statement-breakpoint
CREATE UNIQUE INDEX "certificate_signatures_one_default" ON "certificate_signatures" USING btree ("conference_id") WHERE "certificate_signatures"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "issued_certificates_serial_unique" ON "issued_certificates" USING btree ("serial");--> statement-breakpoint
CREATE INDEX "issued_certificates_conference_idx" ON "issued_certificates" USING btree ("conference_id");--> statement-breakpoint
CREATE INDEX "issued_certificates_distribution_idx" ON "issued_certificates" USING btree ("distribution_id");--> statement-breakpoint
CREATE INDEX "issued_certificates_email_idx" ON "issued_certificates" USING btree (lower("email"));
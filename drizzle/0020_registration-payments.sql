CREATE TYPE "public"."participant_category" AS ENUM('standard', 'student', 'co_author');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('bank_transfer', 'online', 'card', 'cash', 'other');--> statement-breakpoint
CREATE TABLE "conference_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conference_id" uuid NOT NULL,
	"category" "participant_category" NOT NULL,
	"submission_id" uuid,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"affiliation" text,
	"country" text,
	"attendance" "attendance_mode",
	"payment" "payment_status" DEFAULT 'not_paid' NOT NULL,
	"amount" numeric(12, 2),
	"method" "payment_method",
	"paid_on" date,
	"transaction_ref" text,
	"payer_name" text,
	"receipt_path" text,
	"receipt_name" text,
	"receipt_size" bigint,
	"receipt_uploaded_at" timestamp with time zone,
	"note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conference_participants_paper_check" CHECK (("conference_participants"."category" = 'co_author') = ("conference_participants"."submission_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "conferences" ADD COLUMN "registration_url" text;--> statement-breakpoint
ALTER TABLE "conferences" ADD COLUMN "participant_registration_url" text;--> statement-breakpoint
ALTER TABLE "conferences" ADD COLUMN "registration_deadline" date;--> statement-breakpoint
ALTER TABLE "conferences" ADD COLUMN "currency" text;--> statement-breakpoint
ALTER TABLE "submission_registrations" ADD COLUMN "amount" numeric(12, 2);--> statement-breakpoint
ALTER TABLE "submission_registrations" ADD COLUMN "method" "payment_method";--> statement-breakpoint
ALTER TABLE "submission_registrations" ADD COLUMN "paid_on" date;--> statement-breakpoint
ALTER TABLE "submission_registrations" ADD COLUMN "transaction_ref" text;--> statement-breakpoint
ALTER TABLE "submission_registrations" ADD COLUMN "payer_name" text;--> statement-breakpoint
ALTER TABLE "submission_registrations" ADD COLUMN "receipt_path" text;--> statement-breakpoint
ALTER TABLE "submission_registrations" ADD COLUMN "receipt_name" text;--> statement-breakpoint
ALTER TABLE "submission_registrations" ADD COLUMN "receipt_size" bigint;--> statement-breakpoint
ALTER TABLE "submission_registrations" ADD COLUMN "receipt_uploaded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conference_participants" ADD CONSTRAINT "conference_participants_conference_id_conferences_id_fk" FOREIGN KEY ("conference_id") REFERENCES "public"."conferences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_participants" ADD CONSTRAINT "conference_participants_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_participants" ADD CONSTRAINT "conference_participants_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_participants" ADD CONSTRAINT "conference_participants_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conference_participants_conference_idx" ON "conference_participants" USING btree ("conference_id");--> statement-breakpoint
CREATE INDEX "conference_participants_submission_idx" ON "conference_participants" USING btree ("submission_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conference_participants_email_key" ON "conference_participants" USING btree ("conference_id",lower("email")) WHERE "conference_participants"."submission_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "conference_participants_paper_email_key" ON "conference_participants" USING btree ("submission_id",lower("email")) WHERE "conference_participants"."submission_id" is not null;--> statement-breakpoint
ALTER TABLE "conferences" ADD CONSTRAINT "conferences_currency_check" CHECK ("conferences"."currency" is null or "conferences"."currency" ~ '^[A-Z]{3}$');--> statement-breakpoint
-- The default acceptance email links to the conference's registration page (conferences that
-- edited their own copy keep it as it is).
UPDATE "email_templates" SET "body" = replace("body", '1. Register by {{registration_deadline}}<br>', '1. Register by {{registration_deadline}}: {{registration_link}}<br>') WHERE "key" = 'acceptance';

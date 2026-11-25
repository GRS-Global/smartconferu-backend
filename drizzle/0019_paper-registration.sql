CREATE TYPE "public"."attendance_mode" AS ENUM('physical', 'virtual');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('not_paid', 'paid', 'waived');--> statement-breakpoint
CREATE TABLE "submission_registrations" (
	"submission_id" uuid PRIMARY KEY NOT NULL,
	"payment" "payment_status" DEFAULT 'not_paid' NOT NULL,
	"attendance" "attendance_mode",
	"presenter_email" text,
	"note" text,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "submission_registrations" ADD CONSTRAINT "submission_registrations_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_registrations" ADD CONSTRAINT "submission_registrations_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
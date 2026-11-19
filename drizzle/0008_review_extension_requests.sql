CREATE TYPE "public"."extension_status" AS ENUM('pending', 'approved', 'declined');--> statement-breakpoint
CREATE TABLE "review_extension_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"requested_date" date NOT NULL,
	"reason" text,
	"status" "extension_status" DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_extension_requests" ADD CONSTRAINT "review_extension_requests_assignment_id_review_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."review_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_extension_requests" ADD CONSTRAINT "review_extension_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_extension_requests_assignment_idx" ON "review_extension_requests" USING btree ("assignment_id");
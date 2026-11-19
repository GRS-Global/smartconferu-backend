CREATE TABLE "license_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conference_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"requested_date" date NOT NULL,
	"reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decision_reason" text,
	"new_expiry" date,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "license_requests_status_check" CHECK ("license_requests"."status" in ('pending', 'approved', 'declined', 'withdrawn'))
);
--> statement-breakpoint
ALTER TABLE "license_requests" ADD CONSTRAINT "license_requests_conference_id_conferences_id_fk" FOREIGN KEY ("conference_id") REFERENCES "public"."conferences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_requests" ADD CONSTRAINT "license_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_requests" ADD CONSTRAINT "license_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "license_requests_conference_idx" ON "license_requests" USING btree ("conference_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "license_requests_one_open" ON "license_requests" USING btree ("conference_id") WHERE "license_requests"."status" = 'pending';
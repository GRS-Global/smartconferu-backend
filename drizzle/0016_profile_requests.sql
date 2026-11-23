CREATE TABLE "profile_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"url" text,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"resolved_name" text,
	"resolved_id" uuid,
	"reason" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_requests_kind_check" CHECK ("profile_requests"."kind" in ('institution', 'society')),
	CONSTRAINT "profile_requests_status_check" CHECK ("profile_requests"."status" in ('pending', 'approved', 'rejected'))
);
--> statement-breakpoint
ALTER TABLE "profile_requests" ADD CONSTRAINT "profile_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_requests" ADD CONSTRAINT "profile_requests_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "profile_requests_unique" ON "profile_requests" USING btree ("kind","name_key","user_id");--> statement-breakpoint
CREATE INDEX "profile_requests_status_idx" ON "profile_requests" USING btree ("status","created_at");
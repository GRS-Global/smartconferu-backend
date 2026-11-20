CREATE TABLE "admin_claims" (
	"queue" text NOT NULL,
	"item_id" text NOT NULL,
	"admin_id" uuid NOT NULL,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_claims_queue_item_id_pk" PRIMARY KEY("queue","item_id")
);
--> statement-breakpoint
CREATE TABLE "admin_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"queue" text NOT NULL,
	"item_id" text NOT NULL,
	"kind" text DEFAULT 'note' NOT NULL,
	"author_id" uuid,
	"text" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_notes_kind_check" CHECK ("admin_notes"."kind" in ('note', 'message'))
);
--> statement-breakpoint
ALTER TABLE "admin_claims" ADD CONSTRAINT "admin_claims_admin_id_users_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_notes" ADD CONSTRAINT "admin_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_claims_admin_idx" ON "admin_claims" USING btree ("admin_id");--> statement-breakpoint
CREATE INDEX "admin_notes_item_idx" ON "admin_notes" USING btree ("queue","item_id","created_at");
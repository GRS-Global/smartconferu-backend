ALTER TABLE "issued_certificates" ADD COLUMN "revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issued_certificates" ADD COLUMN "revoke_reason" text;--> statement-breakpoint
ALTER TABLE "issued_certificates" ADD COLUMN "revoked_by" uuid;--> statement-breakpoint
ALTER TABLE "issued_certificates" ADD COLUMN "replaced_by" text;--> statement-breakpoint
ALTER TABLE "issued_certificates" ADD COLUMN "resent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "issued_certificates" ADD CONSTRAINT "issued_certificates_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
ALTER TABLE "email_log" ADD COLUMN "recipient_read_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "email_log_recipient_unread_idx" ON "email_log" USING btree (lower("to_email")) WHERE "email_log"."recipient_read_at" is null and "email_log"."status" = 'sent';--> statement-breakpoint
-- Emails already sent: the page treated one older than two days as read, so keep that; newer ones stay unread and now count on the bell.
UPDATE "email_log" SET "recipient_read_at" = "created_at" WHERE "status" = 'sent' AND "created_at" < now() - interval '2 days';

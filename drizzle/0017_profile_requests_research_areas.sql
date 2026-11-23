ALTER TABLE "profile_requests" DROP CONSTRAINT "profile_requests_kind_check";--> statement-breakpoint
ALTER TABLE "profile_requests" ADD COLUMN "parent_name" text;--> statement-breakpoint
ALTER TABLE "profile_requests" ADD CONSTRAINT "profile_requests_kind_check" CHECK ("profile_requests"."kind" in ('institution', 'society', 'research_area'));
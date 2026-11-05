CREATE TYPE "public"."assignment_status" AS ENUM('assigned', 'accepted', 'declined', 'submitted', 'removed');--> statement-breakpoint
CREATE TYPE "public"."auth_provider" AS ENUM('google', 'microsoft', 'orcid');--> statement-breakpoint
CREATE TYPE "public"."auth_token_purpose" AS ENUM('verify_email', 'reset_password', 'login_code', 'change_email');--> statement-breakpoint
CREATE TYPE "public"."cfp_status" AS ENUM('draft', 'in_review', 'published', 'rejected', 'closed');--> statement-breakpoint
CREATE TYPE "public"."conference_status" AS ENUM('pending_approval', 'active', 'rejected', 'archived', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."decision_outcome" AS ENUM('upload_pending', 'no_decision', 'plagiarism_clear', 'revise', 'waitlist', 'accept', 'registered', 'reject');--> statement-breakpoint
CREATE TYPE "public"."file_kind" AS ENUM('paper', 'revision', 'camera_ready', 'supplementary');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('chair', 'track_chair', 'cfp_manager', 'reviewer');--> statement-breakpoint
CREATE TYPE "public"."member_status" AS ENUM('invited', 'active', 'declined', 'removed');--> statement-breakpoint
CREATE TYPE "public"."review_mode" AS ENUM('double_blind', 'single_blind', 'open');--> statement-breakpoint
CREATE TYPE "public"."review_status" AS ENUM('draft', 'submitted');--> statement-breakpoint
CREATE TYPE "public"."submission_status" AS ENUM('draft', 'submitted', 'withdrawn');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "auth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"email" text NOT NULL,
	"purpose" "auth_token_purpose" NOT NULL,
	"token_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	CONSTRAINT "auth_tokens_token_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "profile_details" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"first_name" text DEFAULT '' NOT NULL,
	"last_name" text DEFAULT '' NOT NULL,
	"designation" text,
	"affiliation" text,
	"country" text,
	"orcid_id" text,
	"photo_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"mfa_verified_at" timestamp with time zone,
	"user_agent" text,
	"ip_address" text,
	CONSTRAINT "sessions_token_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" "auth_provider" NOT NULL,
	"provider_user_id" text NOT NULL,
	"email" text,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "user_identities_provider_account_key" UNIQUE("provider","provider_user_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text,
	"email_verified_at" timestamp with time zone,
	"password_hash" text,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"is_super_admin" boolean DEFAULT false NOT NULL,
	"failed_sign_in_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_sign_in_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cfps" (
	"conference_id" uuid PRIMARY KEY NOT NULL,
	"content" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"theme" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "cfp_status" DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"admin_note" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conference_deletion_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conference_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"admin_note" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conference_deletion_requests_status_check" CHECK ("conference_deletion_requests"."status" in ('pending', 'approved', 'rejected', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "conference_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conference_id" uuid NOT NULL,
	"user_id" uuid,
	"invited_email" text,
	"display_name" text,
	"role" "member_role" NOT NULL,
	"status" "member_status" DEFAULT 'invited' NOT NULL,
	"expertise" text[] DEFAULT '{}'::text[] NOT NULL,
	"max_papers" integer,
	"invited_by" uuid,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	"decline_reason" text,
	CONSTRAINT "conference_members_who_check" CHECK ("conference_members"."user_id" is not null or "conference_members"."invited_email" is not null)
);
--> statement-breakpoint
CREATE TABLE "conferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"acronym" text NOT NULL,
	"title" text NOT NULL,
	"about" text,
	"mode" text,
	"venue" text,
	"city" text,
	"state" text,
	"country" text,
	"web_page" text,
	"contact_email" text,
	"primary_area" text,
	"secondary_area" text,
	"start_date" date,
	"end_date" date,
	"submission_deadline" timestamp with time zone,
	"review_deadline" timestamp with time zone,
	"notification_date" date,
	"camera_ready_deadline" timestamp with time zone,
	"review_mode" "review_mode" DEFAULT 'double_blind' NOT NULL,
	"logo_path" text,
	"status" "conference_status" DEFAULT 'pending_approval' NOT NULL,
	"admin_note" text,
	"next_paper_no" integer DEFAULT 1 NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "conferences_slug_check" CHECK ("conferences"."slug" ~ '^[a-z0-9-]+$'),
	CONSTRAINT "conferences_mode_check" CHECK ("conferences"."mode" in ('in_person', 'virtual', 'hybrid')),
	CONSTRAINT "conferences_dates_check" CHECK ("conferences"."end_date" is null or "conferences"."start_date" is null or "conferences"."end_date" >= "conferences"."start_date")
);
--> statement-breakpoint
CREATE TABLE "decision_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conference_id" uuid NOT NULL,
	"label" text NOT NULL,
	"color" text DEFAULT '#64748B' NOT NULL,
	"outcome" "decision_outcome" NOT NULL,
	"description" text,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conference_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"position" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submission_authors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"user_id" uuid,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"affiliation" text,
	"country" text,
	"is_corresponding" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "submission_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"kind" "file_kind" DEFAULT 'paper' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"storage_path" text NOT NULL,
	"file_name" text NOT NULL,
	"size_bytes" bigint,
	"uploaded_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"auto_check" jsonb,
	CONSTRAINT "submission_files_storage_path_key" UNIQUE("storage_path")
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conference_id" uuid NOT NULL,
	"paper_no" integer NOT NULL,
	"track_id" uuid,
	"submitter_id" uuid NOT NULL,
	"title" text NOT NULL,
	"abstract" text DEFAULT '' NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "submission_status" DEFAULT 'submitted' NOT NULL,
	"screening" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" "decision_outcome" DEFAULT 'upload_pending' NOT NULL,
	"decision_type_id" uuid,
	"decision_note" text,
	"desk_rejected" boolean DEFAULT false NOT NULL,
	"desk_reject_reason" text,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"notified_outcome" "decision_outcome",
	"notified_decision_type_id" uuid,
	"notified_note" text,
	"notified_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_by" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submissions_conference_paper_no_key" UNIQUE("conference_id","paper_no"),
	CONSTRAINT "submissions_withdrawn_by_check" CHECK ("submissions"."withdrawn_by" in ('author', 'chair'))
);
--> statement-breakpoint
CREATE TABLE "decision_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"outcome" "decision_outcome" NOT NULL,
	"decision_type_id" uuid,
	"note" text,
	"decided_by" uuid,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pending_review_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"due_at" timestamp with time zone,
	"assigned_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pending_review_assignments_submission_member_key" UNIQUE("submission_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "review_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"status" "assignment_status" DEFAULT 'assigned' NOT NULL,
	"due_at" timestamp with time zone,
	"assigned_by" uuid,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
	"responded_at" timestamp with time zone,
	"decline_reason" text,
	CONSTRAINT "review_assignments_submission_reviewer_key" UNIQUE("submission_id","reviewer_id")
);
--> statement-breakpoint
CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_id" uuid NOT NULL,
	"submission_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"score" smallint,
	"confidence" text,
	"recommendation" text,
	"comments_to_author" text,
	"comments_to_chair" text,
	"answers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"shared_with_author" boolean DEFAULT false NOT NULL,
	"status" "review_status" DEFAULT 'draft' NOT NULL,
	"submitted_at" timestamp with time zone,
	"edited_by_chair_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reviews_assignment_key" UNIQUE("assignment_id"),
	CONSTRAINT "reviews_score_check" CHECK ("reviews"."score" between 1 and 5),
	CONSTRAINT "reviews_confidence_check" CHECK ("reviews"."confidence" in ('low', 'medium', 'high')),
	CONSTRAINT "reviews_recommendation_check" CHECK ("reviews"."recommendation" in ('accept', 'revise', 'reject'))
);
--> statement-breakpoint
CREATE TABLE "conference_email_templates" (
	"conference_id" uuid NOT NULL,
	"key" text NOT NULL,
	"label" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"is_custom" boolean DEFAULT false NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conference_email_templates_conference_id_key_pk" PRIMARY KEY("conference_id","key")
);
--> statement-breakpoint
CREATE TABLE "email_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conference_id" uuid,
	"submission_id" uuid,
	"event" text NOT NULL,
	"template_key" text NOT NULL,
	"template_label" text,
	"to_email" text NOT NULL,
	"to_name" text,
	"recipient_type" text,
	"subject" text NOT NULL,
	"body" text,
	"status" text NOT NULL,
	"provider_id" text,
	"error" text,
	"sent_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_log_status_check" CHECK ("email_log"."status" in ('sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "email_templates" (
	"key" text PRIMARY KEY NOT NULL,
	"module" text,
	"role" text,
	"label" text NOT NULL,
	"send_type" text,
	"trigger_text" text,
	"recipients" text,
	"subject" text NOT NULL,
	"body" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"conference_id" uuid,
	"submission_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"conference_id" uuid,
	"submission_id" uuid,
	"feature" text NOT NULL,
	"provider" text DEFAULT 'anthropic' NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"status" text DEFAULT 'ok' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_usage_provider_check" CHECK ("ai_usage"."provider" in ('anthropic', 'voyage')),
	CONSTRAINT "ai_usage_status_check" CHECK ("ai_usage"."status" in ('ok', 'error'))
);
--> statement-breakpoint
CREATE TABLE "paper_chunks" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "paper_chunks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"submission_id" uuid NOT NULL,
	"file_id" uuid,
	"chunk_index" integer NOT NULL,
	"section" text,
	"content" text NOT NULL,
	"token_count" integer,
	"embedding" vector(1024) NOT NULL,
	"embedding_model" text DEFAULT 'voyage-3.5' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paper_chunks_submission_chunk_key" UNIQUE("submission_id","chunk_index")
);
--> statement-breakpoint
CREATE TABLE "paper_digests" (
	"submission_id" uuid PRIMARY KEY NOT NULL,
	"file_id" uuid,
	"summary" text NOT NULL,
	"key_points" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"ip_address" text,
	"user_agent" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_tokens" ADD CONSTRAINT "auth_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_details" ADD CONSTRAINT "profile_details_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_id_users_id_fk" FOREIGN KEY ("id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cfps" ADD CONSTRAINT "cfps_conference_id_conferences_id_fk" FOREIGN KEY ("conference_id") REFERENCES "public"."conferences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_deletion_requests" ADD CONSTRAINT "conference_deletion_requests_conference_id_conferences_id_fk" FOREIGN KEY ("conference_id") REFERENCES "public"."conferences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_deletion_requests" ADD CONSTRAINT "conference_deletion_requests_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_deletion_requests" ADD CONSTRAINT "conference_deletion_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_members" ADD CONSTRAINT "conference_members_conference_id_conferences_id_fk" FOREIGN KEY ("conference_id") REFERENCES "public"."conferences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_members" ADD CONSTRAINT "conference_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_members" ADD CONSTRAINT "conference_members_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conferences" ADD CONSTRAINT "conferences_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_types" ADD CONSTRAINT "decision_types_conference_id_conferences_id_fk" FOREIGN KEY ("conference_id") REFERENCES "public"."conferences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_conference_id_conferences_id_fk" FOREIGN KEY ("conference_id") REFERENCES "public"."conferences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_authors" ADD CONSTRAINT "submission_authors_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_authors" ADD CONSTRAINT "submission_authors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_files" ADD CONSTRAINT "submission_files_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submission_files" ADD CONSTRAINT "submission_files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_conference_id_conferences_id_fk" FOREIGN KEY ("conference_id") REFERENCES "public"."conferences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_submitter_id_users_id_fk" FOREIGN KEY ("submitter_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_decision_type_id_decision_types_id_fk" FOREIGN KEY ("decision_type_id") REFERENCES "public"."decision_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_notified_decision_type_id_decision_types_id_fk" FOREIGN KEY ("notified_decision_type_id") REFERENCES "public"."decision_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_events" ADD CONSTRAINT "decision_events_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_events" ADD CONSTRAINT "decision_events_decision_type_id_decision_types_id_fk" FOREIGN KEY ("decision_type_id") REFERENCES "public"."decision_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decision_events" ADD CONSTRAINT "decision_events_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_review_assignments" ADD CONSTRAINT "pending_review_assignments_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_review_assignments" ADD CONSTRAINT "pending_review_assignments_member_id_conference_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."conference_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_review_assignments" ADD CONSTRAINT "pending_review_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_assignments" ADD CONSTRAINT "review_assignments_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_assignments" ADD CONSTRAINT "review_assignments_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_assignments" ADD CONSTRAINT "review_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_assignment_id_review_assignments_id_fk" FOREIGN KEY ("assignment_id") REFERENCES "public"."review_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_email_templates" ADD CONSTRAINT "conference_email_templates_conference_id_conferences_id_fk" FOREIGN KEY ("conference_id") REFERENCES "public"."conferences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_email_templates" ADD CONSTRAINT "conference_email_templates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_conference_id_conferences_id_fk" FOREIGN KEY ("conference_id") REFERENCES "public"."conferences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_sent_by_users_id_fk" FOREIGN KEY ("sent_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_templates" ADD CONSTRAINT "email_templates_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_conference_id_conferences_id_fk" FOREIGN KEY ("conference_id") REFERENCES "public"."conferences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_conference_id_conferences_id_fk" FOREIGN KEY ("conference_id") REFERENCES "public"."conferences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_chunks" ADD CONSTRAINT "paper_chunks_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_chunks" ADD CONSTRAINT "paper_chunks_file_id_submission_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."submission_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_digests" ADD CONSTRAINT "paper_digests_submission_id_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."submissions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paper_digests" ADD CONSTRAINT "paper_digests_file_id_submission_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."submission_files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_tokens_lookup_idx" ON "auth_tokens" USING btree (lower("email"),"purpose");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_family_idx" ON "sessions" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "user_identities_user_idx" ON "user_identities" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "conference_deletion_one_open" ON "conference_deletion_requests" USING btree ("conference_id") WHERE "conference_deletion_requests"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "conference_members_user_role_key" ON "conference_members" USING btree ("conference_id","user_id","role") WHERE "conference_members"."user_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "conference_members_email_role_key" ON "conference_members" USING btree ("conference_id",lower("invited_email"),"role") WHERE "conference_members"."user_id" is null;--> statement-breakpoint
CREATE INDEX "conference_members_user_idx" ON "conference_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conferences_slug_key" ON "conferences" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "decision_types_conference_idx" ON "decision_types" USING btree ("conference_id");--> statement-breakpoint
CREATE INDEX "tracks_conference_idx" ON "tracks" USING btree ("conference_id");--> statement-breakpoint
CREATE INDEX "submission_authors_submission_idx" ON "submission_authors" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "submission_authors_user_idx" ON "submission_authors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "submission_authors_email_idx" ON "submission_authors" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "submission_files_submission_idx" ON "submission_files" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "submissions_conference_idx" ON "submissions" USING btree ("conference_id");--> statement-breakpoint
CREATE INDEX "submissions_submitter_idx" ON "submissions" USING btree ("submitter_id");--> statement-breakpoint
CREATE INDEX "decision_events_submission_idx" ON "decision_events" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "pending_review_assignments_member_idx" ON "pending_review_assignments" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "review_assignments_reviewer_idx" ON "review_assignments" USING btree ("reviewer_id");--> statement-breakpoint
CREATE INDEX "reviews_submission_idx" ON "reviews" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "email_log_conference_idx" ON "email_log" USING btree ("conference_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ai_usage_user_idx" ON "ai_usage" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ai_usage_conference_idx" ON "ai_usage" USING btree ("conference_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_entity_idx" ON "audit_log" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_log_actor_idx" ON "audit_log" USING btree ("actor_id","occurred_at" DESC NULLS LAST);
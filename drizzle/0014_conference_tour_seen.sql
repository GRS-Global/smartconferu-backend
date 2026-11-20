CREATE TABLE "conference_tour_seen" (
	"conference_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conference_tour_seen_conference_id_user_id_pk" PRIMARY KEY("conference_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "conference_tour_seen" ADD CONSTRAINT "conference_tour_seen_conference_id_conferences_id_fk" FOREIGN KEY ("conference_id") REFERENCES "public"."conferences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conference_tour_seen" ADD CONSTRAINT "conference_tour_seen_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
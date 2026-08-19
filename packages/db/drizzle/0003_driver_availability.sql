CREATE TABLE "driver_availability" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"available_from_at" timestamp with time zone,
	"available_until_at" timestamp with time zone,
	"pinned_sequence" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"client_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"server_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	"updated_by" uuid
);
--> statement-breakpoint
ALTER TABLE "driver_availability" ADD CONSTRAINT "driver_availability_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_availability" ADD CONSTRAINT "driver_availability_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_availability" ADD CONSTRAINT "driver_availability_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "driver_availability_session_driver_uq" ON "driver_availability" USING btree ("session_id","driver_id");
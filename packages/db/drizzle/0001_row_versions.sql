CREATE TABLE "row_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"table_name" text NOT NULL,
	"row_id" uuid NOT NULL,
	"snapshot" jsonb NOT NULL,
	"client_updated_at" timestamp with time zone NOT NULL,
	"updated_by" uuid,
	"superseded_by" uuid,
	"was_conflict" boolean DEFAULT false NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "row_versions" ADD CONSTRAINT "row_versions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "row_versions_row_idx" ON "row_versions" USING btree ("team_id","table_name","row_id");--> statement-breakpoint
CREATE INDEX "row_versions_conflict_idx" ON "row_versions" USING btree ("team_id","was_conflict","recorded_at");
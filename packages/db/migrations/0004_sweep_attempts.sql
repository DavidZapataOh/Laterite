CREATE TYPE "public"."sweep_outcome" AS ENUM('landed', 'failed', 'skipped', 'pull_failed', 'already_swept');--> statement-breakpoint
CREATE TABLE "sweep_attempts" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sweep_attempts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user" text NOT NULL,
	"payment_token" smallint NOT NULL,
	"day" integer NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" "sweep_outcome" NOT NULL,
	"reason" text,
	"signature" text,
	"pull" numeric(20, 0),
	"min_out" numeric(20, 0),
	"quoted" numeric(20, 0),
	"route" text,
	"price_age_seconds" integer,
	"price_wait_ms" integer,
	"bytes" integer,
	"compute_units" integer,
	"compute_unit_limit" integer,
	"loaded_accounts_data_size_limit" integer,
	"priority_fee_lamports" numeric(20, 0),
	"fee_lamports" numeric(20, 0),
	"latency_ms" integer
);
--> statement-breakpoint
CREATE INDEX "sweep_attempts_user_day" ON "sweep_attempts" USING btree ("user","day");--> statement-breakpoint
CREATE INDEX "sweep_attempts_day_outcome" ON "sweep_attempts" USING btree ("day","outcome");
CREATE TYPE "public"."sponsorship_kind" AS ENUM('enroll', 'reactivate');--> statement-breakpoint
CREATE TYPE "public"."sponsorship_outcome" AS ENUM('prepared', 'sent', 'landed', 'failed');--> statement-breakpoint
CREATE TABLE "sponsorships" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "sponsorships_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"wallet" text NOT NULL,
	"ip" text,
	"kind" "sponsorship_kind" NOT NULL,
	"message" text NOT NULL,
	"asset_account" text,
	"compute_units" integer NOT NULL,
	"compute_unit_limit" integer NOT NULL,
	"compute_unit_price" numeric(20, 0) NOT NULL,
	"sponsor_lamports" numeric(20, 0) NOT NULL,
	"last_valid_block_height" bigint NOT NULL,
	"prepared_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"signature" text,
	"outcome" "sponsorship_outcome" DEFAULT 'prepared' NOT NULL,
	"reason" text,
	CONSTRAINT "sponsorships_message_unique" UNIQUE("message")
);
--> statement-breakpoint
CREATE INDEX "sponsorships_wallet_prepared_at" ON "sponsorships" USING btree ("wallet","prepared_at");--> statement-breakpoint
CREATE INDEX "sponsorships_ip_prepared_at" ON "sponsorships" USING btree ("ip","prepared_at");--> statement-breakpoint
CREATE INDEX "sponsorships_sent_at" ON "sponsorships" USING btree ("sent_at");
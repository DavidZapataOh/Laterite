CREATE TYPE "public"."attestation_kind" AS ENUM('income', 'payment');--> statement-breakpoint
CREATE TYPE "public"."user_event_kind" AS ENUM('enrolled', 'settings_updated', 'paused', 'resumed', 'pending_lowered', 'tier_changed', 'payment_tokens_changed', 'exited', 'reactivated');--> statement-breakpoint
CREATE TABLE "alarms" (
	"key" text PRIMARY KEY NOT NULL,
	"firing" boolean NOT NULL,
	"message" text NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"notified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "attestations" (
	"signature" text NOT NULL,
	"event_index" smallint NOT NULL,
	"slot" bigint NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"user" text NOT NULL,
	"kind" "attestation_kind" NOT NULL,
	"payment_token" smallint NOT NULL,
	"amount" numeric(20, 0) NOT NULL,
	"event_time" timestamp with time zone NOT NULL,
	"source_signature" text NOT NULL,
	"transfer_index" integer NOT NULL,
	"invested" numeric(20, 0) NOT NULL,
	"pending_after" numeric(20, 0) NOT NULL,
	"record" text NOT NULL,
	"payer" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_signature" text,
	"closed_at" timestamp with time zone,
	CONSTRAINT "attestations_signature_event_index_pk" PRIMARY KEY("signature","event_index")
);
--> statement-breakpoint
CREATE TABLE "eligibility_declarations" (
	"wallet" text NOT NULL,
	"declaration_version" text NOT NULL,
	"country" char(2),
	"declared_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "eligibility_declarations_wallet_declaration_version_pk" PRIMARY KEY("wallet","declaration_version")
);
--> statement-breakpoint
CREATE TABLE "indexer_state" (
	"program" text PRIMARY KEY NOT NULL,
	"signature" text NOT NULL,
	"slot" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "swap_account_creations" (
	"address" text PRIMARY KEY NOT NULL,
	"mint" text NOT NULL,
	"token_program" text NOT NULL,
	"signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sweeps" (
	"signature" text NOT NULL,
	"event_index" smallint NOT NULL,
	"slot" bigint NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"fee_payer" text NOT NULL,
	"user" text NOT NULL,
	"payment_token" smallint NOT NULL,
	"asset" smallint NOT NULL,
	"engine" numeric(20, 0) NOT NULL,
	"pending" numeric(20, 0) NOT NULL,
	"asset_price" numeric(20, 0) NOT NULL,
	"asset_exponent" smallint NOT NULL,
	"received" numeric(20, 0) NOT NULL,
	"min_out" numeric(20, 0) NOT NULL,
	"multiplier" double precision NOT NULL,
	"headroom_bps" integer GENERATED ALWAYS AS (div((received - min_out) * 10000, min_out)::integer) STORED,
	CONSTRAINT "sweeps_signature_event_index_pk" PRIMARY KEY("signature","event_index")
);
--> statement-breakpoint
CREATE TABLE "telegram_links" (
	"wallet" text NOT NULL,
	"chat_id" bigint NOT NULL,
	"message_signature" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "telegram_links_wallet_chat_id_pk" PRIMARY KEY("wallet","chat_id")
);
--> statement-breakpoint
CREATE TABLE "user_events" (
	"signature" text NOT NULL,
	"event_index" smallint NOT NULL,
	"slot" bigint NOT NULL,
	"block_time" timestamp with time zone NOT NULL,
	"user" text NOT NULL,
	"kind" "user_event_kind" NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "user_events_signature_event_index_pk" PRIMARY KEY("signature","event_index")
);
--> statement-breakpoint
CREATE INDEX "attestations_user_block_time" ON "attestations" USING btree ("user","block_time");--> statement-breakpoint
CREATE INDEX "attestations_transfer" ON "attestations" USING btree ("user","source_signature","transfer_index");--> statement-breakpoint
CREATE INDEX "attestations_record" ON "attestations" USING btree ("record");--> statement-breakpoint
CREATE INDEX "attestations_open_expires_at" ON "attestations" USING btree ("expires_at") WHERE "attestations"."closed_signature" is null;--> statement-breakpoint
CREATE INDEX "sweeps_user_block_time" ON "sweeps" USING btree ("user","block_time");--> statement-breakpoint
CREATE INDEX "sweeps_fee_payer_slot" ON "sweeps" USING btree ("fee_payer","slot");--> statement-breakpoint
CREATE INDEX "user_events_user_block_time" ON "user_events" USING btree ("user","block_time");
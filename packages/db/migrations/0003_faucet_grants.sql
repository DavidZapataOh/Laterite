CREATE TABLE "faucet_grants" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "faucet_grants_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"wallet" text NOT NULL,
	"ip" text,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signature" text
);
--> statement-breakpoint
CREATE INDEX "faucet_grants_wallet_granted_at" ON "faucet_grants" USING btree ("wallet","granted_at");--> statement-breakpoint
CREATE INDEX "faucet_grants_ip_granted_at" ON "faucet_grants" USING btree ("ip","granted_at");
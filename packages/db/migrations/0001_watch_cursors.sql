CREATE TABLE "watch_cursors" (
	"token_account" text PRIMARY KEY NOT NULL,
	"signature" text NOT NULL,
	"slot" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE "telegram_link_requests" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"wallet" text NOT NULL,
	"locale" text NOT NULL,
	"message" text NOT NULL,
	"signature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "telegram_link_requests_signature_unique" UNIQUE("signature")
);
--> statement-breakpoint
CREATE TABLE "telegram_notifications" (
	"chat_id" bigint NOT NULL,
	"key" text NOT NULL,
	"sent" boolean NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_notifications_chat_id_key_pk" PRIMARY KEY("chat_id","key")
);
--> statement-breakpoint
ALTER TABLE "telegram_links" ADD COLUMN "locale" text DEFAULT 'en' NOT NULL;
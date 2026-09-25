import { sql } from 'drizzle-orm';
import {
    bigint,
    boolean,
    char,
    doublePrecision,
    index,
    integer,
    jsonb,
    numeric,
    pgEnum,
    pgTable,
    primaryKey,
    smallint,
    text,
    timestamp,
} from 'drizzle-orm/pg-core';

/** A program `u64` (raw token units, prices): `numeric(20, 0)` holds every value, read as a `bigint`. */
const u64 = (name: string) => numeric(name, { mode: 'bigint', precision: 20, scale: 0 });
const slot = () => bigint('slot', { mode: 'bigint' }).notNull();
const time = (name: string) => timestamp(name, { withTimezone: true });

/** Where the indexer stopped for a program: the last finalized transaction it stored. */
export const indexerState = pgTable('indexer_state', {
    program: text('program').primaryKey(),
    signature: text('signature').notNull(),
    slot: slot(),
    updatedAt: time('updated_at').notNull().defaultNow(),
});

/** Every successful sweep, whoever sent it, from its `Swept` event. */
export const sweeps = pgTable(
    'sweeps',
    {
        signature: text('signature').notNull(),
        eventIndex: smallint('event_index').notNull(),
        slot: slot(),
        blockTime: time('block_time').notNull(),
        feePayer: text('fee_payer').notNull(),
        user: text('user').notNull(),
        paymentToken: smallint('payment_token').notNull(),
        asset: smallint('asset').notNull(),
        engine: u64('engine').notNull(),
        pending: u64('pending').notNull(),
        assetPrice: u64('asset_price').notNull(),
        assetExponent: smallint('asset_exponent').notNull(),
        received: u64('received').notNull(),
        minOut: u64('min_out').notNull(),
        /** The asset mint's ScaledUiAmount multiplier in force at the block time (1 without the extension). */
        multiplier: doublePrecision('multiplier').notNull(),
        /** What the route delivered above `min_out`, in basis points of `min_out`. */
        headroomBps: integer('headroom_bps').generatedAlwaysAs(
            sql`div((received - min_out) * 10000, min_out)::integer`,
        ),
    },
    table => [
        primaryKey({ columns: [table.signature, table.eventIndex] }),
        index('sweeps_user_block_time').on(table.user, table.blockTime),
        index('sweeps_fee_payer_slot').on(table.feePayer, table.slot),
    ],
);

export const attestationKind = pgEnum('attestation_kind', ['income', 'payment']);

/**
 * Every landed attestation, whoever submitted it, from its `Attested` event, and its record: open until
 * `close_attestation` returns the rent to `payer`, which the program allows after `expires_at`.
 */
export const attestations = pgTable(
    'attestations',
    {
        signature: text('signature').notNull(),
        eventIndex: smallint('event_index').notNull(),
        slot: slot(),
        blockTime: time('block_time').notNull(),
        user: text('user').notNull(),
        kind: attestationKind('kind').notNull(),
        paymentToken: smallint('payment_token').notNull(),
        amount: u64('amount').notNull(),
        eventTime: time('event_time').notNull(),
        sourceSignature: text('source_signature').notNull(),
        transferIndex: integer('transfer_index').notNull(),
        invested: u64('invested').notNull(),
        pendingAfter: u64('pending_after').notNull(),
        record: text('record').notNull(),
        payer: text('payer').notNull(),
        expiresAt: time('expires_at').notNull(),
        closedSignature: text('closed_signature'),
        closedAt: time('closed_at'),
    },
    table => [
        primaryKey({ columns: [table.signature, table.eventIndex] }),
        index('attestations_user_block_time').on(table.user, table.blockTime),
        index('attestations_transfer').on(table.user, table.sourceSignature, table.transferIndex),
        index('attestations_record').on(table.record),
        index('attestations_open_expires_at')
            .on(table.expiresAt)
            .where(sql`${table.closedSignature} is null`),
    ],
);

/**
 * Where the watcher stopped in each token account it watches: the newest finalized transaction whose transfers it
 * attested or ruled out, so a restart resumes after it.
 */
export const watchCursors = pgTable('watch_cursors', {
    tokenAccount: text('token_account').primaryKey(),
    signature: text('signature').notNull(),
    slot: slot(),
    updatedAt: time('updated_at').notNull().defaultNow(),
});

export const userEventKind = pgEnum('user_event_kind', [
    'enrolled',
    'settings_updated',
    'paused',
    'resumed',
    'pending_lowered',
    'tier_changed',
    'payment_tokens_changed',
    'exited',
    'reactivated',
]);

/** What each user event carries besides the user, as its program event does; amounts are decimal strings. */
export type UserEventData =
    | { asset: number; paymentTokens: number; tier: number }
    | { params: Record<string, unknown> }
    | { pending: string }
    | { paymentTokens: number }
    | { tier: number }
    | Record<string, never>;

/** The users' own controls, from the events `enroll` and the user instructions emit. */
export const userEvents = pgTable(
    'user_events',
    {
        signature: text('signature').notNull(),
        eventIndex: smallint('event_index').notNull(),
        slot: slot(),
        blockTime: time('block_time').notNull(),
        user: text('user').notNull(),
        kind: userEventKind('kind').notNull(),
        data: jsonb('data').$type<UserEventData>().notNull(),
    },
    table => [
        primaryKey({ columns: [table.signature, table.eventIndex] }),
        index('user_events_user_block_time').on(table.user, table.blockTime),
    ],
);

/** Swap-authority token accounts the crank created for a route's intermediate mint, and the rent it paid. */
export const swapAccountCreations = pgTable('swap_account_creations', {
    address: text('address').primaryKey(),
    mint: text('mint').notNull(),
    tokenProgram: text('token_program').notNull(),
    signature: text('signature').notNull(),
    createdAt: time('created_at').notNull().defaultNow(),
});

/** Each operations alarm's state, so a restart neither repeats nor loses a notification. */
export const alarms = pgTable('alarms', {
    key: text('key').primaryKey(),
    firing: boolean('firing').notNull(),
    message: text('message').notNull(),
    changedAt: time('changed_at').notNull(),
    notifiedAt: time('notified_at'),
});

/** Chats a wallet linked for notifications by signing the link message; a revoked link keeps its row. */
export const telegramLinks = pgTable(
    'telegram_links',
    {
        wallet: text('wallet').notNull(),
        chatId: bigint('chat_id', { mode: 'bigint' }).notNull(),
        messageSignature: text('message_signature').notNull(),
        linkedAt: time('linked_at').notNull().defaultNow(),
        revokedAt: time('revoked_at'),
    },
    table => [primaryKey({ columns: [table.wallet, table.chatId] })],
);

/** A wallet's eligibility declaration, with the country its request came from. */
export const eligibilityDeclarations = pgTable(
    'eligibility_declarations',
    {
        wallet: text('wallet').notNull(),
        declarationVersion: text('declaration_version').notNull(),
        country: char('country', { length: 2 }),
        declaredAt: time('declared_at').notNull().defaultNow(),
    },
    table => [primaryKey({ columns: [table.wallet, table.declarationVersion] })],
);

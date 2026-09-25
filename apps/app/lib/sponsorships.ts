import 'server-only';

import { and, count, eq, gt, inArray, min, ne, sql } from 'drizzle-orm';
import { type Database, sponsorships } from '@laterite/db/database';

/** Sponsored transactions sent within a day: per wallet, per requesting address and in all. */
export const SPONSOR_LIMITS = { all: 500, ip: 10, wallet: 3 } as const;

/** Returns (reactivations) per wallet within 30 days: exit-and-return churn is paid by the sponsor. */
export const RETURN_LIMIT = 2;

/** Transactions built and simulated within an hour: per wallet and per requesting address. */
export const PREPARE_LIMITS = { ip: 60, wallet: 20 } as const;

/** How long a prepared message may come back signed; its blockhash lasts about a minute. */
export const PREPARED_TTL_MS = 2 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const RETURN_WINDOW_MS = 30 * DAY_MS;

/** Serializes the claims to send, so two requests never both pass a limit. */
const SPONSOR_LOCK = 0x7370_6f6e;

/** What the sponsor paid for, or may still land: sent transactions whose outcome is not a failure. */
const SPENT = ['sent', 'landed'] as const;

export type Kind = (typeof sponsorships.kind.enumValues)[number];

/** Why a request was limited, and when it may come again. */
export type Limited = { limit: 'all' | 'ip' | 'prepare' | 'returns' | 'wallet'; retryAfterSeconds: number };

const retryAfter = (oldest: Date | null, window: number, now: Date) =>
    Math.max(1, Math.ceil(((oldest?.getTime() ?? now.getTime()) + window - now.getTime()) / 1000));

type Reader = Pick<Database, 'select'>;

/** The first send limit `wallet` from `ip` would pass for another transaction of `kind`, or null within them all. */
async function sendLimit(
    db: Reader,
    wallet: string,
    ip: string | null,
    kind: Kind,
    now: Date,
): Promise<Limited | null> {
    const spent = (since: Date, ...where: ReturnType<typeof eq>[]) =>
        db
            .select({ count: count(), oldest: min(sponsorships.sentAt) })
            .from(sponsorships)
            .where(and(gt(sponsorships.sentAt, since), inArray(sponsorships.outcome, SPENT), ...where));
    const day = new Date(now.getTime() - DAY_MS);
    const checks: [Limited['limit'], Promise<{ count: number; oldest: Date | null }[]>, number, number][] = [
        ['wallet', spent(day, eq(sponsorships.wallet, wallet)), SPONSOR_LIMITS.wallet, DAY_MS],
        ['all', spent(day), SPONSOR_LIMITS.all, DAY_MS],
    ];
    if (ip !== null) checks.push(['ip', spent(day, eq(sponsorships.ip, ip)), SPONSOR_LIMITS.ip, DAY_MS]);
    if (kind === 'reactivate') {
        const month = new Date(now.getTime() - RETURN_WINDOW_MS);
        const returns = spent(month, eq(sponsorships.wallet, wallet), eq(sponsorships.kind, 'reactivate'));
        checks.push(['returns', returns, RETURN_LIMIT, RETURN_WINDOW_MS]);
    }
    for (const [limit, query, most, window] of checks) {
        const [{ count: used, oldest }] = await query;
        if (used >= most) return { limit, retryAfterSeconds: retryAfter(oldest, window, now) };
    }
    return null;
}

/**
 * Whether `wallet` from `ip` may have another transaction of `kind` built: within the hour's builds and within the
 * send limits, so nobody signs a transaction the sponsor would then refuse.
 */
export async function prepareLimit(
    db: Database,
    wallet: string,
    ip: string | null,
    kind: Kind,
    now = new Date(),
): Promise<Limited | null> {
    const since = new Date(now.getTime() - HOUR_MS);
    const built = (key: 'ip' | 'wallet', value: string) =>
        db
            .select({ count: count(), oldest: min(sponsorships.preparedAt) })
            .from(sponsorships)
            .where(and(eq(sponsorships[key], value), gt(sponsorships.preparedAt, since)));
    for (const [key, value] of [
        ['wallet', wallet],
        ['ip', ip],
    ] as const) {
        if (value === null) continue;
        const [{ count: used, oldest }] = await built(key, value);
        if (used >= PREPARE_LIMITS[key]) {
            return { limit: 'prepare', retryAfterSeconds: retryAfter(oldest, HOUR_MS, now) };
        }
    }
    return sendLimit(db, wallet, ip, kind, now);
}

/** Whether the sponsor already paid for `wallet`'s account in the asset `mint`, which its owner can close. */
export async function assetAccountPaid(db: Reader, wallet: string, mint: string, except?: number): Promise<boolean> {
    const [row] = await db
        .select({ id: sponsorships.id })
        .from(sponsorships)
        .where(
            and(
                eq(sponsorships.wallet, wallet),
                eq(sponsorships.assetAccount, mint),
                inArray(sponsorships.outcome, SPENT),
                ...(except === undefined ? [] : [ne(sponsorships.id, except)]),
            ),
        )
        .limit(1);
    return row !== undefined;
}

export type Prepared = typeof sponsorships.$inferInsert;

/**
 * Records a transaction the route built, simulated and handed to the wallet. The same wallet asking twice within one
 * blockhash gets the same message, recorded once.
 */
export async function recordPrepared(db: Database, prepared: Prepared) {
    await db.insert(sponsorships).values(prepared).onConflictDoNothing({ target: sponsorships.message });
}

/** A claim to co-sign a prepared message, or why it cannot be sent. */
export type Claim =
    | { ok: true; row: typeof sponsorships.$inferSelect }
    | { ok: false; reason: 'asset-account' | 'unknown' }
    | ({ ok: false; reason: 'limited' } & Limited);

/**
 * Claims the prepared message whose hash is `message` for sending: only a message this route built for `wallet`
 * within {@link PREPARED_TTL_MS} and never sent, within the send limits, and creating no asset account the sponsor
 * already paid for. The claim counts at once under a lock, so concurrent requests cannot both pass.
 */
export async function claimSend(
    db: Database,
    { ip, message, wallet }: { ip: string | null; message: string; wallet: string },
    now = new Date(),
): Promise<Claim> {
    return db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(${SPONSOR_LOCK})`);
        const [row] = await tx
            .select()
            .from(sponsorships)
            .where(
                and(
                    eq(sponsorships.message, message),
                    eq(sponsorships.wallet, wallet),
                    eq(sponsorships.outcome, 'prepared'),
                    gt(sponsorships.preparedAt, new Date(now.getTime() - PREPARED_TTL_MS)),
                ),
            )
            .limit(1);
        if (!row) return { ok: false, reason: 'unknown' };
        const limited = await sendLimit(tx, wallet, ip, row.kind, now);
        if (limited) return { ok: false, reason: 'limited', ...limited };
        if (row.assetAccount && (await assetAccountPaid(tx, wallet, row.assetAccount, row.id))) {
            return { ok: false, reason: 'asset-account' };
        }
        const [sent] = await tx
            .update(sponsorships)
            .set({ ip: ip ?? row.ip, outcome: 'sent', sentAt: now })
            .where(eq(sponsorships.id, row.id))
            .returning();
        return { ok: true, row: sent! };
    });
}

/** Records what became of a sent transaction: landed with its signature, or failed and why. */
export async function settleSend(
    db: Database,
    id: number,
    outcome: { landed: true; signature: string } | { landed: false; reason: string; signature?: string },
) {
    await db
        .update(sponsorships)
        .set(
            outcome.landed
                ? { outcome: 'landed', signature: outcome.signature }
                : { outcome: 'failed', reason: outcome.reason, signature: outcome.signature ?? null },
        )
        .where(eq(sponsorships.id, id));
}

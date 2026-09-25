import {
    type Config,
    DAY_SECONDS,
    divEuclid,
    LATERITE_ERROR__PRICE_UNAVAILABLE,
    LATERITE_ERROR__STALE_PRICE,
    LateriteCheckError,
    type MarketCalendar,
    quote,
} from '@laterite/client';
import { PythProRequestError } from '@laterite/client/node';
import { type Database, swapAccountCreations, sweeps } from '@laterite/db';
import type { TokenSymbol } from '@laterite/devnet/addresses';
import type { Address, GetBalanceApi, GetMultipleAccountsApi, ReadonlyUint8Array, Rpc } from '@solana/kit';
import { fetchAllMaybeToken } from '@solana-program/token-2022';
import { findAssociatedTokenPda } from '@solana-program/token';
import { desc, eq, gt } from 'drizzle-orm';

/** What each alarm tolerates; a change is a reviewed code change, like the program's caps. */
export const THRESHOLDS = {
    /** The crank pays sweep and attestation fees and the attestation records' rent (returned after a week). */
    crankLamports: 500_000_000n,
    /** The deploy runbook tops the sponsor up to 1 SOL whenever it holds less than this. */
    sponsorLamports: 500_000_000n,
    /** The devnet assets runbook tops the treasury up whenever it holds less than this. */
    treasuryLamports: 500_000_000n,
    /** Half of the treasury's inventory target, below which the devnet assets runbook mints more (raw units). */
    treasuryTokens: {
        QQQx: 25n * 10n ** 8n,
        SPYx: 25n * 10n ** 8n,
        USDC: 20_000n * 10n ** 6n,
        USDT: 20_000n * 10n ** 6n,
    } satisfies Record<TokenSymbol, bigint>,
    /** Days before the market calendar's `validThrough` that the reload is due. */
    calendarDays: 90n,
    /** Twice the sweep's 60 s price age: Kamino Scope posts SPYX/QQQX about every 42 s. */
    priceAgeSeconds: 120n,
    /**
     * The largest asset update a sweep has room for: the 1,197 bytes the largest executed route (2,899 of 4,096)
     * left free, above the 548-byte update it carried.
     */
    assetUpdateBytes: 1_745,
    /**
     * Received less `min_out` of the crank's latest sweep, in basis points of `min_out`, per cluster: Jupiter's real
     * routes on mainnet; on devnet the stand-in pool's 25 bps fee and the 10 bps re-peg band already take 35 of the
     * 55, so a lower figure there means the re-peg lags Pyth.
     */
    headroomBps: { devnet: 5, mainnet: 20 } satisfies Record<string, number>,
    /** Swap-authority accounts the crank may create in a day; a route needing more waits for an operator. */
    swapAccountCreationsPerDay: 5,
    /** How long the indexer may go without a successful poll. */
    indexerStallMs: 5 * 60 * 1_000,
};

const sol = (lamports: bigint) => `${Number(lamports) / 1e9} SOL`;

/**
 * The market-calendar alarm (fail closed): at once when the calendar does not cover today, since weekly-engine users
 * then buy nothing, `pending` included; and when `validThrough` is less than 90 days away.
 */
export function calendarAlarm(calendar: MarketCalendar, now: bigint, cluster: string): string | null {
    const today = divEuclid(now, DAY_SECONDS);
    const reload = `update programs/laterite/data/nyse-calendar.json and run \`just market-calendar ${cluster}\``;
    if (today < calendar.firstDay || today > calendar.validThrough) {
        return `the market calendar does not cover today, so weekly-engine users buy nothing: ${reload}`;
    }
    const left = BigInt(calendar.validThrough) - today;
    if (left < THRESHOLDS.calendarDays) {
        const through = new Date(Number(BigInt(calendar.validThrough) * DAY_SECONDS) * 1_000)
            .toISOString()
            .slice(0, 10);
        return `the market calendar ends in ${left} days (${through}): ${reload}`;
    }
    return null;
}

type Wallets = { crank: Address; treasury: Address };

/** The SOL alarms of the crank, the sponsor and the treasury, and the treasury's token inventory. */
export async function balanceAlarms(
    rpc: Rpc<GetBalanceApi & GetMultipleAccountsApi>,
    config: Config,
    wallets: Wallets,
    tokens: Record<TokenSymbol, { mint: Address; tokenProgram: Address }>,
    cluster: string,
): Promise<Record<string, string | null>> {
    const balance = async (address: Address) =>
        (await rpc.getBalance(address, { commitment: 'confirmed' }).send()).value;
    const [crank, sponsor, treasury] = await Promise.all([
        balance(wallets.crank),
        balance(config.sponsor),
        balance(wallets.treasury),
    ]);
    const symbols = Object.keys(THRESHOLDS.treasuryTokens) as TokenSymbol[];
    const accounts = await Promise.all(
        symbols.map(async symbol => {
            const { mint, tokenProgram } = tokens[symbol];
            return (await findAssociatedTokenPda({ mint, owner: wallets.treasury, tokenProgram }))[0];
        }),
    );
    const inventory = await fetchAllMaybeToken(rpc, accounts);
    const states: Record<string, string | null> = {
        'balance-crank':
            crank < THRESHOLDS.crankLamports
                ? `the crank ${wallets.crank} holds ${sol(crank)}, below ${sol(THRESHOLDS.crankLamports)}: fund it, since it pays sweep and attestation fees and record rent`
                : null,
        'balance-sponsor':
            sponsor < THRESHOLDS.sponsorLamports
                ? `the sponsor ${config.sponsor} holds ${sol(sponsor)}, below ${sol(THRESHOLDS.sponsorLamports)}: run \`just devnet-deploy ${cluster}\`, which tops it up to 1 SOL`
                : null,
        'balance-treasury':
            treasury < THRESHOLDS.treasuryLamports
                ? `the treasury ${wallets.treasury} holds ${sol(treasury)}, below ${sol(THRESHOLDS.treasuryLamports)}: run \`just devnet-assets ${cluster}\``
                : null,
    };
    symbols.forEach((symbol, index) => {
        const account = inventory[index]!;
        const amount = account.exists ? account.data.amount : 0n;
        const minimum = THRESHOLDS.treasuryTokens[symbol];
        states[`inventory-${symbol}`] =
            amount < minimum
                ? `the treasury holds ${amount} raw ${symbol}, below ${minimum}: run \`just devnet-assets ${cluster}\`, which mints its inventory back`
                : null;
    });
    return states;
}

/**
 * The Kamino Scope relay alarms: per asset feed, fired when no recent Scope post carries it (sweeps into that asset
 * fail with `PriceUnavailable`) or the latest one that does is older than 120 s (they would fail with `StalePrice`);
 * and when the update outgrows the room a sweep has for it.
 */
export function kaminoAlarms(
    latest: ReadonlyMap<number, { message: ReadonlyUint8Array }>,
    feeds: readonly { feedId: number; name: string }[],
    now: bigint,
    maxBytes = THRESHOLDS.assetUpdateBytes,
): Record<string, string | null> {
    const states: Record<string, string | null> = {};
    let largest = 0;
    for (const { feedId, name } of feeds) {
        const update = latest.get(feedId);
        if (!update) {
            states[`price-${name}`] =
                `no recent Kamino Scope post carries ${name} (feed ${feedId}): sweeps into it fail with PriceUnavailable`;
            continue;
        }
        largest = Math.max(largest, update.message.length);
        try {
            quote(update.message, feedId, now, THRESHOLDS.priceAgeSeconds);
            states[`price-${name}`] = null;
        } catch (error) {
            if (!(error instanceof LateriteCheckError)) throw error;
            states[`price-${name}`] =
                error.code === LATERITE_ERROR__STALE_PRICE
                    ? `Kamino Scope has posted no ${name} (feed ${feedId}) for more than ${THRESHOLDS.priceAgeSeconds} s: sweeps fail with StalePrice`
                    : error.code === LATERITE_ERROR__PRICE_UNAVAILABLE
                      ? `Kamino Scope's latest ${name} (feed ${feedId}) has no complete price: sweeps fail with PriceUnavailable`
                      : null;
        }
    }
    states['price-update-size'] =
        largest > maxBytes
            ? `Kamino Scope's update is ${largest} bytes, above the ${maxBytes} a sweep has room for: sweeps would not fit in a transaction`
            : null;
    return states;
}

/** Fires when Pyth Pro refuses the access token (401, 403) or rate-limits it (429): USDT sweeps stop, failing closed. */
export async function pythTokenAlarm(fetchUpdate: () => Promise<unknown>): Promise<Record<string, string | null>> {
    try {
        await fetchUpdate();
        return { 'pyth-pro-token': null };
    } catch (error) {
        if (error instanceof PythProRequestError && [401, 403, 429].includes(error.status)) {
            return {
                'pyth-pro-token': `Pyth Pro answers ${error.status} to the USDT/USD request: USDT sweeps stop until the access token works again`,
            };
        }
        throw error;
    }
}

/** Fires when the crank's latest sweep landed less than the cluster's threshold above its `min_out`. */
export async function headroomAlarm(
    db: Database,
    crank: Address,
    cluster: keyof typeof THRESHOLDS.headroomBps,
): Promise<Record<string, string | null>> {
    const threshold = THRESHOLDS.headroomBps[cluster];
    const [latest] = await db
        .select({ headroomBps: sweeps.headroomBps, signature: sweeps.signature })
        .from(sweeps)
        .where(eq(sweeps.feePayer, crank))
        .orderBy(desc(sweeps.slot))
        .limit(1);
    const low = latest && latest.headroomBps !== null && latest.headroomBps < threshold;
    return {
        'sweep-headroom': low
            ? `the crank's latest sweep ${latest.signature} landed ${latest.headroomBps} bps above min_out, below ${threshold} on ${cluster}: SLIPPAGE_BPS is getting tight for its routes`
            : null,
    };
}

/** Fires when the crank reached the day's bound on new swap-authority accounts: routes needing another wait. */
export async function swapAccountAlarm(db: Database, now: Date): Promise<Record<string, string | null>> {
    const since = new Date(now.getTime() - Number(DAY_SECONDS) * 1_000);
    const created = await db.$count(swapAccountCreations, gt(swapAccountCreations.createdAt, since));
    return {
        'swap-account-creations':
            created >= THRESHOLDS.swapAccountCreationsPerDay
                ? `the crank created ${created} swap-authority accounts in 24 hours, the bound: routes needing another wait; review them`
                : null,
    };
}

/** Fires when the indexer has not finished a poll for five minutes (its RPC or the database is failing). */
export function indexerAlarm(
    lastSuccessAt: number | null,
    startedAt: number,
    now: number,
): Record<string, string | null> {
    const since = lastSuccessAt ?? startedAt;
    return {
        indexer:
            now - since > THRESHOLDS.indexerStallMs
                ? `the indexer has stored nothing for ${Math.round((now - since) / 60_000)} minutes: check the RPC and the database`
                : null,
    };
}

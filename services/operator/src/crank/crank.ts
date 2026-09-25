import {
    type Config,
    DAY_SECONDS,
    decodeUserConfig,
    divEuclid,
    Engine,
    enabledPaymentTokens,
    fetchConfig,
    fetchPythStorage,
    fetchSweepState,
    findConfigPda,
    findSwapAuthorityPda,
    findSweptEvent,
    getSweepInstructions,
    getSweepPull,
    LATERITE_ERROR__ALREADY_SWEPT,
    LATERITE_ERROR__NOTHING_TO_SWEEP,
    LATERITE_ERROR__PRICE_UNCERTAIN,
    LATERITE_ERROR__STALE_PRICE,
    LATERITE_PROGRAM_ADDRESS,
    LateriteCheckError,
    minOut,
    type Pull,
    pull,
    pullTotal,
    type PythStorage,
    type Quote,
    quote,
    RestoreRequiredError,
    secondsToNextSweepBoundary,
    SWEEP_BOUNDARY_MARGIN_SECONDS,
    USD_DECIMALS,
    USER_CONFIG_DISCRIMINATOR,
    type UserConfig,
    UserStatus,
    usMarketOpen,
} from '@laterite/client';
import { type Database, sweepAttempts } from '@laterite/db';
import {
    type Address,
    type Base58EncodedBytes,
    getBase58Decoder,
    isSolanaError,
    parseBase64RpcAccount,
    type Rpc,
    SOLANA_ERROR__TRANSACTION__EXCEEDS_SIZE_LIMIT,
    type SolanaRpcApi,
    type TransactionSigner,
    unwrapOption,
} from '@solana/kit';
import { fetchSysvarClock } from '@solana/sysvars';
import { fetchAllMint } from '@solana-program/token-2022';
import { findAssociatedTokenPda } from '@solana-program/token';
import { eq, sql } from 'drizzle-orm';

import type { Alarms } from '../alarms/alarms';
import type { Logger } from '../log';
import { ComputeLimitExceededError, type Sender, TransactionFailedError } from '../send';
import { lateriteErrorName, sweepFailure } from './failures';
import { MAX_ASSET_UPDATE_AGE_SECONDS, type PriceUpdates } from './prices';
import { isRepegRefusal, type Repegger } from './repeg';
import { NoRouteError, type Routes, SwapAccountBoundError } from './routes';

/** The largest compute limit a sweep is sent with: 490,000, from 407,143 on the worst of 677 real Jupiter routes. */
export const MAX_SWEEP_COMPUTE_UNIT_LIMIT = 490_000;
/** Builds of one sweep in a run: the first, a rebuild after a changed pull, and one with a fresh route. */
const MAX_BUILDS = 3;
/** Failed attempts at one token's sweep in a day before the crank skips it until the next. */
export const MAX_FAILED_ATTEMPTS_PER_DAY = 12;
/** How long a token waits after each kind of setback, in milliseconds, doubling with each failed attempt that day. */
export const RETRY_AFTER_MS = { alert: 600_000, nothing: 300_000, price: 30_000, slippage: 60_000, unknown: 120_000 };

/** A payment token of an enrolled user that the crank may sweep today. */
export type Candidate = { paymentToken: number; user: UserConfig };

const today = (now: bigint) => Number(divEuclid(now, DAY_SECONDS));
const U64_MAX = 2n ** 64n - 1n;

/** Whether `Config.market_calendar` covers the day of `now`: without it no weekly-engine user is swept. */
export function calendarCovers(config: Config, now: bigint): boolean {
    const day = today(now);
    return day >= config.marketCalendar.firstDay && day <= config.marketCalendar.validThrough;
}

/**
 * The payment tokens worth reading at `now`, from each user's `UserConfig` alone: an active user's enabled token not
 * swept today whose pull could be positive with any balance (an engine due or `pending`, within the week's room), and
 * for a weekly-engine user only inside a regular NYSE session (the builders' `usMarketOpen`, `pending` included).
 * The token's balance, cushion, subscription and approval are read before building ({@link getSweepPull}).
 */
export function sweepCandidates(users: Iterable<UserConfig>, config: Config, now: bigint): Candidate[] {
    const candidates: Candidate[] = [];
    const day = today(now);
    const open = usMarketOpen(now, config.marketCalendar);
    for (const user of users) {
        if (user.status !== UserStatus.Active || (user.engine === Engine.Weekly && !open)) continue;
        for (const paymentToken of enabledPaymentTokens(user.paymentTokens)) {
            if (user.lastSweepDay[paymentToken]! >= day) continue;
            const upperBound = pull(user, paymentToken, U64_MAX, config.userWeeklyCap, config.marketCalendar, now);
            if (pullTotal(upperBound) > 0n) candidates.push({ paymentToken, user });
        }
    }
    return candidates;
}

export type CrankInput = {
    alarms: Alarms;
    /** Signs and pays for sweeps. */
    crank: TransactionSigner;
    db: Database;
    log: Logger;
    prices: PriceUpdates;
    /** Devnet only: re-pegs the sweep's pool to the updates it carries. */
    repegger?: Repegger;
    /** How long a token waits after each kind of setback ({@link RETRY_AFTER_MS} by default). */
    retryAfterMs?: typeof RETRY_AFTER_MS;
    routes: Routes;
    rpc: Rpc<SolanaRpcApi>;
    sender: Pick<Sender, 'sendVersion1'>;
};

type Attempt = Omit<typeof sweepAttempts.$inferInsert, 'day' | 'paymentToken' | 'user'>;

/**
 * The sweep runner: at most one sweep per user, payment token and UTC day, whoever the engine, built right before
 * sending from the cluster's state (`fetchSweepState`, `getSweepPull`, a route, `getSweepInstructions`) with the latest
 * relayed asset update and, for USDT, a token-fetched USDT update; sent as one version 1 transaction, simulated first,
 * its limits from the simulation, never above {@link MAX_SWEEP_COMPUTE_UNIT_LIMIT}. Every attempt and every day's
 * final word is recorded in `sweep_attempts`, and failures are handled as the outcome table says.
 */
export class Crank {
    /** When the last run finished without an error, in milliseconds. */
    lastSuccessAt: number | null = null;
    /** The UTC day of the cluster's clock at the last run. */
    day: number | null = null;

    /** When each deferred token may be read again: a host time for backoffs, a cluster time for boundaries. */
    private readonly deferred = new Map<string, { atClock?: bigint; atMs?: number }>();
    private readonly retryAfterMs: typeof RETRY_AFTER_MS;
    private readonly excluded = new Map<string, { day: number; venues: Set<string> }>();
    private readonly held = new Set<string>();
    private alarmStates: Record<string, string | null> = {};
    /** The first day not yet closed by {@link closeDays}, and the day of the last run. */
    private closedBefore = 0;
    private storage: { at: number; value: PythStorage } | undefined;

    constructor(private readonly input: CrankInput) {
        this.retryAfterMs = input.retryAfterMs ?? RETRY_AFTER_MS;
    }

    /**
     * One run: closes the days that ended with only failed attempts, then, unless the kill switch is on, sweeps every
     * candidate in turn.
     */
    async tick(): Promise<void> {
        const { db, log, rpc } = this.input;
        const [{ data: config }, clock] = await Promise.all([
            fetchConfig(rpc, (await findConfigPda())[0], { commitment: 'confirmed' }),
            fetchSysvarClock(rpc, { commitment: 'confirmed' }),
        ]);
        const now = clock.unixTimestamp;
        this.day = today(now);
        if (today(now) > this.closedBefore) {
            await this.closeDays(today(now));
            this.closedBefore = today(now);
        }
        this.alarmStates = {
            'repeg-before-sweep': null,
            'sweep-bug': null,
            'sweep-compute': null,
            'sweep-route': null,
            'sweep-size': null,
        };
        if (config.paused) {
            this.hold(`kill-switch:${today(now)}`, 'the kill switch is on: no sweeps until it is off');
            this.lastSuccessAt = Date.now();
            return;
        }
        if (!calendarCovers(config, now)) {
            this.hold(`calendar:${today(now)}`, 'the market calendar does not cover today: no weekly-engine sweeps');
        }
        const [users, { decided, failures: failed }, paused] = await Promise.all([
            this.users(),
            this.decidedToday(today(now)),
            this.pausedAssets(config),
        ]);
        const due = sweepCandidates(users, config, now).filter(({ paymentToken, user }) => {
            const key = `${user.user}:${paymentToken}`;
            const { atClock = 0n, atMs = 0 } = this.deferred.get(key) ?? {};
            return !decided.has(key) && atMs <= Date.now() && atClock <= now;
        });
        for (const candidate of due) {
            const failures = failed.get(`${candidate.user.user}:${candidate.paymentToken}`) ?? 0;
            try {
                await this.sweep(candidate, config, paused, failures);
            } catch (error) {
                log.error(
                    { err: error, paymentToken: candidate.paymentToken, user: candidate.user.user },
                    'sweep failed',
                );
                this.defer(candidate, this.retryAfterMs.unknown, failures);
            }
        }
        await this.input.alarms.set(this.alarmStates);
        this.lastSuccessAt = Date.now();
    }

    /**
     * Builds and sends `candidate`'s sweep, reading the state again after a changed pull, a refetch or a fresh route,
     * at most {@link MAX_BUILDS} times, and records what happened.
     */
    async sweep(candidate: Candidate, config: Config, paused: ReadonlySet<Address>, failures: number): Promise<void> {
        const { crank, log, prices, repegger, routes, rpc, sender } = this.input;
        const user = candidate.user.user;
        const { paymentToken } = candidate;
        const key = `${user}:${paymentToken}`;
        let asset = candidate.user.asset;
        let rebuiltAfter: bigint | undefined;
        let refetched = false;
        let freshRoute = false;
        for (let build = 0; build < MAX_BUILDS; build++) {
            const started = Date.now();
            const assetEntry = config.assets[asset]!;
            const token = config.paymentTokens[paymentToken]!;
            const clock = (await fetchSysvarClock(rpc, { commitment: 'confirmed' })).unixTimestamp;
            if (paused.has(assetEntry.mint)) {
                await this.record(candidate, today(clock), { outcome: 'failed', reason: 'AssetPaused' });
                return this.defer(candidate, this.retryAfterMs.nothing, failures + 1);
            }
            // The asset update first, since waiting for Kamino Scope's next post moves the clock the state is read at.
            const assetUpdate = await prices.asset(assetEntry.pythFeedId, clock);
            const state = await fetchSweepState(rpc, { config, paymentToken, user });
            const stateDay = today(state.now);
            if (state.userConfig.asset !== asset) {
                asset = state.userConfig.asset;
                continue;
            }
            let pulled: Pull;
            try {
                pulled = getSweepPull(state);
            } catch (error) {
                if (error instanceof RestoreRequiredError) {
                    return this.record(candidate, stateDay, {
                        outcome: 'skipped',
                        reason: `RestoreRequired ${error.reason}`,
                    });
                }
                if (error instanceof LateriteCheckError && error.code === LATERITE_ERROR__ALREADY_SWEPT) {
                    return this.record(candidate, stateDay, { outcome: 'already_swept', reason: 'AlreadySwept' });
                }
                if (error instanceof LateriteCheckError && error.code === LATERITE_ERROR__NOTHING_TO_SWEEP) {
                    return this.defer(candidate, this.retryAfterMs.nothing, 0);
                }
                throw error;
            }
            const toBoundary = secondsToNextSweepBoundary(state);
            if (toBoundary < SWEEP_BOUNDARY_MARGIN_SECONDS) {
                log.info(
                    { paymentToken, seconds: Number(toBoundary), user },
                    'sweep waits for a pull-changing boundary',
                );
                this.deferred.set(key, { atClock: state.now + toBoundary });
                return;
            }
            const amount = pullTotal(pulled);
            const priced: Attempt = {
                outcome: 'failed',
                priceAgeSeconds: assetUpdate ? Number(state.now - assetUpdate.updatedAt) : null,
                priceWaitMs: assetUpdate?.waitedMs ?? null,
                pull: amount,
            };
            if (!assetUpdate) {
                await this.record(candidate, stateDay, { ...priced, reason: 'StalePrice' });
                return this.defer(candidate, this.retryAfterMs.price, failures + 1);
            }
            const paymentUpdate = token.usdFeedId === 0 ? undefined : await prices.payment(token.usdFeedId, state.now);
            let assetQuote: Quote;
            let paymentQuote: Quote;
            try {
                assetQuote = quote(assetUpdate.message, assetEntry.pythFeedId, state.now, MAX_ASSET_UPDATE_AGE_SECONDS);
                paymentQuote = quote(paymentUpdate ?? new Uint8Array(), token.usdFeedId, state.now);
            } catch (error) {
                if (!(error instanceof LateriteCheckError)) throw error;
                const reason = lateriteErrorName(error.code);
                await this.record(candidate, stateDay, { ...priced, reason });
                if (error.code === LATERITE_ERROR__STALE_PRICE || error.code === LATERITE_ERROR__PRICE_UNCERTAIN) {
                    return this.defer(candidate, this.retryAfterMs.price, failures + 1);
                }
                this.alarm(
                    'sweep-bug',
                    `an update the relay kept fails the local checks with ${reason}: check the price sources`,
                );
                return this.defer(candidate, this.retryAfterMs.alert, failures + 1);
            }
            const minimum = minOut(amount, paymentQuote, USD_DECIMALS, assetQuote, assetEntry.decimals);
            try {
                await repegger?.before(
                    assetEntry.mint,
                    token.mint,
                    assetQuote,
                    token.usdFeedId === 0 ? null : paymentQuote,
                );
            } catch (error) {
                // A pool too far from Pyth is not traded; the sweep's route then quotes below `min_out` and waits.
                if (!isRepegRefusal(error)) throw error;
                this.alarm('repeg-before-sweep', `${error.message}: sweeps through the pool wait`);
            }
            const [[swapAuthority], [userAssetAccount], storage] = await Promise.all([
                findSwapAuthorityPda(),
                findAssociatedTokenPda({ mint: assetEntry.mint, owner: user, tokenProgram: assetEntry.tokenProgram }),
                this.pythStorage(),
            ]);
            const excluded = this.excluded.get(key);
            let route;
            try {
                route = await routes({
                    amount,
                    asset: assetEntry,
                    excludeVenues: excluded?.day === stateDay ? [...excluded.venues] : [],
                    payment: token,
                    swapAuthority,
                    userAssetAccount,
                });
            } catch (error) {
                if (error instanceof NoRouteError || error instanceof SwapAccountBoundError) {
                    await this.record(candidate, stateDay, { ...priced, minOut: minimum, reason: error.message });
                    return this.defer(candidate, this.retryAfterMs.slippage, failures + 1);
                }
                throw error;
            }
            const routed: Attempt = { ...priced, minOut: minimum, quoted: route.quoted, route: route.venues.join(' ') };
            if (route.quoted < minimum) {
                await this.record(candidate, stateDay, { ...routed, reason: 'quote below min_out' });
                if (freshRoute) return this.defer(candidate, this.retryAfterMs.slippage, failures + 1);
                freshRoute = true;
                continue;
            }
            const built = await getSweepInstructions({
                assetUpdate: assetUpdate.message,
                crank,
                paymentUpdate,
                pythTreasury: storage.treasury,
                route: route.instruction,
                state,
            });
            try {
                const landed = await sender.sendVersion1(built.instructions, {
                    maxComputeUnitLimit: MAX_SWEEP_COMPUTE_UNIT_LIMIT,
                });
                const swept = findSweptEvent(landed.executed);
                await this.record(candidate, stateDay, {
                    ...routed,
                    bytes: landed.size,
                    computeUnitLimit: landed.computeUnitLimit,
                    computeUnits: landed.computeUnits,
                    feeLamports: landed.fee,
                    latencyMs: Date.now() - started,
                    loadedAccountsDataSizeLimit: landed.loadedAccountsDataSizeLimit,
                    outcome: 'landed',
                    priorityFeeLamports: landed.priorityFeeLamports,
                    signature: landed.signature,
                });
                log.info(
                    {
                        minOut: minimum.toString(),
                        paymentToken,
                        received: swept?.received.toString(),
                        signature: landed.signature,
                        user,
                    },
                    'sweep landed',
                );
                this.deferred.delete(key);
                return;
            } catch (error) {
                if (error instanceof ComputeLimitExceededError) {
                    await this.record(candidate, stateDay, {
                        ...routed,
                        computeUnitLimit: error.computeUnitLimit,
                        reason: 'ComputeLimit',
                    });
                    this.alarm(
                        'sweep-compute',
                        `a sweep through ${routed.route} needs ${error.computeUnitLimit} compute units, above ${error.ceiling}: not sent`,
                    );
                    this.exclude(key, stateDay, route.venues);
                    continue;
                }
                if (isSolanaError(error, SOLANA_ERROR__TRANSACTION__EXCEEDS_SIZE_LIMIT)) {
                    await this.record(candidate, stateDay, {
                        ...routed,
                        outcome: 'skipped',
                        reason: 'TransactionTooLarge',
                    });
                    this.alarm('sweep-size', `a sweep through ${routed.route} does not fit 4,096 bytes: not sent`);
                    return;
                }
                if (!(error instanceof TransactionFailedError)) {
                    await this.record(candidate, stateDay, {
                        ...routed,
                        reason: error instanceof Error ? error.message : String(error),
                    });
                    return this.defer(candidate, this.retryAfterMs.unknown, failures + 1);
                }
                const failure = sweepFailure(error.cause, error.logs, config.router);
                const failed: Attempt = { ...routed, reason: failure.reason, signature: error.signature ?? null };
                log.warn({ ...failure, paymentToken, signature: error.signature, user }, 'sweep failed');
                switch (failure.action) {
                    case 'swept':
                        return this.record(candidate, stateDay, { ...failed, outcome: 'already_swept' });
                    case 'pull':
                        return this.record(candidate, stateDay, { ...failed, outcome: 'pull_failed' });
                    case 'recompute':
                        await this.record(candidate, stateDay, failed);
                        continue;
                    case 'rebuild':
                        await this.record(candidate, stateDay, failed);
                        if (rebuiltAfter === amount) {
                            this.alarm(
                                'sweep-route',
                                `${failure.reason} twice with the same pull through ${routed.route}: that route is skipped today`,
                            );
                            this.exclude(key, stateDay, route.venues);
                            return this.defer(candidate, this.retryAfterMs.slippage, failures + 1);
                        }
                        rebuiltAfter = amount;
                        continue;
                    case 'refetch':
                        await this.record(candidate, stateDay, failed);
                        if (refetched) return this.defer(candidate, this.retryAfterMs.unknown, failures + 1);
                        refetched = true;
                        config = (await fetchConfig(rpc, (await findConfigPda())[0], { commitment: 'confirmed' })).data;
                        if (config.paused) return;
                        continue;
                    case 'slippage':
                        await this.record(candidate, stateDay, failed);
                        if (freshRoute) return this.defer(candidate, this.retryAfterMs.slippage, failures + 1);
                        freshRoute = true;
                        continue;
                    case 'venue':
                        await this.record(candidate, stateDay, failed);
                        this.exclude(key, stateDay, route.venues);
                        continue;
                    case 'price':
                        await this.record(candidate, stateDay, failed);
                        return this.defer(candidate, this.retryAfterMs.price, failures + 1);
                    case 'alert':
                        await this.record(candidate, stateDay, failed);
                        this.alarm(
                            'sweep-bug',
                            `a sweep failed with ${failure.reason}, which the local checks should catch`,
                        );
                        return this.defer(candidate, this.retryAfterMs.alert, failures + 1);
                    default:
                        await this.record(candidate, stateDay, failed);
                        return this.defer(candidate, this.retryAfterMs.unknown, failures + 1);
                }
            }
        }
        this.defer(candidate, this.retryAfterMs.unknown, failures + 1);
    }

    /** The day's recorded attempts by outcome, for the health check. */
    async outcomes(day: number): Promise<Record<string, number>> {
        const rows = await this.input.db
            .select({ count: sql<number>`count(*)::integer`, outcome: sweepAttempts.outcome })
            .from(sweepAttempts)
            .where(eq(sweepAttempts.day, day))
            .groupBy(sweepAttempts.outcome);
        return Object.fromEntries(rows.map(({ count, outcome }) => [outcome, count]));
    }

    /** Pyth Pro's storage on the cluster, read again every ten minutes: the treasury a sweep pays. */
    private async pythStorage() {
        if (!this.storage || Date.now() - this.storage.at > 600_000) {
            this.storage = { at: Date.now(), value: await fetchPythStorage(this.input.rpc) };
        }
        return this.storage.value;
    }

    /** Every enrolled user's `UserConfig`, at the confirmed commitment. */
    private async users(): Promise<UserConfig[]> {
        const accounts = await this.input.rpc
            .getProgramAccounts(LATERITE_PROGRAM_ADDRESS, {
                commitment: 'confirmed',
                encoding: 'base64',
                filters: [
                    {
                        memcmp: {
                            bytes: getBase58Decoder().decode(USER_CONFIG_DISCRIMINATOR) as Base58EncodedBytes,
                            encoding: 'base58',
                            offset: 0n,
                        },
                    },
                ],
            })
            .send();
        return accounts.map(({ account, pubkey }) => decodeUserConfig(parseBase64RpcAccount(pubkey, account)).data);
    }

    /**
     * Today's decided tokens (landed, skipped, a pull failure, swept by someone else, or at the day's bound of failed
     * attempts) and each token's failed attempts so far.
     */
    private async decidedToday(day: number) {
        const rows = await this.input.db
            .select({
                decided: sql<boolean>`bool_or(${sweepAttempts.outcome} <> 'failed')`,
                failures: sql<number>`(count(*) filter (where ${sweepAttempts.outcome} = 'failed'))::integer`,
                paymentToken: sweepAttempts.paymentToken,
                user: sweepAttempts.user,
            })
            .from(sweepAttempts)
            .where(eq(sweepAttempts.day, day))
            .groupBy(sweepAttempts.user, sweepAttempts.paymentToken);
        const decided = new Set<string>();
        const failures = new Map<string, number>();
        for (const row of rows) {
            const key = `${row.user}:${row.paymentToken}`;
            failures.set(key, row.failures);
            if (row.decided || row.failures >= MAX_FAILED_ATTEMPTS_PER_DAY) decided.add(key);
        }
        return { decided, failures };
    }

    /** The asset mints their issuer paused (Token-2022 Pausable): a sweep into one would fail inside the route. */
    private async pausedAssets(config: Config): Promise<Set<Address>> {
        const mints = await fetchAllMint(
            this.input.rpc,
            config.assets.map(({ mint }) => mint),
            { commitment: 'confirmed' },
        );
        const paused = new Set<Address>();
        for (const mint of mints) {
            const extensions = unwrapOption(mint.data.extensions) ?? [];
            if (extensions.some(extension => extension.__kind === 'PausableConfig' && extension.paused)) {
                paused.add(mint.address);
            }
        }
        return paused;
    }

    /**
     * Records a skip for each token of an earlier day whose attempts all failed (retries that never passed, as for a
     * price that stayed stale or uncertain), with the last failure's reason.
     */
    private async closeDays(day: number) {
        await this.input.db.execute(sql`
            insert into ${sweepAttempts} ("user", payment_token, day, outcome, reason)
            select "user", payment_token, day, 'skipped', (array_agg(reason order by id desc))[1]
            from ${sweepAttempts}
            where day < ${day}
            group by "user", payment_token, day
            having bool_and(outcome = 'failed')`);
    }

    private async record(candidate: Candidate, day: number, attempt: Attempt) {
        await this.input.db
            .insert(sweepAttempts)
            .values({ ...attempt, day, paymentToken: candidate.paymentToken, user: candidate.user.user });
    }

    /** Leaves `candidate` until `afterMs` from now, doubled for each failed attempt today (at most a day). */
    private defer(candidate: Candidate, afterMs: number, failures: number) {
        const wait = Math.min(afterMs * 2 ** Math.max(0, failures - 1), 86_400_000);
        this.deferred.set(`${candidate.user.user}:${candidate.paymentToken}`, { atMs: Date.now() + wait });
    }

    private exclude(key: string, day: number, venues: readonly string[]) {
        const current = this.excluded.get(key);
        const excluded = current?.day === day ? current.venues : new Set<string>();
        for (const venue of venues) excluded.add(venue);
        this.excluded.set(key, { day, venues: excluded });
    }

    private alarm(key: string, message: string) {
        this.alarmStates[key] = message;
    }

    /** Logs why no sweep (or no weekly-engine sweep) runs, once per reason and day. */
    private hold(key: string, message: string) {
        if (this.held.has(key)) return;
        if (this.held.size > 64) this.held.clear();
        this.held.add(key);
        this.input.log.warn(message);
    }
}

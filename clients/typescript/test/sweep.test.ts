import { routeInstruction } from '@laterite/devnet';
import { addresses as devnet } from '@laterite/devnet/addresses';
import {
    getBase16Encoder,
    getCompiledTransactionMessageDecoder,
    getTransactionEncoder,
    isSolanaError,
    lamports,
    pipe,
    setTransactionMessageComputeUnitLimit,
    setTransactionMessageLifetimeUsingBlockhash,
    setTransactionMessageLoadedAccountsDataSizeLimit,
    SOLANA_ERROR__TRANSACTION__EXCEEDS_SIZE_LIMIT,
} from '@solana/kit';
import { getSubscriptionDelegationDecoder } from '@solana/subscriptions';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { describe, expect, it } from 'vitest';

import {
    createSweepTransactionMessage,
    DAY_SECONDS,
    DOLLAR_QUOTE,
    Engine,
    fetchPythStorage,
    fetchSweepState,
    findSweptEvent,
    findSwapAuthorityPda,
    findUserConfigPda,
    findVaultPda,
    getSetUserPausedInstructionAsync,
    getSweepInstructions,
    getSweepPull,
    getUserConfigEncoder,
    LATERITE_ERROR__ALREADY_SWEPT,
    LATERITE_ERROR__INVALID_PRICE_UPDATE,
    LATERITE_ERROR__INVALID_ROUTER,
    LATERITE_ERROR__NOTHING_TO_SWEEP,
    LATERITE_ERROR__STALE_PRICE,
    LateriteCheckError,
    minOut,
    PYTH_PRO_PROGRAM_ADDRESS,
    pullTotal,
    secondsToNextSweepBoundary,
    USD_DECIMALS,
    WEEK_SECONDS,
    cappedPull,
    getLateriteLogEvents,
    getMarketCalendarDecoder,
    parseUserPausedEvent,
    getUserConfigDecoder,
    nativeRemaining,
    pull,
    RestoreRequiredError,
    type SweepState,
} from '../src';
import { getPythUpdateFromTransaction } from '../src/node';
import { defaultParams, type Env, innerInstructions, unitsOf } from './env';
import { pythTestSigner, pythUpdate, sweepEnv, trust } from './sweep-env';
import {
    DOLLAR,
    PYTH,
    PYTH_SPYX_QQQX,
    PYTH_SPYX_QUOTE,
    PYTH_UPDATES_AT,
    PYTH_USDT,
    PYTH_USDT_QUOTE,
    vectors,
} from './fixtures';

type Swept = Awaited<ReturnType<typeof sweepEnv>>;

const assetAccount = async (owner: Swept['user']['address']) =>
    (
        await findAssociatedTokenPda({
            mint: devnet.tokens.SPYx.mint,
            owner,
            tokenProgram: devnet.tokens.SPYx.tokenProgram,
        })
    )[0];

const paymentAccount = async (owner: Swept['user']['address'], symbol: 'USDC' | 'USDT') =>
    (
        await findAssociatedTokenPda({
            mint: devnet.tokens[symbol].mint,
            owner,
            tokenProgram: devnet.tokens[symbol].tokenProgram,
        })
    )[0];

/** The sweep's instructions through the devnet CPMM, as the crank builds them from the cluster's state. */
async function build(
    { crank, env, user }: Swept,
    paymentToken: 0 | 1,
    updates?: { asset: Uint8Array; payment?: Uint8Array },
) {
    const state = await fetchSweepState(env.rpc, { config: env.config!, paymentToken, user: user.address });
    const pull = getSweepPull(state);
    const [swapAuthority] = await findSwapAuthorityPda();
    const route = await routeInstruction({
        amountIn: pullTotal(pull),
        ammConfig: devnet.cpmm.ammConfig,
        authority: swapAuthority,
        destination: await assetAccount(user.address),
        pool: devnet.pools[paymentToken === 0 ? 'SPYx-USDC' : 'SPYx-USDT'],
        tokens: devnet.tokens,
    });
    const storage = await fetchPythStorage(env.rpc);
    return getSweepInstructions({
        assetUpdate: updates?.asset ?? PYTH_SPYX_QQQX,
        crank,
        paymentUpdate: updates ? updates.payment : paymentToken === 1 ? PYTH_USDT : undefined,
        pythTreasury: storage.treasury,
        route,
        state,
    });
}

async function sweep(swept: Swept, paymentToken: 0 | 1) {
    const { instructions, minOut: minimum, pull } = await build(swept, paymentToken);
    const outcome = await swept.env.expectSuccess(swept.env.send(swept.crank, instructions, { version: 1 }));
    return { event: findSweptEvent(innerInstructions(outcome))!, minimum, outcome, pull };
}

async function writePending(env: Env, user: Swept['user'], pending: bigint) {
    const userConfig = await env.userConfig(user.address);
    const [address] = await findUserConfigPda({ user: user.address });
    env.write(
        address,
        new Uint8Array(getUserConfigEncoder().encode({ ...userConfig, pending })),
        'LatBPQotoZgdg8rsyBrCiy6qyqeALs185Z4pjkFTfZf' as never,
    );
}

const refusal = async (promise: Promise<unknown> | (() => unknown)) => {
    try {
        await (typeof promise === 'function' ? promise() : promise);
    } catch (error) {
        if (error instanceof LateriteCheckError) return error.code;
        throw error;
    }
    throw new Error('Expected a refusal');
};

describe('sweep builder', () => {
    it('lands the ADR-001 shape at the CU Benchmark baseline', async () => {
        for (const [paymentToken, size, units] of [
            [0, 1_793, 78_913n],
            [1, 1_959, 101_777n],
        ] as const) {
            const swept = await sweepEnv();
            const built = await build(swept, paymentToken);
            // The generated instruction fills in the vault's fixed address; the package derives the same one.
            expect(built.instructions[1].accounts![3]!.address).toBe((await findVaultPda())[0]);
            expect(built.size).toBe(size);
            const { outcome } = await sweep(swept, paymentToken);
            const message = getCompiledTransactionMessageDecoder().decode(outcome.transaction.messageBytes);
            // The program tests count a signature-count byte that a version 1 transaction does not carry: 1,794 and 1,960.
            expect(outcome.size).toBe(size);
            expect(outcome.result.computeUnitsConsumed()).toBe(units);
            expect(message.staticAccounts.length).toBe(32);
            // The relay reader reads version 1 transactions too: a USDC sweep carries the asset update at one entry.
            const carried = getPythUpdateFromTransaction(getTransactionEncoder().encode(outcome.transaction));
            if (paymentToken === 0) expect(carried).toEqual(PYTH_SPYX_QQQX);
        }
    });

    it("reads Swept from the sweep's inner instructions and the other events from Laterite's own log lines", async () => {
        const swept = await sweepEnv();
        const { outcome } = await sweep(swept, 0);
        expect(findSweptEvent(innerInstructions(outcome))!.user).toBe(swept.user.address);
        expect(getLateriteLogEvents(outcome.result.logs())).toEqual([]);
        const pause = await getSetUserPausedInstructionAsync({ paused: true, user: swept.user });
        const paused = await swept.env.expectSuccess(swept.env.send(swept.crank, [pause]));
        const events = getLateriteLogEvents(paused.result.logs());
        expect(events.map(event => parseUserPausedEvent(event))).toEqual([{ paused: true, user: swept.user.address }]);
    });

    it('refuses a sweep past 4,096 bytes', async () => {
        const swept = await sweepEnv();
        const state = await fetchSweepState(swept.env.rpc, {
            config: swept.env.config!,
            paymentToken: 0,
            user: swept.user.address,
        });
        const { instructions } = await build(swept, 0);
        const route = { ...instructions[1], data: new Uint8Array(2_400), programAddress: swept.env.config!.router };
        const oversized = getSweepInstructions({
            assetUpdate: PYTH_SPYX_QQQX,
            crank: swept.crank,
            pythTreasury: PYTH.devnet.treasury,
            route,
            state,
        });
        await expect(oversized).rejects.toSatisfy(error =>
            isSolanaError(error, SOLANA_ERROR__TRANSACTION__EXCEEDS_SIZE_LIMIT),
        );
    });

    it('builds the message with provisory limits of the same size', async () => {
        const swept = await sweepEnv();
        const { instructions } = await build(swept, 1);
        const lifetime = { blockhash: swept.env.svm.latestBlockhash(), lastValidBlockHeight: 0n };
        const message = pipe(
            createSweepTransactionMessage({ crank: swept.crank, instructions }),
            m => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
            m => setTransactionMessageComputeUnitLimit(400_000, m),
            m => setTransactionMessageLoadedAccountsDataSizeLimit(8 * 1024 * 1024, m),
        );
        expect((await swept.env.expectSuccess(swept.env.sendMessage(message))).size).toBe(1_959);
        const priced = pipe(
            createSweepTransactionMessage({ crank: swept.crank, instructions, priorityFeeLamports: lamports(5_000n) }),
            m => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
        );
        const withFee = await swept.env.sendMessage(priced);
        console.log('sweep with a priority fee:', withFee.size, 'bytes');
        expect(withFee.size).toBe(1_959 + 8);
    });

    for (const cluster of ['devnet', 'mainnet'] as const) {
        it(`sweeps USDC and USDT with the real updates on ${cluster}'s Pyth Pro and decodes Swept`, async () => {
            const swept = await sweepEnv(defaultParams(), cluster);
            const { env, user } = swept;
            await writePending(env, user, 3n * DOLLAR);
            const treasury = env.balance(PYTH[cluster].treasury);
            const before = env.tokenAmount(await paymentAccount(user.address, 'USDC'));

            const usdc = await sweep(swept, 0);
            expect(usdc.pull).toEqual({ engine: DOLLAR, pending: 3n * DOLLAR });
            expect(unitsOf(usdc.outcome.result, PYTH_PRO_PROGRAM_ADDRESS)).toHaveLength(1);
            expect(env.balance(PYTH[cluster].treasury)).toBe(treasury + 1n);
            const expectedMin = minOut(4n * DOLLAR, DOLLAR_QUOTE, USD_DECIMALS, PYTH_SPYX_QUOTE, 8);
            expect(usdc.minimum).toBe(expectedMin);
            expect(usdc.event).toMatchObject({
                asset: 0,
                assetExponent: -8,
                assetPrice: PYTH_SPYX_QUOTE.price,
                engine: DOLLAR,
                minOut: expectedMin,
                paymentToken: 0,
                pending: 3n * DOLLAR,
                user: user.address,
            });
            expect(usdc.event.received).toBeGreaterThanOrEqual(expectedMin);
            expect(env.tokenAmount(await assetAccount(user.address))).toBe(usdc.event.received);
            expect(env.tokenAmount(await paymentAccount(user.address, 'USDC'))).toBe(before - 4n * DOLLAR);
            const [swapAuthority] = await findSwapAuthorityPda();
            expect(env.tokenAmount(await paymentAccount(swapAuthority, 'USDC'))).toBe(0n);
            const userConfig = await env.userConfig(user.address);
            expect([userConfig.weekSpent, userConfig.pending, userConfig.engineRanAt]).toEqual([
                4n * DOLLAR,
                0n,
                PYTH_UPDATES_AT,
            ]);
            expect(userConfig.lastSweepDay).toEqual([Number(PYTH_UPDATES_AT / DAY_SECONDS), 0]);

            // USDT is priced by its own verified update: a second verification, a second lamport to the treasury.
            const fresh = await sweepEnv(defaultParams(), cluster);
            const usdtTreasury = fresh.env.balance(PYTH[cluster].treasury);
            const usdt = await sweep(fresh, 1);
            expect(usdt.pull).toEqual({ engine: DOLLAR, pending: 0n });
            expect(unitsOf(usdt.outcome.result, PYTH_PRO_PROGRAM_ADDRESS)).toHaveLength(2);
            expect(fresh.env.balance(PYTH[cluster].treasury)).toBe(usdtTreasury + 2n);
            const usdtMin = minOut(DOLLAR, PYTH_USDT_QUOTE, USD_DECIMALS, PYTH_SPYX_QUOTE, 8);
            expect(usdt.event.minOut).toBe(usdtMin);
            expect(usdtMin).toBeLessThan(minOut(DOLLAR, DOLLAR_QUOTE, USD_DECIMALS, PYTH_SPYX_QUOTE, 8));
            expect(usdt.event.received).toBeGreaterThanOrEqual(usdtMin);
            expect(fresh.env.tokenAmount(await paymentAccount(swapAuthority, 'USDT'))).toBe(0n);
        });
    }

    it('refuses what the program would refuse, before building', async () => {
        const swept = await sweepEnv();
        const { crank, env, user } = swept;
        expect(await refusal(build(swept, 0, { asset: PYTH_SPYX_QQQX, payment: PYTH_USDT }))).toBe(
            LATERITE_ERROR__INVALID_PRICE_UPDATE,
        );
        expect(await refusal(build(swept, 1, { asset: PYTH_SPYX_QQQX }))).toBe(LATERITE_ERROR__INVALID_PRICE_UPDATE);
        env.setNow(PYTH_UPDATES_AT + 61n);
        expect(await refusal(build(swept, 0))).toBe(LATERITE_ERROR__STALE_PRICE);
        env.setNow(PYTH_UPDATES_AT);
        const state = await fetchSweepState(env.rpc, { config: env.config!, paymentToken: 0, user: user.address });
        const { instructions } = await build(swept, 0);
        const route = { ...instructions[1], programAddress: PYTH_PRO_PROGRAM_ADDRESS };
        expect(
            await refusal(
                getSweepInstructions({
                    assetUpdate: PYTH_SPYX_QQQX,
                    crank,
                    pythTreasury: PYTH.devnet.treasury,
                    route,
                    state,
                }),
            ),
        ).toBe(LATERITE_ERROR__INVALID_ROUTER);

        // A frozen account cannot be pulled until the user restores it.
        const usdc = await fetchSweepState(env.rpc, { config: env.config!, paymentToken: 0, user: user.address });
        const frozen = env.data(usdc.paymentAccount);
        frozen[108] = 2;
        env.write(usdc.paymentAccount, frozen, TOKEN_PROGRAM_ADDRESS);
        const refused = await fetchSweepState(env.rpc, { config: env.config!, paymentToken: 0, user: user.address });
        expect(() => getSweepPull(refused)).toThrow(RestoreRequiredError);
        expect(() => getSweepPull(refused)).toThrow('frozen');
        frozen[108] = 1;
        env.write(usdc.paymentAccount, frozen, TOKEN_PROGRAM_ADDRESS);

        await sweep(swept, 0);
        const after = await fetchSweepState(env.rpc, { config: env.config!, paymentToken: 0, user: user.address });
        expect(await refusal(() => getSweepPull(after))).toBe(LATERITE_ERROR__ALREADY_SWEPT);

        await env.expectSuccess(env.send(crank, [await getSetUserPausedInstructionAsync({ paused: true, user })]));
        const paused = await fetchSweepState(env.rpc, { config: env.config!, paymentToken: 1, user: user.address });
        expect(await refusal(() => getSweepPull(paused))).toBe(LATERITE_ERROR__NOTHING_TO_SWEEP);
    });

    it("keeps the pull unchanged until the next boundary, on the program's vectors", () => {
        const amount = vectors<{
            calendars: { nyse: string };
            pulls: {
                balance: string;
                betaCap: string;
                calendar: 'empty' | 'nyse';
                name: string;
                now: string;
                paymentToken: number;
                subscription: string | null;
                userConfig: string;
            }[];
        }>('amount');
        const hex = getBase16Encoder();
        const nyse = getMarketCalendarDecoder().decode(hex.encode(amount.calendars.nyse));
        const empty = { earlyCloses: new Uint8Array(183), firstDay: 0, holidays: new Uint8Array(183), validThrough: 0 };
        let checked = 0;
        for (const vector of amount.pulls) {
            const userConfig = getUserConfigDecoder().decode(hex.encode(vector.userConfig));
            const marketCalendar = vector.calendar === 'nyse' ? nyse : empty;
            const subscription = vector.subscription
                ? getSubscriptionDelegationDecoder().decode(hex.encode(vector.subscription))
                : null;
            const now = BigInt(vector.now);
            const at = (time: bigint) =>
                cappedPull(
                    pull(
                        userConfig,
                        vector.paymentToken,
                        BigInt(vector.balance),
                        BigInt(vector.betaCap),
                        marketCalendar,
                        time,
                    ),
                    nativeRemaining(subscription, time),
                );
            const state = { config: { marketCalendar }, now, subscription, userConfig } as unknown as SweepState;
            const boundary = secondsToNextSweepBoundary(state);
            expect(boundary).toBeGreaterThan(0n);
            expect(at(now + boundary - 1n), vector.name).toEqual(at(now));
            checked += 1;
        }
        expect(checked).toBe(amount.pulls.length);
    });

    it('does not build within the margin of a boundary that changes the pull', async () => {
        const swept = await sweepEnv();
        const midnight = (PYTH_UPDATES_AT / DAY_SECONDS + 1n) * DAY_SECONDS;
        swept.env.setNow(midnight - 10n);
        const state = await fetchSweepState(swept.env.rpc, {
            config: swept.env.config!,
            paymentToken: 0,
            user: swept.user.address,
        });
        expect(secondsToNextSweepBoundary(state)).toBe(10n);
        await expect(build(swept, 0)).rejects.toThrow('boundary');

        // The user's week, which is also the subscription's native period here: both began at enrollment.
        const nextWeek = state.userConfig.enrolledAt + WEEK_SECONDS;
        swept.env.setNow(nextWeek - 5n);
        const weekEnd = await fetchSweepState(swept.env.rpc, {
            config: swept.env.config!,
            paymentToken: 0,
            user: swept.user.address,
        });
        expect(secondsToNextSweepBoundary(weekEnd)).toBe(5n);
        // After a tier change the native period ends 7 s before the week does, so it is the nearer boundary.
        const shifted = { ...weekEnd.subscription!, currentPeriodStartTs: nextWeek - 7n - 3_600n * 168n };
        expect(secondsToNextSweepBoundary({ ...weekEnd, subscription: shifted })).toBe(5n);
        expect(secondsToNextSweepBoundary({ ...weekEnd, now: nextWeek - 15n, subscription: shifted })).toBe(8n);
    });

    it('sweeps a weekly user only inside an NYSE session', async () => {
        const swept = await sweepEnv({ ...defaultParams(), engine: Engine.Weekly });
        trust(swept.env, (await pythTestSigner()).address);
        // Tuesday 2026-09-22 at 10:00 in New York, then Thanksgiving, 2026-11-26, at the same time.
        for (const [now, open] of [
            [1_790_085_600n, true],
            [1_795_705_200n, false],
        ] as const) {
            swept.env.setNow(now);
            const asset = await pythUpdate(now, [
                [1843, PYTH_SPYX_QUOTE],
                [1837, PYTH_SPYX_QUOTE],
            ]);
            if (!open) {
                expect(await refusal(build(swept, 0, { asset }))).toBe(LATERITE_ERROR__NOTHING_TO_SWEEP);
                continue;
            }
            const { instructions } = await build(swept, 0, { asset });
            const outcome = await swept.env.expectSuccess(swept.env.send(swept.crank, instructions, { version: 1 }));
            expect(findSweptEvent(innerInstructions(outcome))!.engine).toBe(DOLLAR);
        }
    });
});

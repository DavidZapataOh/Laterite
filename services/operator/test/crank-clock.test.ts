import { Writable } from 'node:stream';

import { DAY_SECONDS, Engine, fetchUserConfig, findUserConfigPda } from '@laterite/client';
import { type Database, sweepAttempts } from '@laterite/db';
import { createTestDatabase } from '@laterite/db/testing';
import { addresses as devnet } from '@laterite/devnet/addresses';
import { type Address, generateKeyPairSigner, type KeyPairSigner } from '@solana/kit';
import {
    findAssociatedTokenPda,
    getCreateAssociatedTokenIdempotentInstructionAsync,
    getTransferCheckedInstruction,
} from '@solana-program/token';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Alarms } from '../src/alarms/alarms';
import { Crank, MAX_SWEEP_COMPUTE_UNIT_LIMIT } from '../src/crank/crank';
import { cpmmRoutes, NoRouteError } from '../src/crank/routes';
import { createLogger } from '../src/log';
import { params } from './chain/chain';
import { TestPrices } from './chain/prices';
import { SvmChain } from './chain/svm';
import { keys } from './chain/validator';

const DOLLAR = 1_000_000n;
const NO_WAIT = { alert: 0, nothing: 0, price: 0, slippage: 0, unknown: 0 };
const at = (iso: string) => BigInt(Date.parse(iso) / 1_000);
const day = (iso: string) => Number(at(iso) / DAY_SECONDS);

/**
 * The crank's schedule against the program on LiteSVM, whose clock the test sets, with the NYSE 2026–2028 calendar
 * loaded on 2026-11-02: weekly-engine users only inside a regular session (daylight time, Thanksgiving, the 13:00
 * early closes, weekends, an expired calendar), daily-engine users at any hour, the 15 s margin before a boundary that
 * changes the pull, and a day that ended with only failed attempts closed as skipped.
 */
describe('the crank on a clock', () => {
    let chain: SvmChain;
    let db: Database;
    let drop: () => Promise<void>;
    let crank: Crank;
    const prices = new TestPrices();
    const refuseOnce = new Set<Address>();
    /** The compute ceiling the crank handed the sender at each send, and units the next simulations add. */
    const ceilings: number[] = [];
    let extraUnits = 0;
    const messages: string[] = [];
    const log = createLogger(
        'info',
        new Writable({
            write(chunk, _, done) {
                messages.push(JSON.parse(chunk.toString()).message);
                done();
            },
        }),
    );

    const swept = async (user: KeyPairSigner) =>
        (
            await db
                .select({ day: sweepAttempts.day, outcome: sweepAttempts.outcome, reason: sweepAttempts.reason })
                .from(sweepAttempts)
                .where(eq(sweepAttempts.user, user.address))
                .orderBy(asc(sweepAttempts.id))
        ).map(({ day, outcome, reason }) => `${day} ${outcome}${reason ? ` ${reason}` : ''}`);
    const tickAt = async (iso: string) => {
        chain.setNow(at(iso));
        await crank.tick();
    };
    /** A new wallet paid $100 of USDC by the counterparty, enrolled at the chain's clock. */
    async function enrolled(engine: Engine) {
        const user = await generateKeyPairSigner();
        const counterparty = await keys.counterparty();
        const { decimals, mint, tokenProgram } = devnet.tokens.USDC;
        const [[source], [destination]] = await Promise.all([
            findAssociatedTokenPda({ mint, owner: counterparty.address, tokenProgram }),
            findAssociatedTokenPda({ mint, owner: user.address, tokenProgram }),
        ]);
        await chain.send(counterparty, [
            await getCreateAssociatedTokenIdempotentInstructionAsync({
                mint,
                owner: user.address,
                payer: counterparty,
                tokenProgram,
            }),
            getTransferCheckedInstruction({
                amount: 100n * DOLLAR,
                authority: counterparty,
                decimals,
                destination,
                mint,
                source,
            }),
        ]);
        await chain.onboard(user, params(0b01, { engine }));
        return user;
    }

    beforeAll(async () => {
        [chain, { db, drop }] = await Promise.all([SvmChain.start(at('2026-11-02T13:00:00Z')), createTestDatabase()]);
        const crankKey = await keys.crank();
        const cpmm = cpmmRoutes(chain.rpc, devnet);
        const svmSender = chain.sender(crankKey, () => extraUnits);
        crank = new Crank({
            alarms: new Alarms(db, async () => {}, log, '[laterite devnet]'),
            crank: crankKey,
            db,
            log,
            prices,
            retryAfterMs: NO_WAIT,
            // A route refused once for a user whose asset account is in `refuseOnce`.
            routes: async request => {
                if (refuseOnce.delete(request.userAssetAccount)) throw new NoRouteError('refused once');
                return cpmm(request);
            },
            rpc: chain.rpc,
            sender: {
                sendVersion1: (instructions, options) => {
                    ceilings.push(options.maxComputeUnitLimit);
                    return svmSender.sendVersion1(instructions, options);
                },
            },
        });
    });
    afterAll(async () => {
        await drop?.();
    });

    it('sweeps a weekly-engine user from 9:30 New York time, the day after daylight time ended', async () => {
        const weekly = await enrolled(Engine.Weekly);
        await tickAt('2026-11-02T14:29:59Z');
        expect(await swept(weekly)).toEqual([]);
        await tickAt('2026-11-02T14:30:00Z');
        expect(await swept(weekly)).toEqual([`${day('2026-11-02T00:00:00Z')} landed`]);
    });

    it('sweeps weekly users on no holiday, early-close afternoon or weekend, and daily users every day', async () => {
        chain.setNow(at('2026-11-25T22:00:00Z'));
        const [weekly, daily] = [await enrolled(Engine.Weekly), await enrolled(Engine.Daily)];
        // Wednesday after the close, Thanksgiving, the next day after its 13:00 early close, Saturday.
        for (const iso of [
            '2026-11-25T22:00:00Z',
            '2026-11-26T16:00:00Z',
            '2026-11-27T18:00:00Z',
            '2026-11-28T16:00:00Z',
        ]) {
            await tickAt(iso);
        }
        expect(await swept(weekly)).toEqual([]);
        expect(await swept(daily)).toEqual(
            ['2026-11-25', '2026-11-26', '2026-11-27', '2026-11-28'].map(date => `${day(`${date}T00:00:00Z`)} landed`),
        );
        await tickAt('2026-11-30T14:30:00Z');
        expect(await swept(weekly)).toEqual([`${day('2026-11-30T00:00:00Z')} landed`]);
    });

    it('sweeps a weekly user before a 13:00 early close', async () => {
        chain.setNow(at('2026-12-23T22:00:00Z'));
        const weekly = await enrolled(Engine.Weekly);
        await tickAt('2026-12-24T17:59:00Z');
        expect(await swept(weekly)).toEqual([`${day('2026-12-24T00:00:00Z')} landed`]);
    });

    it('waits out the 15 s before UTC midnight and sweeps right after it', async () => {
        chain.setNow(at('2026-12-26T12:00:00Z'));
        const daily = await enrolled(Engine.Daily);
        await tickAt('2026-12-26T23:59:46Z');
        expect(await swept(daily)).toEqual([]);
        expect(messages).toContain('sweep waits for a pull-changing boundary');
        await tickAt('2026-12-26T23:59:59Z');
        expect(await swept(daily)).toEqual([]);
        await tickAt('2026-12-27T00:00:00Z');
        expect(await swept(daily)).toEqual([`${day('2026-12-27T00:00:00Z')} landed`]);
        const [address] = await findUserConfigPda({ user: daily.address });
        expect((await fetchUserConfig(chain.rpc, address)).data.lastSweepDay[0]).toBe(day('2026-12-27T00:00:00Z'));
    });

    it('closes a day whose price never passed as skipped, and not one that failed and then landed', async () => {
        chain.setNow(at('2026-12-28T12:00:00Z'));
        const daily = await enrolled(Engine.Daily);
        prices.assetQuote = { ...prices.assetQuote, confidence: (prices.assetQuote.price * 60n) / 10_000n };
        await tickAt('2026-12-28T12:00:00Z');
        await tickAt('2026-12-28T18:00:00Z');
        prices.reset();
        chain.setNow(at('2026-12-29T11:00:00Z'));
        const retried = await enrolled(Engine.Daily);
        const [account] = await findAssociatedTokenPda({
            mint: devnet.tokens.SPYx.mint,
            owner: retried.address,
            tokenProgram: devnet.tokens.SPYx.tokenProgram,
        });
        refuseOnce.add(account);
        await tickAt('2026-12-29T12:00:00Z');
        await tickAt('2026-12-29T13:00:00Z');
        await tickAt('2026-12-30T12:00:00Z');
        const [monday, tuesday, wednesday] = [28, 29, 30].map(date => day(`2026-12-${date}T00:00:00Z`));
        expect(await swept(daily)).toEqual([
            `${monday} failed PriceUncertain`,
            `${monday} failed PriceUncertain`,
            `${monday} skipped PriceUncertain`,
            `${tuesday} landed`,
            `${wednesday} landed`,
        ]);
        expect(await swept(retried)).toEqual([
            `${tuesday} failed No route: refused once`,
            `${tuesday} landed`,
            `${wednesday} landed`,
        ]);
    });

    it('hands the sender its 490,000-unit ceiling, and a sweep simulated above it sends nothing', async () => {
        chain.setNow(at('2026-12-31T12:00:00Z'));
        const daily = await enrolled(Engine.Daily);
        // A route 500,000 units long: its limit, the simulation's units plus 10%, passes the ceiling.
        extraUnits = 500_000;
        await tickAt('2026-12-31T12:00:00Z');
        extraUnits = 0;
        const thursday = day('2026-12-31T00:00:00Z');
        expect(await swept(daily)).toEqual([
            `${thursday} failed ComputeLimit`,
            `${thursday} failed No route: SPYx-USDC failed today`,
        ]);
        const [refused] = await db.select().from(sweepAttempts).where(eq(sweepAttempts.user, daily.address));
        expect(refused).toMatchObject({ signature: null });
        expect(refused!.computeUnitLimit).toBeGreaterThan(MAX_SWEEP_COMPUTE_UNIT_LIMIT);
        const [address] = await findUserConfigPda({ user: daily.address });
        expect((await fetchUserConfig(chain.rpc, address)).data.lastSweepDay[0]).toBe(0);
        expect(new Set(ceilings)).toEqual(new Set([490_000]));
        expect(MAX_SWEEP_COMPUTE_UNIT_LIMIT).toBe(490_000);
    });

    it('sweeps no weekly user once the calendar has run out, and says why', async () => {
        chain.setNow(at('2028-12-26T12:00:00Z'));
        const [weekly, daily] = [await enrolled(Engine.Weekly), await enrolled(Engine.Daily)];
        // Tuesday 2029-01-02 at 10:00 New York time would be a regular session.
        await tickAt('2029-01-02T15:00:00Z');
        expect(await swept(weekly)).toEqual([]);
        expect(await swept(daily)).toEqual([`${day('2029-01-02T00:00:00Z')} landed`]);
        expect(messages).toContain('the market calendar does not cover today: no weekly-engine sweeps');
    });
});

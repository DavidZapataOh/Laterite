import { randomBytes } from 'node:crypto';

import { ATTESTATION_TTL_SECONDS, type AttestationArgs, EventKind, findAttestationRecordPda } from '@laterite/client';
import { attestations, type Database, indexerState, sweeps, userEvents } from '@laterite/db';
import { createTestDatabase } from '@laterite/db/testing';
import type { Address, KeyPairSigner, Signature } from '@solana/kit';
import { fetchSysvarClock } from '@solana/sysvars';
import { addresses as devnet } from '@laterite/devnet/addresses';
import { asc } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { balanceAlarms, calendarAlarm } from '../src/alarms/checks';
import { Indexer } from '../src/indexer/indexer';
import { createLogger } from '../src/log';
import { createFailoverRpc } from '../src/rpc';
import { Chain, params } from './chain/chain';
import { keys } from './chain/validator';

const DOLLAR = 1_000_000n;

describe('the indexer on a local chain', () => {
    let chain: Chain;
    let db: Database;
    let drop: () => Promise<void>;
    let indexer: Indexer;
    let user: KeyPairSigner;
    let later: KeyPairSigner;
    let veteran: KeyPairSigner;
    const sent: Record<string, Signature> = {};
    let failed: Signature;
    let expiredRecord: Address;

    const now = async () => (await fetchSysvarClock(chain.rpc)).unixTimestamp;
    const attestation = (to: Address, eventTime: bigint): AttestationArgs => ({
        amount: 100n * DOLLAR,
        eventTime,
        kind: EventKind.Income,
        paymentToken: 0,
        signature: randomBytes(64),
        transferIndex: 0,
        user: to,
    });

    beforeAll(async () => {
        [chain, { db, drop }] = await Promise.all([Chain.start(), createTestDatabase()]);
        [[user, later], veteran] = await Promise.all([keys.users(), keys.veteran()]);

        // The veteran's transfer is attested 15 s before its window ends, so its record can close during the test.
        const expiry = (await now()) + 15n;
        const old = attestation(veteran.address, expiry - ATTESTATION_TTL_SECONDS);
        sent.expiring = await chain.attest(old);
        [expiredRecord] = await findAttestationRecordPda(old);

        sent.enrolled = await chain.onboard(user!, params(0b01));
        sent.swept = await chain.sweep(user!);
        // SPYx's issuer schedules a new multiplier; a sweep after it takes effect records the new one.
        const effective = (await now()) + 3n;
        await chain.scheduleMultiplier(2, effective);
        while ((await now()) <= effective) await new Promise(resolve => setTimeout(resolve, 500));
        sent.laterEnrolled = await chain.onboard(later!, params(0b01));
        sent.laterSwept = await chain.sweep(later!);
        sent.settings = await chain.updateSettings(user!, params(0b01, { incomeRule: true }));
        sent.attested = await chain.attest(attestation(user!.address, await now()));
        failed = await chain.attestThenFail(attestation(user!.address, await now()));
        sent.paused = await chain.setPaused(user!, true);
        sent.resumed = await chain.setPaused(user!, false);
        sent.lowered = await chain.lowerPending(user!, 4n * DOLLAR);
        sent.tier = await chain.changeTier(user!, 1);
        sent.tokens = await chain.changePaymentTokens(user!, 0b11);
        sent.exited = await chain.exit(user!);
        sent.reactivated = await chain.reactivate(user!, params(0b01));

        while ((await now()) <= expiry) await new Promise(resolve => setTimeout(resolve, 1_000));
        sent.closed = await chain.closeAttestation(expiredRecord, (await keys.crank()).address);
        await chain.finalized(sent.closed);

        indexer = new Indexer(
            db,
            createFailoverRpc([chain.validator.rpcUrl]),
            chain.config.assets.map(asset => asset.mint),
            createLogger('silent'),
        );
        await indexer.poll();
    });
    afterAll(async () => {
        await drop?.();
        await chain?.stop();
    });

    it("stores each sweep from its self-CPI event, with the asset's multiplier in force at its block time", async () => {
        const rows = await db.select().from(sweeps).orderBy(asc(sweeps.slot));
        expect(rows.map(row => [row.signature, row.user, row.multiplier])).toEqual([
            [sent.swept, user.address, 1.005714560286254],
            [sent.laterSwept, later.address, 2],
        ]);
        const [row] = rows;
        expect(row).toMatchObject({
            asset: 0,
            engine: DOLLAR,
            feePayer: (await keys.crank()).address,
            paymentToken: 0,
            pending: 0n,
        });
        expect(row!.received).toBeGreaterThanOrEqual(row!.minOut);
        expect(row!.headroomBps).toBe(Number(((row!.received - row!.minOut) * 10_000n) / row!.minOut));
    });

    it('stores every user control in order, from the events Laterite logged', async () => {
        const rows = await db.select().from(userEvents).orderBy(asc(userEvents.slot));
        expect(rows.map(row => [row.kind, row.signature])).toEqual([
            ['enrolled', sent.enrolled],
            ['enrolled', sent.laterEnrolled],
            ['settings_updated', sent.settings],
            ['paused', sent.paused],
            ['resumed', sent.resumed],
            ['pending_lowered', sent.lowered],
            ['tier_changed', sent.tier],
            ['payment_tokens_changed', sent.tokens],
            ['exited', sent.exited],
            ['reactivated', sent.reactivated],
        ]);
        expect(rows.filter(row => row.user === user.address)).toHaveLength(9);
        expect(rows.map(row => row.data)).toEqual([
            { asset: 0, paymentTokens: 1, tier: 0 },
            { asset: 0, paymentTokens: 1, tier: 0 },
            { params: expect.objectContaining({ engineAmount: '1000000', incomeRule: true, paymentTokens: 1 }) },
            {},
            {},
            { pending: '4000000' },
            { tier: 1 },
            { paymentTokens: 3 },
            {},
            { asset: 0, paymentTokens: 1, tier: 0 },
        ]);
    });

    it('stores each attestation with its record and payer, and a record closed after its window', async () => {
        const crank = (await keys.crank()).address;
        const rows = await db.select().from(attestations).orderBy(asc(attestations.slot));
        expect(rows.map(row => [row.signature, row.user, row.closedSignature])).toEqual([
            [sent.expiring, veteran.address, sent.closed],
            [sent.attested, user.address, null],
        ]);
        expect(rows[0]).toMatchObject({
            invested: 10n * DOLLAR,
            payer: crank,
            pendingAfter: 10n * DOLLAR,
            record: expiredRecord,
        });
        expect(rows[1]).toMatchObject({ amount: 100n * DOLLAR, invested: 10n * DOLLAR, kind: 'income', payer: crank });
        expect(rows.some(row => row.signature === failed)).toBe(false);
    });

    it('resumes after the last transaction it stored and stores nothing twice', async () => {
        const count = async () =>
            (await Promise.all([sweeps, attestations, userEvents].map(table => db.$count(table)))).join(',');
        const before = await count();
        await indexer.poll();
        expect(await count()).toBe(before);
        // Storing every transaction again from the start changes nothing.
        await db.delete(indexerState);
        await indexer.poll();
        expect(await count()).toBe(before);
        const paused = await chain.setPaused(user, true);
        // Confirmed is not enough: only a finalized transaction is stored.
        await indexer.poll();
        expect((await db.select().from(userEvents)).some(row => row.signature === paused)).toBe(false);
        await chain.finalized(paused);
        await indexer.poll();
        const [cursor] = await db.select().from(indexerState);
        expect(cursor!.signature).toBe(paused);
        expect(
            (await db.select().from(userEvents)).filter(row => row.signature === paused).map(row => row.kind),
        ).toEqual(['paused']);
    });

    it("reads the wallets' balances and the market calendar from the chain", async () => {
        const config = await chain.refreshConfig();
        const crank = (await keys.crank()).address;
        const states = await balanceAlarms(
            chain.rpc,
            config,
            { crank, treasury: devnet.treasury },
            devnet.tokens,
            'devnet',
        );
        expect(states).toMatchObject({ 'balance-crank': null, 'balance-sponsor': null });
        expect(states['balance-treasury']).toBe(
            `the treasury ${devnet.treasury} holds 0 SOL, below 0.5 SOL: run \`just devnet-assets devnet\``,
        );
        expect(states['inventory-USDC']).toBe(
            'the treasury holds 0 raw USDC, below 20000000000: run `just devnet-assets devnet`, which mints its inventory back',
        );
        expect(calendarAlarm(config.marketCalendar, await now(), 'devnet')).toBeNull();
    });
});

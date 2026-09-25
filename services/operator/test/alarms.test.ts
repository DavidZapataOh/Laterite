import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { alarms as alarmRows, type Database, swapAccountCreations, sweeps } from '@laterite/db';
import { createTestDatabase } from '@laterite/db/testing';
import type { Address } from '@solana/kit';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { Alarms, REPEAT_MS, telegramNotifier } from '../src/alarms/alarms';
import { headroomAlarm, swapAccountAlarm } from '../src/alarms/checks';
import { createLogger } from '../src/log';

const log = createLogger('silent');
let db: Database;
let drop: () => Promise<void>;

beforeAll(async () => {
    ({ db, drop } = await createTestDatabase());
});
afterAll(() => drop());

describe('alarms', () => {
    const sent: string[] = [];
    let failing = false;
    const alarms = () =>
        new Alarms(
            db,
            async text => {
                if (failing) throw new Error('Telegram down');
                sent.push(text);
            },
            log,
            '[laterite devnet]',
        );
    beforeEach(async () => {
        sent.length = 0;
        failing = false;
        await db.delete(alarmRows);
    });

    it('notifies when an alarm starts, again every six hours while it fires, and once when it resolves', async () => {
        const start = new Date('2026-09-24T12:00:00Z');
        const later = (ms: number) => new Date(start.getTime() + ms);
        await alarms().set({ 'balance-crank': 'low', indexer: null }, start);
        await alarms().set({ 'balance-crank': 'lower' }, later(60_000));
        await alarms().set({ 'balance-crank': 'lowest' }, later(REPEAT_MS));
        expect(await alarms().firing()).toEqual([{ key: 'balance-crank', message: 'lowest', since: start }]);
        await alarms().set({ 'balance-crank': null }, later(REPEAT_MS + 1));
        await alarms().set({ 'balance-crank': null }, later(REPEAT_MS + 2));
        expect(sent).toEqual([
            '[laterite devnet] FIRING balance-crank: low',
            '[laterite devnet] STILL FIRING balance-crank: lowest',
            '[laterite devnet] RESOLVED balance-crank: lowest',
        ]);
        expect(await alarms().firing()).toEqual([]);
    });

    it('delivers a notification Telegram missed on the next run, across restarts', async () => {
        failing = true;
        await alarms().set({ 'market-calendar': 'expired' });
        failing = false;
        await alarms().set({ 'market-calendar': 'expired' });
        await alarms().set({ 'market-calendar': 'expired' });
        expect(sent).toEqual(['[laterite devnet] FIRING market-calendar: expired']);
    });

    it("sends each notification to the operations chat through Telegram's sendMessage", async () => {
        const requests: unknown[] = [];
        const server = createServer((request, response) => {
            let body = '';
            request.on('data', chunk => (body += chunk));
            request.on('end', () => {
                requests.push({ body: JSON.parse(body), path: request.url, type: request.headers['content-type'] });
                const ok = request.url === '/bot1:token/sendMessage';
                response.writeHead(ok ? 200 : 401).end(JSON.stringify({ ok }));
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        await telegramNotifier('1:token', '-100', { api })('[laterite devnet] FIRING indexer: stalled');
        const refused = await telegramNotifier('1:revoked', '-100', { api })('x').catch((error: Error) => error);
        server.close();
        expect(requests[0]).toEqual({
            body: {
                chat_id: '-100',
                link_preview_options: { is_disabled: true },
                text: '[laterite devnet] FIRING indexer: stalled',
            },
            path: '/bot1:token/sendMessage',
            type: 'application/json',
        });
        expect(refused).toBeInstanceOf(Error);
        expect(String(refused)).not.toContain('revoked');
    });
});

describe('alarms on the indexed history', () => {
    const crank = 'Crank11111111111111111111111111111111111111' as Address;
    const sweep = (slot: bigint, feePayer: Address, received: bigint) => ({
        asset: 0,
        assetExponent: -8,
        assetPrice: 77_847_155_496n,
        blockTime: new Date(),
        engine: 1_000_000n,
        eventIndex: 0,
        feePayer,
        minOut: 1_000_000n,
        multiplier: 1,
        paymentToken: 0,
        pending: 0n,
        received,
        signature: `sweep-${slot}`,
        slot,
        user: 'user',
    });

    it("fires when the crank's latest sweep landed less than the cluster's threshold above min_out", async () => {
        expect(await headroomAlarm(db, crank, 'mainnet')).toEqual({ 'sweep-headroom': null });
        await db.insert(sweeps).values([sweep(1n, crank, 1_001_900n), sweep(2n, 'Other' as Address, 1_000_000n)]);
        expect((await headroomAlarm(db, crank, 'mainnet'))['sweep-headroom']).toBe(
            "the crank's latest sweep sweep-1 landed 19 bps above min_out, below 20 on mainnet: SLIPPAGE_BPS is getting tight for its routes",
        );
        // Devnet's stand-in pools charge 25 bps and move within a 10 bps band, so 19 is expected there.
        expect(await headroomAlarm(db, crank, 'devnet')).toEqual({ 'sweep-headroom': null });
        await db.insert(sweeps).values(sweep(3n, crank, 1_000_400n));
        expect((await headroomAlarm(db, crank, 'devnet'))['sweep-headroom']).toBe(
            "the crank's latest sweep sweep-3 landed 4 bps above min_out, below 5 on devnet: SLIPPAGE_BPS is getting tight for its routes",
        );
        await db.insert(sweeps).values(sweep(4n, crank, 1_002_000n));
        expect(await headroomAlarm(db, crank, 'mainnet')).toEqual({ 'sweep-headroom': null });
    });

    it('fires when the crank reached the bound of five swap-authority accounts in a day', async () => {
        const now = new Date('2026-09-24T12:00:00Z');
        const created = (index: number, hoursAgo: number) => ({
            address: `account-${index}`,
            createdAt: new Date(now.getTime() - hoursAgo * 3_600_000),
            mint: `mint-${index}`,
            signature: `creation-${index}`,
            tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        });
        await db.insert(swapAccountCreations).values([0, 1, 2, 3].map(i => created(i, i)).concat(created(5, 25)));
        expect(await swapAccountAlarm(db, now)).toEqual({ 'swap-account-creations': null });
        await db.insert(swapAccountCreations).values(created(6, 23));
        expect((await swapAccountAlarm(db, now))['swap-account-creations']).toBe(
            'the crank created 5 swap-authority accounts in 24 hours, the bound: routes needing another wait; review them',
        );
    });
});

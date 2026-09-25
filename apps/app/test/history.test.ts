import { attestations, sweeps, userEvents } from '@laterite/db';
import { createTestDatabase } from '@laterite/db/testing';
import { generateKeyPairSigner } from '@solana/kit';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let history: typeof import('@/app/api/history/route');
let csv: typeof import('@/app/api/history/csv/route');
let wallet: string;
let other: string;

const sweep = (user: string, signature: string, at: string, engine: bigint, pending: bigint, multiplier = 1) => ({
    asset: 0,
    assetExponent: -8,
    assetPrice: 77_000_000_000n,
    blockTime: new Date(at),
    engine,
    eventIndex: 0,
    feePayer: 'crank',
    minOut: 1_000_000n,
    multiplier,
    paymentToken: 0,
    pending,
    received: 1_300_000n,
    signature,
    slot: 1n,
    user,
});

beforeAll(async () => {
    db = await createTestDatabase();
    process.env.DATABASE_URL = db.url;
    history = await import('@/app/api/history/route');
    csv = await import('@/app/api/history/csv/route');
    [wallet, other] = (await Promise.all([generateKeyPairSigner(), generateKeyPairSigner()])).map(s => s.address);
    await db.db
        .insert(sweeps)
        .values([
            sweep(wallet, 'first', '2026-09-20T15:00:00Z', 1_000_000n, 0n),
            sweep(wallet, 'second', '2026-09-21T15:00:00Z', 0n, 5_000_000n, 1.0006),
            sweep(other, 'others', '2026-09-21T16:00:00Z', 9_000_000n, 0n),
        ]);
    await db.db.insert(attestations).values({
        amount: 1_000_000_000n,
        blockTime: new Date('2026-09-20T14:00:00Z'),
        eventIndex: 0,
        eventTime: new Date('2026-09-20T13:59:00Z'),
        expiresAt: new Date('2026-09-27T14:00:00Z'),
        invested: 100_000_000n,
        kind: 'income',
        payer: 'crank',
        paymentToken: 0,
        pendingAfter: 100_000_000n,
        record: 'record',
        signature: 'attested',
        slot: 1n,
        sourceSignature: 'transfer',
        transferIndex: 0,
        user: wallet,
    });
    await db.db.insert(userEvents).values({
        blockTime: new Date('2026-09-22T10:00:00Z'),
        data: {},
        eventIndex: 0,
        kind: 'paused',
        signature: 'pause',
        slot: 2n,
        user: wallet,
    });
});

afterAll(async () => {
    await (await import('@/lib/db')).database().$client.end();
    await db.drop();
});

const get = (route: typeof history | typeof csv, path: string, address: string) =>
    route.GET(new NextRequest(`https://app.laterite.cash/api/history${path}?wallet=${address}`));

describe('the history', () => {
    it("reads only the wallet's rows, newest first, and the invested total from the sweeps' pulls", async () => {
        const body = await (await get(history, '', wallet)).json();
        expect(body.purchases.map((p: { signature: string }) => p.signature)).toEqual(['second', 'first']);
        expect(body.invested).toBe(6);
        expect(body.purchases[0]).toMatchObject({ asset: 'SPYx', paid: 5, token: 'USDC' });
        expect(body.purchases[0].assetAmount).toBeCloseTo(0.013 * 1.0006, 9);
        expect(body.incomes).toMatchObject([
            { amount: 1000, invested: 100, kind: 'income', sourceSignature: 'transfer' },
        ]);
        expect(body.controls).toMatchObject([{ kind: 'paused', signature: 'pause' }]);
    });

    it('is empty for a wallet with nothing yet, and refuses a malformed wallet', async () => {
        const empty = (await generateKeyPairSigner()).address;
        expect(await (await get(history, '', empty)).json()).toEqual({
            controls: [],
            incomes: [],
            invested: 0,
            purchases: [],
        });
        expect((await get(history, '', 'x')).status).toBe(400);
    });

    it('downloads the purchases as CSV with the execution price and the multiplier, never a Pyth price', async () => {
        const response = await get(csv, '/csv', wallet);
        expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
        expect(response.headers.get('content-disposition')).toContain('attachment');
        const lines = (await response.text()).trimEnd().split('\r\n');
        expect(lines[0]).toBe('date,token,amount,price,asset,multiplier,link');
        expect(lines).toHaveLength(3);
        expect(lines[1]).toBe(
            [
                '2026-09-21T15:00:00.000Z',
                'USDC',
                '5.00',
                (5 / (0.013 * 1.0006)).toFixed(4),
                `${(0.013 * 1.0006).toFixed(8)} SPYx`,
                '1.0006',
                'https://explorer.solana.com/tx/second?cluster=devnet',
            ].join(','),
        );
        expect((await (await get(csv, '/csv', (await generateKeyPairSigner()).address)).text()).trimEnd()).toBe(
            'date,token,amount,price,asset,multiplier,link',
        );
    });
});

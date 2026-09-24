import { readFileSync } from 'node:fs';

import type { MarketCalendar } from '@laterite/client';
import { fetchLatestKaminoUpdates, fetchPythProUpdate, PYTH_USDT_FEED_ID } from '@laterite/client/node';
import { createSolanaRpcFromTransport, type RpcTransport } from '@solana/kit';
import { describe, expect, it } from 'vitest';

import { calendarAlarm, indexerAlarm, kaminoAlarms, pythTokenAlarm, THRESHOLDS } from '../src/alarms/checks';

const recorded = <T>(name: string): T => JSON.parse(readFileSync(new URL(`recorded/${name}`, import.meta.url), 'utf8'));

/** 2026-09-24, the day the responses were recorded, in days since 1970-01-01. */
const TODAY = 20_720n;
const noon = TODAY * 86_400n + 43_200n;
const calendar = (firstDay: number, validThrough: number): MarketCalendar => ({
    earlyCloses: new Uint8Array(183),
    firstDay,
    holidays: new Uint8Array(183),
    validThrough,
});

describe('the market-calendar alarm', () => {
    it('fires when validThrough is less than 90 days away', () => {
        expect(calendarAlarm(calendar(20_700, 20_720 + 89), noon, 'devnet')).toBe(
            'the market calendar ends in 89 days (2026-12-22): update programs/laterite/data/nyse-calendar.json and run `just market-calendar devnet`',
        );
        expect(calendarAlarm(calendar(20_700, 20_720 + 90), noon, 'devnet')).toBeNull();
        expect(calendarAlarm(calendar(20_700, 20_720 + 91), noon, 'devnet')).toBeNull();
    });

    it('fires at once when the calendar does not cover today: never loaded, expired or loaded for later', () => {
        for (const uncovered of [calendar(0, 0), calendar(20_000, 20_719), calendar(20_721, 21_549)]) {
            expect(calendarAlarm(uncovered, noon, 'devnet')).toBe(
                'the market calendar does not cover today, so weekly-engine users buy nothing: update programs/laterite/data/nyse-calendar.json and run `just market-calendar devnet`',
            );
        }
    });
});

describe('the Kamino Scope relay alarms, on recorded mainnet responses', () => {
    const exchanges = recorded<{ method: string; params: unknown; result: unknown }[]>('kamino-rpc.json');
    const key = (method: string, params: unknown) =>
        JSON.stringify([method, params], (_, value) => (typeof value === 'bigint' ? Number(value) : value));
    const replay = (async ({ payload }: Parameters<RpcTransport>[0]) => {
        const { id, method, params } = payload as { id: number; method: string; params: unknown };
        const exchange = exchanges.find(e => key(e.method, e.params) === key(method, params));
        if (!exchange) throw new Error(`No recorded response to ${method}`);
        return { id, jsonrpc: '2.0', result: exchange.result };
    }) as RpcTransport;
    const rpc = createSolanaRpcFromTransport(replay);
    const feeds = [
        { feedId: 1843, name: 'SPYX' },
        { feedId: 1837, name: 'QQQX' },
    ];

    it('stays quiet while the latest post carrying each asset feed is fresh and fits a sweep', async () => {
        const latest = await fetchLatestKaminoUpdates(rpc, [1843, 1837]);
        const postedAt = latest.get(1843)!.blockTime!;
        expect(latest.get(1843)!.message).toHaveLength(548);
        for (const age of [30n, 100n, THRESHOLDS.priceAgeSeconds]) {
            expect(kaminoAlarms(latest, feeds, postedAt + age)).toEqual({
                'price-QQQX': null,
                'price-SPYX': null,
                'price-update-size': null,
            });
        }
        expect(kaminoAlarms(latest, feeds, postedAt + 30n, 548)['price-update-size']).toBeNull();
    });

    it('fires when no post carrying a feed has been seen for 120 s', async () => {
        const latest = await fetchLatestKaminoUpdates(rpc, [1843, 1837]);
        const states = kaminoAlarms(latest, feeds, latest.get(1843)!.blockTime! + THRESHOLDS.priceAgeSeconds + 1n);
        expect(states['price-SPYX']).toBe(
            'Kamino Scope has posted no SPYX (feed 1843) for more than 120 s: sweeps fail with StalePrice',
        );
        expect(states['price-QQQX']).toContain('StalePrice');
    });

    it('fires when the update no longer carries a configured feed, or outgrows the sweep', async () => {
        const latest = await fetchLatestKaminoUpdates(rpc, [1843, 9_999]);
        const now = latest.get(1843)!.blockTime! + 30n;
        expect(kaminoAlarms(latest, [...feeds.slice(0, 1), { feedId: 9_999, name: 'NEXT' }], now)['price-NEXT']).toBe(
            'no recent Kamino Scope post carries NEXT (feed 9999): sweeps into it fail with PriceUnavailable',
        );
        expect(kaminoAlarms(latest, feeds.slice(0, 1), now, 547)['price-update-size']).toBe(
            "Kamino Scope's update is 548 bytes, above the 547 a sweep has room for: sweeps would not fit in a transaction",
        );
    });
});

describe("the Pyth Pro token alarm, on Pyth Pro's recorded answers", () => {
    const answers = recorded<Record<string, { body: string; contentType: string }>>('pyth-pro.json');
    const answering = (status: number) => () =>
        fetchPythProUpdate({
            accessToken: 'token',
            fetch: (async () => {
                const { body, contentType } = answers[status] ?? {
                    body: 'Too Many Requests',
                    contentType: 'text/plain',
                };
                return new Response(body, { headers: { 'Content-Type': contentType }, status });
            }) as unknown as typeof fetch,
            priceFeedIds: [PYTH_USDT_FEED_ID],
        });

    it('stays quiet while the token fetches the USDT/USD update', async () => {
        expect(await pythTokenAlarm(answering(200))).toEqual({ 'pyth-pro-token': null });
    });

    it('fires on 401, 403 and 429: USDT sweeps fail closed until the token works', async () => {
        for (const status of [401, 403, 429]) {
            expect(await pythTokenAlarm(answering(status))).toEqual({
                'pyth-pro-token': `Pyth Pro answers ${status} to the USDT/USD request: USDT sweeps stop until the access token works again`,
            });
        }
        await expect(pythTokenAlarm(answering(500))).rejects.toThrow('500');
    });
});

describe('the indexer alarm', () => {
    it('fires when no poll has finished for five minutes, counting from the start', () => {
        const start = 1_000_000;
        expect(indexerAlarm(null, start, start + THRESHOLDS.indexerStallMs).indexer).toBeNull();
        expect(indexerAlarm(null, start, start + THRESHOLDS.indexerStallMs + 1).indexer).toBe(
            'the indexer has stored nothing for 5 minutes: check the RPC and the database',
        );
        expect(indexerAlarm(start + 60_000, start, start + 5 * 60_000).indexer).toBeNull();
    });
});

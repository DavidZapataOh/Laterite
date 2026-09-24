import { mkdirSync, writeFileSync } from 'node:fs';

import {
    CALENDAR_DAYS,
    DOLLAR_QUOTE,
    findSwapAuthorityPda,
    type MarketCalendar,
    minOut,
    type Quote,
    quote,
    SLIPPAGE_BPS,
    TIERS,
    usMarketOpen,
} from '@laterite/client';
import {
    buildJupiterSwap,
    fetchLatestKaminoUpdate,
    fetchPythProUpdate,
    PYTH_USDT_FEED_ID,
} from '@laterite/client/node';
import { MARKET_CALENDAR_FILE, readMarketCalendar } from '@laterite/deployment';
import { DECIMALS, MAINNET_MINTS, PYTH_FEEDS } from '@laterite/devnet';

import { mainnetRpc } from '../src/fork';
import { jupiter } from '../src/jupiter';

/**
 * Samples the fill of tier-sized sweeps on real Jupiter routes against the program's price bound, for as many
 * minutes as asked: each round reads the latest Kamino-relayed SPYX/USD and QQQX/USD updates and a token-fetched
 * USDT/USD update, quotes $10 and $25 of USDC and USDT into SPYx and QQQx as the crank would (unrestricted routes,
 * `maxAccounts` 40), and records how far each quote falls below the oracle's worth at the conservative side of both
 * confidence intervals: the slippage `SLIPPAGE_BPS` must leave room for. Writes `reports/slippage-<start>.json`.
 */
const minutes = Number(process.argv[2] ?? 10);
const accessToken = process.env.PYTH_PRO_ACCESS_TOKEN;
if (!accessToken) throw new Error('PYTH_PRO_ACCESS_TOKEN is required for the USDT/USD update');

const days = await readMarketCalendar(MARKET_CALENDAR_FILE);
const today = Math.floor(Date.now() / 86_400_000);
const bits = (closures: number[]) => {
    const bitmap = new Uint8Array(CALENDAR_DAYS / 8);
    for (const day of closures.filter(day => day >= today)) bitmap[(day - today) >> 3]! |= 1 << ((day - today) & 7);
    return bitmap;
};
const calendar: MarketCalendar = {
    earlyCloses: bits(days.earlyCloses),
    firstDay: today,
    holidays: bits(days.holidays),
    validThrough: days.validThrough,
};
const session = (now: bigint) => {
    if (usMarketOpen(now, calendar)) return 'regular';
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(
        new Date(Number(now) * 1_000),
    );
    return weekday === 'Sat' || weekday === 'Sun' ? 'weekend' : 'closed';
};

/** The asset's raw worth of `amount` at the given prices, before any slippage: `min_out` without `SLIPPAGE_BPS`. */
const worth = (amount: bigint, payment: Quote, asset: Quote, decimals: number) =>
    (minOut(amount, payment, 6, asset, decimals) * 10_000n) / (10_000n - SLIPPAGE_BPS);
const mid = (price: Quote): Quote => ({ ...price, confidence: 0n });
const bps = (expected: bigint, got: bigint) => Number(((expected - got) * 10_000n) / expected);

const [swapAuthority] = await findSwapAuthorityPda();
const rows: Record<string, unknown>[] = [];
const start = new Date();
const end = start.getTime() + minutes * 60_000;
while (Date.now() < end) {
    const now = BigInt(Math.floor(Date.now() / 1_000));
    const [spyx, qqqx, usdt] = await Promise.all([
        fetchLatestKaminoUpdate(mainnetRpc, PYTH_FEEDS.SPYx.proId),
        fetchLatestKaminoUpdate(mainnetRpc, PYTH_FEEDS.QQQx.proId),
        fetchPythProUpdate({ accessToken, priceFeedIds: [PYTH_USDT_FEED_ID] }),
    ]);
    const payments = { USDC: DOLLAR_QUOTE, USDT: quote(usdt, PYTH_USDT_FEED_ID, now) };
    const assets = {
        QQQx: quote(qqqx.message, PYTH_FEEDS.QQQx.proId, now),
        SPYx: quote(spyx.message, PYTH_FEEDS.SPYx.proId, now),
    };
    for (const payment of ['USDC', 'USDT'] as const) {
        for (const asset of ['SPYx', 'QQQx'] as const) {
            for (const amount of TIERS) {
                const route = await buildJupiterSwap({
                    ...jupiter,
                    amount,
                    inputMint: MAINNET_MINTS[payment],
                    maxAccounts: 40,
                    outputMint: MAINNET_MINTS[asset],
                    taker: swapAuthority,
                }).catch(() => null);
                if (!route) continue;
                const conservative = worth(amount, payments[payment], assets[asset], DECIMALS[asset]);
                const fair = worth(amount, mid(payments[payment]), mid(assets[asset]), DECIMALS[asset]);
                const venues = (route.response as unknown as { routePlan: { swapInfo: { label: string } }[] })
                    .routePlan;
                rows.push({
                    at: new Date(Number(now) * 1_000).toISOString(),
                    session: session(now),
                    payment,
                    asset,
                    amount: Number(amount / 1_000_000n),
                    outAmount: route.outAmount,
                    belowMidBps: bps(fair, route.outAmount),
                    belowBoundBps: bps(conservative, route.outAmount),
                    venues: [...new Set(venues.map(({ swapInfo }) => swapInfo.label))].join(' '),
                });
            }
        }
    }
    console.log(
        `${rows.length} quotes, worst ${Math.max(...rows.map(row => row.belowBoundBps as number))} bps below the bound`,
    );
}

const directory = new URL('../reports/', import.meta.url);
mkdirSync(directory, { recursive: true });
const file = new URL(`slippage-${start.toISOString().replace(/[:.]/g, '-')}.json`, directory);
writeFileSync(
    file,
    `${JSON.stringify(rows, (_, value) => (typeof value === 'bigint' ? value.toString() : value), 4)}\n`,
);
const groups = new Map<string, Record<string, unknown>[]>();
for (const row of rows) {
    const key = `${row.session} ${row.payment}→${row.asset} $${row.amount}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
}
console.table(
    [...groups].map(([sample, group]) => {
        const below = group.map(row => row.belowBoundBps as number).sort((a, b) => a - b);
        return {
            sample,
            quotes: below.length,
            medianBelowBound: below[below.length >> 1],
            worstBelowBound: below.at(-1),
            worstBelowMid: Math.max(...group.map(row => row.belowMidBps as number)),
        };
    }),
);
console.log(`✓ ${rows.length} quotes written to ${file.pathname}`);

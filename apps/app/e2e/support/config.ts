import { readFileSync } from 'node:fs';

import { CALENDAR_DAYS, type Config, type MarketCalendar } from '@laterite/client';
import { addresses } from '@laterite/devnet/addresses';
import { address, type Address } from '@solana/kit';

const day = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;

/** The NYSE calendar as `set_market_calendar` stores it when loaded on `firstDay`, from the committed dates. */
export function nyseCalendar(firstDay: number): MarketCalendar {
    const file = new URL('../../../../programs/laterite/data/nyse-calendar.json', import.meta.url);
    const dates = JSON.parse(readFileSync(file, 'utf8')) as {
        earlyCloses: string[];
        holidays: string[];
        validThrough: string;
    };
    const bits = (days: string[]) => {
        const bitmap = new Uint8Array(CALENDAR_DAYS / 8);
        for (const closure of days.map(day)) {
            const index = closure - firstDay;
            if (index >= 0) bitmap[index >> 3]! |= 1 << (index & 7);
        }
        return bitmap;
    };
    return {
        earlyCloses: bits(dates.earlyCloses),
        firstDay,
        holidays: bits(dates.holidays),
        validThrough: day(dates.validThrough),
    };
}

const system = address('11111111111111111111111111111111');

/**
 * The devnet deployment's `Config` as the tests hold it: the devnet mints, a $25 beta cap per user, 1,000 seats and
 * the NYSE calendar loaded on 2026-09-01.
 */
export function testConfig(changes: Partial<Config> = {}): Config {
    const token = (symbol: keyof typeof addresses.tokens, usdFeedId = 0) => ({
        decimals: addresses.tokens[symbol].decimals,
        mint: addresses.tokens[symbol].mint,
        tokenProgram: addresses.tokens[symbol].tokenProgram,
        usdFeedId,
    });
    const asset = (symbol: 'QQQx' | 'SPYx') => ({
        decimals: addresses.tokens[symbol].decimals,
        mint: addresses.tokens[symbol].mint,
        pythFeedId: addresses.tokens[symbol].pyth!.proId,
        tokenProgram: addresses.tokens[symbol].tokenProgram,
    });
    return {
        admin: system as Address,
        assets: [asset('SPYx'), asset('QQQx')],
        attestor: system,
        discriminator: new Uint8Array(8),
        genesisHash: new Uint8Array(32),
        marketCalendar: nyseCalendar(day('2026-09-01')),
        maxUsers: 1_000,
        paused: false,
        paymentTokens: [token('USDC'), token('USDT', 8)],
        pendingAdmin: system,
        router: system,
        sponsor: system,
        userCount: 3,
        userWeeklyCap: 25_000_000n,
        ...changes,
    };
}

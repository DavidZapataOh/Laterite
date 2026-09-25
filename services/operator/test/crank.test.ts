import { type Config, Engine, type MarketCalendar, type UserConfig, UserStatus } from '@laterite/client';
import { MARKET_CALENDAR_FILE, readMarketCalendar } from '@laterite/deployment';
import type { Address } from '@solana/kit';
import { describe, expect, it } from 'vitest';

import { calendarCovers, sweepCandidates } from '../src/crank/crank';
import { rateLimitedFetch } from '../src/crank/routes';

const DOLLAR = 1_000_000n;
const DAY = 86_400n;

/** Unix seconds of a UTC instant. */
const at = (iso: string) => BigInt(Date.parse(iso) / 1_000);

/** The NYSE 2026–2028 calendar as `set_market_calendar` stores it when loaded on 2026-01-01. */
async function nyseCalendar(): Promise<MarketCalendar> {
    const { earlyCloses, holidays, validThrough } = await readMarketCalendar(MARKET_CALENDAR_FILE);
    const firstDay = Number(at('2026-01-01T00:00:00Z') / DAY);
    const bitmap = (days: number[]) => {
        const bits = new Uint8Array(183);
        for (const day of days) if (day >= firstDay) bits[(day - firstDay) >> 3]! |= 1 << ((day - firstDay) & 7);
        return bits;
    };
    return { earlyCloses: bitmap(earlyCloses), firstDay, holidays: bitmap(holidays), validThrough };
}

/** A user enrolled on 2026-11-02 with $1 a day or a week from USDC, nothing pending, active. */
function user(overrides: Partial<UserConfig> = {}): UserConfig {
    const enrolledAt = at('2026-11-02T12:00:00Z');
    return {
        asset: 0,
        attestableFrom: enrolledAt,
        bump: 255,
        changeMultiplier: 0,
        cushions: [20n * DOLLAR, 20n * DOLLAR],
        discriminator: new Uint8Array(8),
        engine: Engine.Daily,
        engineAmount: DOLLAR,
        engineRanAt: 0n,
        enrolledAt,
        goalAmount: 0n,
        goalLabel: new Uint8Array(32),
        incomeRule: false,
        lastSweepDay: [0, 0],
        paymentTokens: 0b01,
        pending: 0n,
        status: UserStatus.Active,
        tier: 0,
        user: 'User111111111111111111111111111111111111111' as Address,
        week: 0,
        weekSpent: 0n,
        ...overrides,
    };
}

describe("the crank's candidates, on the NYSE 2026–2028 calendar", () => {
    const config = async (calendar?: MarketCalendar) =>
        ({ marketCalendar: calendar ?? (await nyseCalendar()), userWeeklyCap: 25n * DOLLAR }) as Config;
    const weekly = user({ engine: Engine.Weekly });
    const daily = user();
    const due = async (users: UserConfig[], iso: string, calendar?: MarketCalendar) =>
        sweepCandidates(users, await config(calendar), at(iso)).map(({ paymentToken, user }) => [
            user.engine === Engine.Weekly ? 'weekly' : 'daily',
            paymentToken,
        ]);

    it('sweeps a weekly-engine user only inside a regular session, a daily-engine user at any hour', async () => {
        // Tuesday 2026-11-03, the first week after daylight time ended: New York is UTC-5.
        expect(await due([weekly, daily], '2026-11-03T14:29:00Z')).toEqual([['daily', 0]]);
        expect(await due([weekly, daily], '2026-11-03T14:30:00Z')).toEqual([
            ['weekly', 0],
            ['daily', 0],
        ]);
        expect(await due([weekly, daily], '2026-11-03T20:59:59Z')).toHaveLength(2);
        expect(await due([weekly, daily], '2026-11-03T21:00:00Z')).toEqual([['daily', 0]]);
        // Thanksgiving, a weekend, and the next day's 13:00 early close.
        expect(await due([weekly, daily], '2026-11-26T16:00:00Z')).toEqual([['daily', 0]]);
        expect(await due([weekly, daily], '2026-11-28T16:00:00Z')).toEqual([['daily', 0]]);
        expect(await due([weekly, daily], '2026-11-27T17:59:59Z')).toHaveLength(2);
        expect(await due([weekly, daily], '2026-11-27T18:00:00Z')).toEqual([['daily', 0]]);
        // The Monday after daylight time starts (2027-03-15): New York is UTC-4.
        const march = user({ engine: Engine.Weekly, enrolledAt: at('2027-03-10T12:00:00Z') });
        expect(await due([march], '2027-03-15T13:29:00Z')).toEqual([]);
        expect(await due([march], '2027-03-15T13:30:00Z')).toEqual([['weekly', 0]]);
    });

    it('sweeps no weekly-engine user, pending included, while the calendar does not cover today', async () => {
        const pending = user({ engine: Engine.Weekly, pending: 3n * DOLLAR });
        const nyse = await nyseCalendar();
        const expired = { ...nyse, validThrough: Number(at('2026-11-01T00:00:00Z') / DAY) };
        const empty = { earlyCloses: new Uint8Array(183), firstDay: 0, holidays: new Uint8Array(183), validThrough: 0 };
        for (const calendar of [expired, empty]) {
            expect(await due([weekly, pending, daily], '2026-11-03T15:00:00Z', calendar)).toEqual([['daily', 0]]);
            expect(calendarCovers(await config(calendar), at('2026-11-03T15:00:00Z'))).toBe(false);
        }
        expect(await due([pending], '2026-11-03T15:00:00Z')).toEqual([['weekly', 0]]);
    });

    it('reads no token swept today, of a paused or exited user, or with nothing due or no room left', async () => {
        const monday = '2026-11-09T15:00:00Z';
        const today = Number(at(monday) / DAY);
        const swept = user({ lastSweepDay: [today, 0], paymentTokens: 0b11, pending: DOLLAR });
        expect(await due([swept], monday)).toEqual([['daily', 1]]);
        expect(await due([user({ status: UserStatus.Paused }), user({ status: UserStatus.Exited })], monday)).toEqual(
            [],
        );
        // The engine ran today and nothing is pending; or the week's $10 is spent.
        expect(await due([user({ engineRanAt: at(monday) - 60n })], monday)).toEqual([]);
        const spent = user({ pending: 5n * DOLLAR, week: 1, weekSpent: 10n * DOLLAR });
        expect(await due([spent], monday)).toEqual([]);
        expect(await due([user({ engineRanAt: at(monday) - 60n, pending: 1n })], monday)).toEqual([['daily', 0]]);
    });
});

describe("Jupiter's rate limit", () => {
    it('keeps requests apart and waits out a 429 with a doubled spacing', async () => {
        const times: number[] = [];
        let answers = [429, 200, 200, 200];
        const fetch = rateLimitedFetch(100, (async () => {
            times.push(Date.now());
            return new Response(null, { status: answers.shift() ?? 200 });
        }) as typeof globalThis.fetch);
        const statuses = [];
        for (let i = 0; i < 3; i++) statuses.push((await fetch('https://api.jup.ag/swap/v2/build')).status);
        expect(statuses).toEqual([200, 200, 200]);
        expect(fetch.requests()).toBe(4);
        const gaps = times.slice(1).map((time, index) => time - times[index]!);
        // The retry after the 429 waits one spacing; the next request two (the doubled spacing), then one.
        expect(gaps[0]).toBeGreaterThanOrEqual(95);
        expect(gaps[1]).toBeGreaterThanOrEqual(195);
        expect(gaps[2]).toBeGreaterThanOrEqual(95);
        answers = [];
    });
});

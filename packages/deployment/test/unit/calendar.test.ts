import type { MarketCalendar } from '@laterite/client';
import { describe, expect, it } from 'vitest';

import { isMarketCalendarLoaded, MARKET_CALENDAR_FILE, marketCalendarArgs, readMarketCalendar } from '../../src';

const DAY_2026_09_21 = 20_717;
const THANKSGIVING_2026 = 20_783;

function stored(
    firstDay: number,
    validThrough: number,
    holidays: number[],
    earlyCloses: number[] = [],
): MarketCalendar {
    const bits = (days: number[]) => {
        const out = new Uint8Array(183);
        for (const day of days) out[(day - firstDay) >> 3]! |= 1 << ((day - firstDay) & 7);
        return out;
    };
    return { earlyCloses: bits(earlyCloses), firstDay, holidays: bits(holidays), validThrough };
}

describe('market calendar', () => {
    it('reads the committed NYSE calendar as days since 1970-01-01', async () => {
        const calendar = await readMarketCalendar(MARKET_CALENDAR_FILE);
        expect(calendar.holidays).toHaveLength(29);
        expect(calendar.earlyCloses).toHaveLength(5);
        expect(calendar.holidays[0]).toBe(20_454);
        expect(calendar.holidays).toContain(THANKSGIVING_2026);
        expect(calendar.validThrough).toBe(21_549);
    });

    it('sends only the closures from the loading day on', async () => {
        const calendar = await readMarketCalendar(MARKET_CALENDAR_FILE);
        const args = marketCalendarArgs(calendar, DAY_2026_09_21);
        expect(args.holidays.every(day => day >= DAY_2026_09_21)).toBe(true);
        expect(args.holidays).toHaveLength(21);
        expect(args.earlyCloses).toEqual(calendar.earlyCloses);
        expect(args.validThrough).toBe(calendar.validThrough);
    });

    it('matches a stored calendar only when it holds the same closures through the same day', async () => {
        const calendar = await readMarketCalendar(MARKET_CALENDAR_FILE);
        const { earlyCloses, holidays, validThrough } = marketCalendarArgs(calendar, DAY_2026_09_21);
        expect(isMarketCalendarLoaded(stored(0, 0, []), calendar)).toBe(false);
        expect(isMarketCalendarLoaded(stored(DAY_2026_09_21, validThrough, holidays, earlyCloses), calendar)).toBe(
            true,
        );
        expect(
            isMarketCalendarLoaded(stored(DAY_2026_09_21, validThrough, holidays.slice(1), earlyCloses), calendar),
        ).toBe(false);
        expect(isMarketCalendarLoaded(stored(DAY_2026_09_21, validThrough, holidays, []), calendar)).toBe(false);
        expect(isMarketCalendarLoaded(stored(DAY_2026_09_21, validThrough - 1, holidays, earlyCloses), calendar)).toBe(
            false,
        );
    });
});

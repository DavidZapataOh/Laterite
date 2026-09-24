import { readFile } from 'node:fs/promises';

import type { MarketCalendar } from '@laterite/client';

/** The NYSE calendar the program tests and every deployment load: the one committed source of the dates. */
export const MARKET_CALENDAR_FILE = new URL('../../../programs/laterite/data/nyse-calendar.json', import.meta.url);

/** Market closures in days since 1970-01-01, as `set_market_calendar` takes them. */
export type MarketCalendarDays = { earlyCloses: number[]; holidays: number[]; validThrough: number };

const day = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;

/** Reads a calendar file of ISO dates (`holidays`, `earlyCloses`, `validThrough`). */
export async function readMarketCalendar(file: URL): Promise<MarketCalendarDays> {
    const calendar = JSON.parse(await readFile(file, 'utf8')) as {
        earlyCloses: string[];
        holidays: string[];
        validThrough: string;
    };
    return {
        earlyCloses: calendar.earlyCloses.map(day),
        holidays: calendar.holidays.map(day),
        validThrough: day(calendar.validThrough),
    };
}

/** The closures a load on `today` keeps: the program stores the calendar from the loading day on. */
export function marketCalendarArgs(calendar: MarketCalendarDays, today: number): MarketCalendarDays {
    const kept = (days: number[]) => days.filter(closure => closure >= today);
    return {
        earlyCloses: kept(calendar.earlyCloses),
        holidays: kept(calendar.holidays),
        validThrough: calendar.validThrough,
    };
}

/** Whether `stored` holds exactly `calendar`'s closures from the day it was loaded through the same last day. */
export function isMarketCalendarLoaded(stored: MarketCalendar, calendar: MarketCalendarDays): boolean {
    if (stored.validThrough !== calendar.validThrough) return false;
    const bits = (days: number[]) => {
        const bitmap = new Uint8Array(stored.holidays.length);
        for (const closure of days) {
            const index = closure - stored.firstDay;
            if (index >= 0 && closure <= stored.validThrough) bitmap[index >> 3]! |= 1 << (index & 7);
        }
        return bitmap;
    };
    const same = (a: Uint8Array, b: ArrayLike<number>) => a.every((byte, index) => byte === b[index]);
    return same(bits(calendar.holidays), stored.holidays) && same(bits(calendar.earlyCloses), stored.earlyCloses);
}

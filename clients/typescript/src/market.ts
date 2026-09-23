import type { ReadonlyUint8Array } from '@solana/kit';

import { DAY_SECONDS } from './constants';
import type { MarketCalendar } from './generated';

const HOUR = 3_600n;
const OPEN = 9n * HOUR + 30n * 60n;
const CLOSE = 16n * HOUR;
const EARLY_CLOSE = 13n * HOUR;

/** A regular NYSE session in Unix seconds: trading from `open` until just before `close`. */
export type MarketSession = { close: bigint; open: bigint };

/** Floor division, as Rust's `div_euclid` for a positive divisor. */
export function divEuclid(value: bigint, divisor: bigint): bigint {
    const quotient = value / divisor;
    return value % divisor < 0n ? quotient - 1n : quotient;
}

const isSet = (bits: ReadonlyUint8Array, index: number) => ((bits[index >> 3] ?? 0) & (1 << (index & 7))) !== 0;

/** Day of the week of a day count since 1970-01-01, a Thursday; 0 is Sunday. */
const weekday = (day: bigint) => Number((((day + 4n) % 7n) + 7n) % 7n);

/** Month and day of a day count since 1970-01-01, from Howard Hinnant's `civil_from_days`. */
function monthDay(days: bigint): [number, number] {
    const z = days + 719_468n;
    const doe = ((z % 146_097n) + 146_097n) % 146_097n;
    const yoe = (doe - doe / 1_460n + doe / 36_524n - doe / 146_096n) / 365n;
    const doy = doe - (365n * yoe + yoe / 4n - yoe / 100n);
    const mp = (5n * doy + 2n) / 153n;
    const day = Number(doy - (153n * mp + 2n) / 5n + 1n);
    return [Number(mp < 10n ? mp + 3n : mp - 9n), day];
}

/** US daylight saving time runs from the second Sunday in March to the first Sunday in November. */
function daylightTime(days: bigint, dayOfWeek: number): boolean {
    const [month, day] = monthDay(days);
    const firstWeekday = (((dayOfWeek - (day - 1)) % 7) + 7) % 7;
    const firstSunday = 1 + ((7 - firstWeekday) % 7);
    if (month >= 4 && month <= 10) return true;
    if (month === 3) return day >= firstSunday + 7;
    if (month === 11) return day < firstSunday;
    return false;
}

/**
 * The regular session of a UTC day (days since 1970-01-01), or `null` when the market does not open that day:
 * weekends, the calendar's holidays and every day outside `firstDay..=validThrough`. Early closes end at 13:00
 * New York time.
 */
export function marketSession(day: bigint, calendar: MarketCalendar): MarketSession | null {
    if (day < BigInt(calendar.firstDay) || day > BigInt(calendar.validThrough)) return null;
    const index = Number(day - BigInt(calendar.firstDay));
    const dayOfWeek = weekday(day);
    if (dayOfWeek === 0 || dayOfWeek === 6 || isSet(calendar.holidays, index)) return null;
    // New York is UTC-4 in daylight time and UTC-5 otherwise, so the session lies within one UTC day.
    const offset = daylightTime(day, dayOfWeek) ? 4n * HOUR : 5n * HOUR;
    const start = day * DAY_SECONDS + offset;
    return { close: start + (isSet(calendar.earlyCloses, index) ? EARLY_CLOSE : CLOSE), open: start + OPEN };
}

/** Whether `now` falls in a regular NYSE session, as the program's `us_market_open` decides it. */
export function usMarketOpen(now: bigint, calendar: MarketCalendar): boolean {
    const session = marketSession(divEuclid(now, DAY_SECONDS), calendar);
    return session !== null && now >= session.open && now < session.close;
}

/** The session in progress at `now` or the next one the calendar covers; `null` when the calendar has none left. */
export function nextMarketSession(now: bigint, calendar: MarketCalendar): MarketSession | null {
    for (let day = divEuclid(now, DAY_SECONDS); day <= BigInt(calendar.validThrough); day++) {
        const session = marketSession(day, calendar);
        if (session && now < session.close) return session;
    }
    return null;
}

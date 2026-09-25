import {
    DAY_SECONDS,
    divEuclid,
    Engine,
    engineDue,
    type MarketCalendar,
    nextMarketSession,
    spentAt,
    type UserConfig,
    UserStatus,
    WEEK_SECONDS,
    weekAt,
    weeklyCap,
} from '@laterite/client';

/** This week of the user's: what was pulled, the combined cap, and when the week resets (enrollment + k × 7 days). */
export function weekView(user: UserConfig, betaCap: bigint, now: bigint) {
    return {
        cap: weeklyCap(user, betaCap, now),
        resetsAt: user.enrolledAt + BigInt(weekAt(user, now) + 1) * WEEK_SECONDS,
        spent: spentAt(user, now),
    };
}

/**
 * When the next purchase can happen, by the program's own rules: nothing while paused; with no schedule and nothing
 * waiting, the next income; a daily schedule any hour, once per UTC day; a weekly schedule, and whatever waits for a
 * weekly user, only in a regular NYSE session of `calendar`, which holds weekly buys when it does not cover the time.
 */
export type NextBuy =
    { kind: 'paused' } | { kind: 'income' } | { kind: 'soon' } | { at: bigint; kind: 'at' } | { kind: 'hold' };

export function nextBuy(user: UserConfig, calendar: MarketCalendar, now: bigint): NextBuy {
    if (user.status === UserStatus.Paused) return { kind: 'paused' };
    const scheduled = user.engineAmount > 0n;
    const waiting = user.pending > 0n;
    if (!scheduled && !waiting) return { kind: 'income' };
    if (user.engine === Engine.Daily) {
        return waiting || engineDue(user, calendar, now)
            ? { kind: 'soon' }
            : { at: (divEuclid(now, DAY_SECONDS) + 1n) * DAY_SECONDS, kind: 'at' };
    }
    const ranThisWeek = user.engineRanAt >= user.enrolledAt && weekAt(user, user.engineRanAt) === weekAt(user, now);
    const due = waiting || !ranThisWeek;
    const today = divEuclid(now, DAY_SECONDS);
    if (today < BigInt(calendar.firstDay) || today > BigInt(calendar.validThrough)) return { kind: 'hold' };
    const from = due ? now : user.enrolledAt + BigInt(weekAt(user, now) + 1) * WEEK_SECONDS;
    const session = nextMarketSession(from, calendar);
    if (!session) return { kind: 'hold' };
    return session.open <= now ? { kind: 'soon' } : { at: session.open, kind: 'at' };
}

/** A token amount in UI units: raw units over the decimals, times the mint's ScaledUiAmount multiplier. */
export function uiAmount(raw: bigint, decimals: number, multiplier: number): number {
    return (Number(raw) / 10 ** decimals) * multiplier;
}

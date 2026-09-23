import type { SubscriptionDelegation } from '@solana/subscriptions';

import {
    CHANGE_MIN,
    CHANGE_STEP,
    DAY_SECONDS,
    INCOME_MIN,
    INCOME_SHARE_BPS,
    TIERS,
    TRIAL_CAP,
    TRIAL_SECONDS,
    WEEK_SECONDS,
} from './constants';
import { Engine, type MarketCalendar, type UserConfig, UserStatus } from './generated';
import { divEuclid, usMarketOpen } from './market';

const U64_MAX = 2n ** 64n - 1n;

/** What one sweep pulls, by source, in payment-token raw units. */
export type Pull = { engine: bigint; pending: bigint };

const min = (a: bigint, b: bigint) => (a < b ? a : b);
const saturatingSub = (a: bigint, b: bigint) => (a > b ? a - b : 0n);

/** The pull's total: exactly what the sweep takes from the user. */
export const pullTotal = (pull: Pull) => pull.engine + pull.pending;

/** The pull within `limit`, the engine kept first. */
export function cappedPull(pull: Pull, limit: bigint): Pull {
    const engine = min(pull.engine, limit);
    return { engine, pending: min(pull.pending, limit - engine) };
}

/** What the income rule adds for an incoming payment. */
export function incomeShare(user: UserConfig, income: bigint): bigint {
    return user.incomeRule && income >= INCOME_MIN ? (income * INCOME_SHARE_BPS) / 10_000n : 0n;
}

/** What change per payment adds for an outgoing payment: max(round-up to the next dollar, $0.50) × multiplier. */
export function change(user: UserConfig, payment: bigint): bigint {
    const roundUp = (CHANGE_STEP - (payment % CHANGE_STEP)) % CHANGE_STEP;
    return (roundUp > CHANGE_MIN ? roundUp : CHANGE_MIN) * BigInt(user.changeMultiplier);
}

/** Index of the user's week at `now`, counted from enrollment. */
export function weekAt(user: UserConfig, now: bigint): number {
    const elapsed = now - user.enrolledAt;
    return Number(BigInt.asUintN(32, (elapsed > 0n ? elapsed : 0n) / WEEK_SECONDS));
}

/** The combined cap across both payment tokens for the week of `now`, never above the beta's cap per user. */
export function weeklyCap(user: UserConfig, betaCap: bigint, now: bigint): bigint {
    const cap = now < user.enrolledAt + TRIAL_SECONDS ? TRIAL_CAP : (TIERS[user.tier as 0 | 1] ?? 0n);
    return min(cap, betaCap);
}

/** Pulled so far in the week of `now`, across both payment tokens. */
export function spentAt(user: UserConfig, now: bigint): bigint {
    return weekAt(user, now) === user.week ? user.weekSpent : 0n;
}

/** The daily engine buys once per UTC day, the weekly engine once per week during a regular NYSE session. */
export function engineDue(user: UserConfig, calendar: MarketCalendar, now: bigint): boolean {
    const ran = user.engineRanAt >= user.enrolledAt;
    if (user.engine === Engine.Daily) {
        return !ran || divEuclid(now, DAY_SECONDS) > divEuclid(user.engineRanAt, DAY_SECONDS);
    }
    return (!ran || weekAt(user, now) > weekAt(user, user.engineRanAt)) && usMarketOpen(now, calendar);
}

/**
 * What a sweep of `paymentToken` may pull at `now` from a `balance` in that token, as the program's `pull` computes
 * it: the engine if due, then pending amounts, within the week's remaining cap and above the token's cushion.
 */
export function pull(
    user: UserConfig,
    paymentToken: number,
    balance: bigint,
    betaCap: bigint,
    calendar: MarketCalendar,
    now: bigint,
): Pull {
    if (user.status !== UserStatus.Active) return { engine: 0n, pending: 0n };
    const cushion = user.cushions[paymentToken] ?? U64_MAX;
    const room = min(saturatingSub(weeklyCap(user, betaCap, now), spentAt(user, now)), saturatingSub(balance, cushion));
    const engine = engineDue(user, calendar, now) ? min(user.engineAmount, room) : 0n;
    return { engine, pending: min(user.pending, room - engine) };
}

/**
 * What a subscription still lets its plan's owner pull in the current period at `now`, as the program's
 * `subscription::remaining` bounds each sweep: 0 once it has expired, or when there is no subscription.
 */
export function nativeRemaining(subscription: SubscriptionDelegation | null, now: bigint): bigint {
    if (!subscription) return 0n;
    const { amount, periodHours } = subscription.terms;
    if (subscription.expiresAtTs !== 0n && now >= subscription.expiresAtTs) return 0n;
    const period = min(periodHours * 3_600n, U64_MAX);
    const elapsed = now - subscription.currentPeriodStartTs;
    if (elapsed >= 0n && elapsed >= period) return amount;
    return saturatingSub(amount, subscription.amountPulledInPeriod);
}

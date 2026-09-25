import type { Address } from '@solana/kit';
import {
    type Config,
    DAY_SECONDS,
    divEuclid,
    Engine,
    type EnrollParamsArgs,
    enabledPaymentTokens,
    incomeShare,
    marketSession,
    pull,
    spentAt,
    TRIAL_SECONDS,
    type UserConfig,
    UserStatus,
    WEEK_SECONDS,
    weekAt,
    weeklyCap,
} from '@laterite/client';

import { DOLLAR } from './onboarding';

/** The payday the preview imagines: $1,000 received in the first chosen payment token. */
export const PAYDAY = 1_000n * DOLLAR;

/** What the payday would invest, and why no more. */
export type Preview = {
    /** Bought in the rest of the current week. */
    invested: bigint;
    /** The week's combined cap: the trial cap in the first week, else the tier, never above the beta's cap. */
    cap: bigint;
    trial: boolean;
    /** What limits `invested`: the cap, the balance above the cushions, or the rules themselves. */
    binding: 'balance' | 'cap' | 'rules';
    /** Still waiting to invest at the end of the week, carried over to later weeks. */
    waits: bigint;
    /** What the following full week buys from the same rules and what waits. */
    nextWeek: bigint;
};

/** The account `enroll` would create at `now`, or the exited account `reactivate` would return, with `params`. */
export function joinedAccount(
    user: Address,
    params: EnrollParamsArgs,
    account: UserConfig | null,
    now: bigint,
): UserConfig {
    const settings = {
        asset: params.asset,
        changeMultiplier: params.changeMultiplier,
        cushions: params.cushions.map(BigInt),
        engine: params.engine as Engine,
        engineAmount: BigInt(params.engineAmount),
        goalAmount: BigInt(params.goalAmount),
        goalLabel: params.goalLabel,
        incomeRule: params.incomeRule,
        paymentTokens: params.paymentTokens,
        tier: params.tier,
    };
    if (account) {
        // a return keeps every counter; exit discarded what was waiting
        return { ...account, ...settings, attestableFrom: now, pending: 0n, status: UserStatus.Active };
    }
    return {
        ...settings,
        attestableFrom: now,
        bump: 0,
        discriminator: new Uint8Array(8),
        engineRanAt: 0n,
        enrolledAt: now,
        lastSweepDay: [0, 0],
        pending: 0n,
        status: UserStatus.Active,
        user,
        week: 0,
        weekSpent: 0n,
    };
}

/**
 * Runs the sweeps of `user` from `from` to `until` as the program pulls them: one per payment token and UTC day, at the
 * first instant of the day a sweep can pull (inside the regular NYSE session for the weekly engine, which the
 * program requires of every weekly-engine sweep), each through the program's own `pull` and recorded as `record`
 * records it. Mutates `user` and `balances`; returns the total pulled.
 */
function sweepThrough(user: UserConfig, balances: bigint[], config: Config, from: bigint, until: bigint): bigint {
    let total = 0n;
    for (let day = divEuclid(from, DAY_SECONDS); day * DAY_SECONDS < until; day++) {
        let at = day * DAY_SECONDS > from ? day * DAY_SECONDS : from;
        if (user.engine === Engine.Weekly) {
            const session = marketSession(day, config.marketCalendar);
            if (!session || at >= session.close) continue;
            if (at < session.open) at = session.open;
        }
        if (at >= until) continue;
        for (const token of enabledPaymentTokens(user.paymentTokens)) {
            const { engine, pending } = pull(
                user,
                token,
                balances[token]!,
                config.userWeeklyCap,
                config.marketCalendar,
                at,
            );
            if (engine + pending === 0n) continue;
            user.weekSpent = spentAt(user, at) + engine + pending;
            user.week = weekAt(user, at);
            if (engine > 0n) user.engineRanAt = at;
            user.pending -= pending;
            balances[token]! -= engine + pending;
            total += engine + pending;
        }
    }
    return total;
}

/**
 * What a $1,000 payday received at `now` would invest this week with `params`, computed with the program's own rules
 * (the client's mirrors of `income_share`, `pull` and the NYSE session): the income rule's share joins what waits to
 * invest, and the week's sweeps take the engine first, then what waits, within the week's cap and above each
 * token's cushion. Change per payment counts payments the user makes, so a payday adds nothing through it.
 */
export function paydayPreview(input: {
    account: UserConfig | null;
    /** The wallet's balance in each payment token, before the payday. */
    balances: bigint[];
    config: Config;
    now: bigint;
    params: EnrollParamsArgs;
    user: Address;
}): Preview {
    const { config, now } = input;
    const user = joinedAccount(input.user, input.params, input.account, now);
    const balances = [...input.balances];
    const [paid] = enabledPaymentTokens(user.paymentTokens);
    if (paid !== undefined) balances[paid]! += PAYDAY;
    user.pending += incomeShare(user, PAYDAY);
    const cap = weeklyCap(user, config.userWeeklyCap, now);
    const room = cap > spentAt(user, now) ? cap - spentAt(user, now) : 0n;
    const weekEnd = user.enrolledAt + BigInt(weekAt(user, now) + 1) * WEEK_SECONDS;
    const invested = sweepThrough(user, balances, config, now, weekEnd);
    const waits = user.pending;
    const nextWeek = sweepThrough(user, balances, config, weekEnd, weekEnd + WEEK_SECONDS);
    const cushioned = enabledPaymentTokens(user.paymentTokens).every(
        token => balances[token]! <= user.cushions[token]!,
    );
    return {
        binding: invested === room ? 'cap' : cushioned && waits > 0n ? 'balance' : 'rules',
        cap,
        invested,
        nextWeek,
        trial: now < user.enrolledAt + TRIAL_SECONDS,
        waits,
    };
}

/** A raw amount as dollars and cents in `locale`'s digits, cents rounded down: `$1,000.00`, `$1.000,00`. */
export function dollars(raw: bigint, locale: string, cents = true): string {
    const whole = Number(raw / DOLLAR) + Number((raw % DOLLAR) / (DOLLAR / 100n)) / 100;
    const digits = cents ? 2 : 0;
    return `$${new Intl.NumberFormat(locale, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(whole)}`;
}

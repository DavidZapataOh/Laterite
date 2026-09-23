import { getBase16Encoder } from '@solana/kit';
import { getSubscriptionDelegationDecoder } from '@solana/subscriptions';
import { describe, expect, it } from 'vitest';

import * as client from '../src';
import {
    cappedPull,
    change,
    DAY_SECONDS,
    getMarketCalendarDecoder,
    getUserConfigDecoder,
    incomeShare,
    marketSession,
    nativeRemaining,
    nextMarketSession,
    pull,
    usMarketOpen,
} from '../src';
import { vectors } from './fixtures';

const hex = getBase16Encoder();

type AmountVectors = {
    calendars: { nyse: string };
    changes: [number, string, string][];
    constants: Record<string, number | string | string[]>;
    incomeShares: [boolean, string, string][];
    pulls: {
        balance: string;
        betaCap: string;
        calendar: 'empty' | 'nyse';
        capped: [string, string];
        name: string;
        now: string;
        paymentToken: number;
        pull: [string, string];
        remaining: string;
        subscription: string | null;
        userConfig: string;
    }[];
};

describe('the amount engine mirrors the program', () => {
    const amount = vectors<AmountVectors>('amount');
    const nyse = getMarketCalendarDecoder().decode(hex.encode(amount.calendars.nyse));
    const empty = { earlyCloses: new Uint8Array(183), firstDay: 0, holidays: new Uint8Array(183), validThrough: 0 };

    it("uses the program's constants", () => {
        const { constants } = amount;
        expect(client.TIERS.map(String)).toEqual(constants.TIERS);
        for (const name of [
            'TRIAL_CAP',
            'TRIAL_SECONDS',
            'DAY_SECONDS',
            'WEEK_SECONDS',
            'PLAN_PERIOD_HOURS',
            'CALENDAR_DAYS',
            'INCOME_SHARE_BPS',
            'INCOME_MIN',
            'CHANGE_STEP',
            'CHANGE_MIN',
            'MAX_PRICE_AGE_SECONDS',
            'MAX_CONFIDENCE_BPS',
            'SLIPPAGE_BPS',
            'USD_DECIMALS',
        ] as const) {
            expect(String(client[name]), name).toBe(String(constants[name]));
        }
    });

    it(`pulls what the program pulls in all ${amount.pulls.length} cases`, () => {
        for (const vector of amount.pulls) {
            const user = getUserConfigDecoder().decode(hex.encode(vector.userConfig));
            const calendar = vector.calendar === 'nyse' ? nyse : empty;
            const now = BigInt(vector.now);
            const subscription = vector.subscription
                ? getSubscriptionDelegationDecoder().decode(hex.encode(vector.subscription))
                : null;
            const computed = pull(
                user,
                vector.paymentToken,
                BigInt(vector.balance),
                BigInt(vector.betaCap),
                calendar,
                now,
            );
            const remaining = nativeRemaining(subscription, now);
            const expected = (pair: [string, string]) => ({ engine: BigInt(pair[0]), pending: BigInt(pair[1]) });
            expect(computed, vector.name).toEqual(expected(vector.pull));
            expect(remaining, vector.name).toBe(BigInt(vector.remaining));
            expect(cappedPull(computed, remaining), vector.name).toEqual(expected(vector.capped));
        }
    });

    it('computes the income share and the change per payment', () => {
        const user = getUserConfigDecoder().decode(hex.encode(amount.pulls[0]!.userConfig));
        for (const [incomeRule, income, share] of amount.incomeShares) {
            expect(incomeShare({ ...user, incomeRule }, BigInt(income))).toBe(BigInt(share));
        }
        for (const [changeMultiplier, payment, invested] of amount.changes) {
            expect(change({ ...user, changeMultiplier }, BigInt(payment))).toBe(BigInt(invested));
        }
    });
});

describe('the NYSE session mirrors the program', () => {
    const market = vectors<{ calendar: string; firstDay: number; lastDay: number; open: string; seconds: number[] }>(
        'market',
    );
    const calendar = getMarketCalendarDecoder().decode(hex.encode(market.calendar));

    it(`opens and closes at the program's ${market.open.length} instants`, () => {
        let index = 0;
        for (let day = market.firstDay; day <= market.lastDay; day++) {
            for (const second of market.seconds) {
                const now = BigInt(day) * DAY_SECONDS + BigInt(second);
                expect(usMarketOpen(now, calendar), `${now}`).toBe(market.open[index++] === '1');
            }
        }
    });

    it('finds the session in progress or the next one', () => {
        for (let day = market.firstDay; day <= market.lastDay; day++) {
            for (const second of market.seconds) {
                const now = BigInt(day) * DAY_SECONDS + BigInt(second);
                const session = nextMarketSession(now, calendar);
                if (usMarketOpen(now, calendar)) {
                    expect(session!.open <= now && now < session!.close).toBe(true);
                } else if (session) {
                    expect(session.open).toBeGreaterThan(now);
                    expect(usMarketOpen(session.open, calendar) && !usMarketOpen(session.close, calendar)).toBe(true);
                    expect(usMarketOpen(session.open - 1n, calendar)).toBe(false);
                } else {
                    for (let later = BigInt(day); later <= BigInt(calendar.validThrough); later++) {
                        const left = marketSession(later, calendar);
                        expect(left === null || left.close <= now).toBe(true);
                    }
                }
            }
        }
    });
});

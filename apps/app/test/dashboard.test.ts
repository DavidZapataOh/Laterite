import { Engine, UserStatus, type UserConfig } from '@laterite/client';
import { describe, expect, it } from 'vitest';

import { nextBuy, uiAmount, weekView } from '../lib/dashboard';
import { config, exited } from './state';

const at = (iso: string) => BigInt(Date.parse(iso) / 1000);
const enrolledAt = at('2026-09-07T12:00:00Z');
const user = (changes: Partial<UserConfig> = {}): UserConfig => ({
    ...exited(enrolledAt, 0, 0n),
    status: UserStatus.Active,
    tier: 1,
    ...changes,
});

describe('the week', () => {
    it('caps the first 7 days at the $5 trial, then at the tier', () => {
        expect(weekView(user(), 25_000_000n, enrolledAt + 3_600n).cap).toBe(5_000_000n);
        expect(weekView(user(), 25_000_000n, at('2026-09-15T00:00:00Z')).cap).toBe(25_000_000n);
    });

    it('counts what was spent this week only, and resets on the enrollment weekday', () => {
        const now = at('2026-09-16T00:00:00Z');
        expect(weekView(user({ week: 1, weekSpent: 9_000_000n }), 25_000_000n, now)).toEqual({
            cap: 25_000_000n,
            resetsAt: at('2026-09-21T12:00:00Z'),
            spent: 9_000_000n,
        });
        expect(weekView(user({ week: 0, weekSpent: 5_000_000n }), 25_000_000n, now).spent).toBe(0n);
    });
});

describe('the next buy', () => {
    const calendar = config.marketCalendar;

    it('reads paused while paused, and waits for income without a schedule or anything to invest', () => {
        expect(nextBuy(user({ status: UserStatus.Paused }), calendar, enrolledAt)).toEqual({ kind: 'paused' });
        expect(nextBuy(user(), calendar, enrolledAt)).toEqual({ kind: 'income' });
    });

    it('is soon for a daily schedule due today, and tomorrow once today ran', () => {
        const now = at('2026-09-16T15:00:00Z');
        const daily = user({ engine: Engine.Daily, engineAmount: 1_000_000n });
        expect(nextBuy(daily, calendar, now)).toEqual({ kind: 'soon' });
        expect(nextBuy({ ...daily, engineRanAt: at('2026-09-16T01:00:00Z') }, calendar, now)).toEqual({
            at: at('2026-09-17T00:00:00Z'),
            kind: 'at',
        });
    });

    it('waits for the next NYSE session for a weekly schedule: Thanksgiving and the early close', () => {
        const weekly = user({
            engine: Engine.Weekly,
            engineAmount: 5_000_000n,
            enrolledAt: at('2026-11-23T00:00:00Z'),
        });
        // Thanksgiving is closed; the next session is Friday's, which closes early at 13:00 New York time.
        expect(nextBuy(weekly, calendar, at('2026-11-26T15:00:00Z'))).toEqual({
            at: at('2026-11-27T14:30:00Z'),
            kind: 'at',
        });
        expect(nextBuy(weekly, calendar, at('2026-11-27T18:30:00Z'))).toEqual({
            at: at('2026-11-30T14:30:00Z'),
            kind: 'at',
        });
        expect(nextBuy(weekly, calendar, at('2026-11-27T15:00:00Z'))).toEqual({ kind: 'soon' });
    });

    it('holds weekly buys when the calendar does not cover today, and leaves daily users alone', () => {
        const expired = { ...calendar, validThrough: 0 };
        const now = at('2026-09-16T15:00:00Z');
        expect(nextBuy(user({ engine: Engine.Weekly, engineAmount: 5_000_000n }), expired, now)).toEqual({
            kind: 'hold',
        });
        expect(nextBuy(user({ engine: Engine.Daily, engineAmount: 1_000_000n }), expired, now)).toEqual({
            kind: 'soon',
        });
    });
});

describe('amounts', () => {
    it('shows raw units in UI units with the mint multiplier', () => {
        expect(uiAmount(49_400_000n, 8, 1)).toBeCloseTo(0.494, 9);
        expect(uiAmount(49_400_000n, 8, 1.0006)).toBeCloseTo(0.4942964, 9);
    });
});

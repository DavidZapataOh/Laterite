import { describe, expect, it } from 'vitest';

import { testConfig } from '../e2e/support/config';
import { type Choices, DOLLAR, enrollParams, initialChoices, paidDefaults } from '@/lib/onboarding';
import { dollars, paydayPreview } from '@/lib/preview';

import { config, exited, wallet } from './state';

/** Wednesday 2026-09-30 15:00 UTC. */
const WEDNESDAY = 1_790_780_400n;
/** Saturday 2026-10-03 12:00 UTC. */
const SATURDAY = 1_791_028_800n;
const DAY = 86_400n;

const preview = (changes: Partial<Choices>, options: Partial<Parameters<typeof paydayPreview>[0]> = {}) =>
    paydayPreview({
        account: null,
        balances: [0n, 0n],
        config,
        now: WEDNESDAY,
        params: enrollParams({ ...initialChoices(0b01), ...changes }),
        user: wallet,
        ...options,
    });

describe('the payday preview', () => {
    it('invests the first week at the $5 trial cap; the rest of the income share waits', () => {
        expect(preview({})).toEqual({
            binding: 'cap',
            cap: 5n * DOLLAR,
            invested: 5n * DOLLAR,
            nextWeek: 10n * DOLLAR,
            trial: true,
            waits: 95n * DOLLAR,
        });
        expect(preview({ tier: 1 })).toMatchObject({
            invested: 5n * DOLLAR,
            nextWeek: 25n * DOLLAR,
            waits: 95n * DOLLAR,
        });
    });

    it('buys a dollar a day with savings, eight times in a week that touches eight UTC days', () => {
        expect(preview(paidDefaults('savings'))).toMatchObject({
            binding: 'cap',
            invested: 5n * DOLLAR,
            nextWeek: 8n * DOLLAR,
            waits: 0n,
        });
    });

    it('buys with the weekly engine only in a regular NYSE session', () => {
        const weekly = { engine: 'weekly', engineAmount: 5n * DOLLAR, incomeRule: false } as const;
        expect(preview(weekly, { now: SATURDAY })).toMatchObject({ invested: 5n * DOLLAR, nextWeek: 5n * DOLLAR });
        const closed = testConfig({ marketCalendar: { ...config.marketCalendar, validThrough: 0 } });
        expect(preview(weekly, { config: closed, now: SATURDAY })).toMatchObject({ binding: 'rules', invested: 0n });
        // weekly-engine sweeps wait for a session, the income rule's share included
        expect(preview({ ...weekly, incomeRule: true }, { config: closed })).toMatchObject({
            invested: 0n,
            waits: 100n * DOLLAR,
        });
    });

    it('keeps a returning account’s week: its spending counts and no new trial week', () => {
        const enrolledAt = WEDNESDAY - 10n * DAY;
        expect(preview({}, { account: exited(enrolledAt, 1, 4n * DOLLAR) })).toMatchObject({
            binding: 'cap',
            cap: 10n * DOLLAR,
            invested: 6n * DOLLAR,
            trial: false,
            waits: 94n * DOLLAR,
        });
        expect(preview({}, { account: exited(WEDNESDAY - 2n * DAY, 0, 5n * DOLLAR) })).toMatchObject({
            cap: 5n * DOLLAR,
            invested: 0n,
            trial: true,
        });
    });

    it('never goes into the cushion', () => {
        expect(preview({ cushion: 1_000n * DOLLAR })).toMatchObject({ binding: 'balance', invested: 0n });
        expect(preview({ cushion: 998n * DOLLAR })).toMatchObject({ binding: 'balance', invested: 2n * DOLLAR });
    });

    it('adds nothing through change per payment, which counts the payments the user makes', () => {
        expect(preview({ changeMultiplier: 3, incomeRule: false })).toMatchObject({ binding: 'rules', invested: 0n });
    });
});

describe('dollars', () => {
    it('writes cents in the locale’s digits', () => {
        expect(dollars(1_234_567_890n, 'en')).toBe('$1,234.56');
        expect(dollars(1_234_567_890n, 'es-AR')).toBe('$1.234,56');
        expect(dollars(10n * DOLLAR, 'en', false)).toBe('$10');
    });
});

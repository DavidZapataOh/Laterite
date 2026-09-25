import {
    Engine,
    getEnrollParamsDecoder,
    getEnrollParamsEncoder,
    LateriteCheckError,
    UserStatus,
} from '@laterite/client';
import { describe, expect, it } from 'vitest';

import { testConfig } from '../e2e/support/config';
import {
    type Choices,
    closedReason,
    DOLLAR,
    enrollParams,
    goalLabelBytes,
    initialChoices,
    offeredTiers,
    onboardingIntent,
    paidDefaults,
    parseDollars,
    problemOf,
    tokenOffers,
} from '@/lib/onboarding';

import { config, exited, other, userState } from './state';

const choices = (changes: Partial<Choices> = {}): Choices => ({ ...initialChoices(0b11), ...changes });
const both = tokenOffers(config, userState([{ amount: 0n }, { amount: 0n }]));

describe('the choices', () => {
    it('start from stablecoins, $10, $20 cushions and SPYx; savings pick a dollar a day instead', () => {
        expect(initialChoices(0b01)).toEqual({
            asset: 0,
            changeMultiplier: 0,
            cushion: 20n * DOLLAR,
            engine: 'off',
            engineAmount: 0n,
            goalAmount: 0n,
            goalLabel: '',
            incomeRule: true,
            paid: 'stablecoins',
            paymentTokens: 0b01,
            replaceDelegates: 0,
            tier: 0,
        });
        expect(paidDefaults('savings')).toEqual({
            engine: 'daily',
            engineAmount: DOLLAR,
            incomeRule: false,
            paid: 'savings',
        });
    });

    it('map exactly onto EnrollParams', () => {
        const params = enrollParams(
            choices({
                asset: 1,
                changeMultiplier: 2,
                cushion: 35_500_000n,
                engine: 'weekly',
                engineAmount: 5n * DOLLAR,
                goalAmount: 5_000n * DOLLAR,
                goalLabel: '  Casa en Córdoba ',
                paymentTokens: 0b10,
                tier: 1,
            }),
        );
        const decoded = getEnrollParamsDecoder().decode(getEnrollParamsEncoder().encode(params));
        expect(decoded).toEqual({
            asset: 1,
            changeMultiplier: 2,
            cushions: [35_500_000n, 35_500_000n],
            engine: Engine.Weekly,
            engineAmount: 5_000_000n,
            goalAmount: 5_000_000_000n,
            goalLabel: goalLabelBytes('Casa en Córdoba'),
            incomeRule: true,
            paymentTokens: 0b10,
            tier: 1,
        });
        expect(new TextDecoder().decode(decoded.goalLabel).replace(/\0+$/, '')).toBe('Casa en Córdoba');
        // an engine that is off buys nothing, whatever amount was typed
        expect(enrollParams(choices({ engine: 'off', engineAmount: 3n * DOLLAR }))).toMatchObject({
            engine: Engine.Daily,
            engineAmount: 0n,
        });
    });

    it('refuse a goal label over 32 bytes of UTF-8', () => {
        expect(goalLabelBytes('ñ'.repeat(16))).toHaveLength(32);
        expect(() => goalLabelBytes('ñ'.repeat(16) + 'x')).toThrow(new RangeError('the goal label is 33 bytes'));
    });
});

describe('what the wallet is offered', () => {
    it('offers only the tokens whose account exists and is not frozen, and names a prior delegate', () => {
        const offers = tokenOffers(
            config,
            userState([
                { amount: 7n * DOLLAR, delegate: 'other', delegatedAmount: 40n * DOLLAR },
                { amount: 0n, frozen: true },
            ]),
        );
        expect(offers).toEqual([
            {
                balance: 7n * DOLLAR,
                delegate: { address: other, amount: 40n * DOLLAR },
                frozen: false,
                offered: true,
                paymentToken: 0,
                symbol: 'USDC',
            },
            { balance: 0n, delegate: null, frozen: true, offered: false, paymentToken: 1, symbol: 'USDT' },
        ]);
        expect(tokenOffers(config, userState([{ amount: 0n, delegate: 'authority' }, null]))).toMatchObject([
            { delegate: null, offered: true },
            { delegate: null, offered: false },
        ]);
    });

    it('closes before any signature while the program is paused or the beta is full', () => {
        expect(closedReason(config)).toBeNull();
        expect(closedReason(testConfig({ paused: true }))).toBe('paused');
        expect(closedReason(testConfig({ maxUsers: 3, userCount: 3 }))).toBe('full');
    });

    it('offers no cap above the beta’s cap per user', () => {
        expect(offeredTiers(config)).toEqual([0, 1]);
        expect(offeredTiers(testConfig({ userWeeklyCap: 10n * DOLLAR }))).toEqual([0]);
        expect(offeredTiers(testConfig({ userWeeklyCap: 9n * DOLLAR }))).toEqual([]);
    });
});

describe('the problems the review waits on', () => {
    it('names the first one', () => {
        const problem = (changes: Partial<Choices>, offers = both, cfg = config) =>
            problemOf(choices(changes), cfg, offers);
        expect(problem({})).toBeNull();
        expect(problem({ tier: 1 }, both, testConfig({ userWeeklyCap: 10n * DOLLAR }))).toBe('tier');
        expect(problem({ engine: 'daily', engineAmount: 0n })).toBe('engineAmount');
        expect(problem({ engine: 'daily', engineAmount: 11n * DOLLAR })).toBe('engineAboveCap');
        expect(problem({ engine: 'daily', engineAmount: 11n * DOLLAR, tier: 1 })).toBeNull();
        expect(problem({ incomeRule: false })).toBe('nothingInvests');
        expect(problem({ changeMultiplier: 1, incomeRule: false })).toBeNull();
        expect(problem({ goalLabel: 'x'.repeat(33) })).toBe('goalLabel');
        expect(problem({ paymentTokens: 0 })).toBe('noToken');
        const missing = tokenOffers(config, userState([{ amount: 0n }, null]));
        expect(problem({ paymentTokens: 0b11 }, missing)).toBe('noToken');
        expect(problem({ paymentTokens: 0b01 }, missing)).toBeNull();
        const delegated = tokenOffers(config, userState([{ amount: 0n }, { amount: 0n, delegate: 'other' }]));
        expect(problem({}, delegated)).toBe('delegate');
        expect(problem({ replaceDelegates: 0b10 }, delegated)).toBeNull();
        expect(problem({ paymentTokens: 0b01 }, delegated)).toBeNull();
    });
});

describe('the intent', () => {
    it('enrolls a new wallet and reactivates an exited one, with the same params', () => {
        const state = userState([{ amount: 0n }, { amount: 0n }]);
        expect(onboardingIntent(choices(), state)).toEqual({ kind: 'enroll', params: enrollParams(choices()) });
        const back = userState([{ amount: 0n }, { amount: 0n }], exited(0n, 0, 0n));
        expect(onboardingIntent(choices(), back)).toEqual({ kind: 'reactivate', params: enrollParams(choices()) });
        const active = userState([], { ...exited(0n, 0, 0n), status: UserStatus.Active });
        expect(() => onboardingIntent(choices(), active)).toThrow('already enrolled');
    });

    it('checks the params as the program does', () => {
        const state = userState([{ amount: 0n }, { amount: 0n }]);
        expect(() => onboardingIntent(choices({ incomeRule: false }), state)).toThrow(LateriteCheckError);
        expect(() => onboardingIntent(choices({ paymentTokens: 0 }), state)).toThrow(LateriteCheckError);
    });
});

describe('parseDollars', () => {
    it('reads dollars and cents as raw units', () => {
        expect(parseDollars('5,000')).toBe(5_000n * DOLLAR);
        expect(parseDollars('$12.5')).toBe(12_500_000n);
        expect(parseDollars(' 20 ')).toBe(20n * DOLLAR);
        expect(parseDollars('0')).toBe(0n);
        for (const text of ['', '1.234', '-3', '1,00', 'ten', '1e3']) expect(parseDollars(text)).toBeNull();
        expect(parseDollars('99999999999999999')).toBeNull();
    });

    it('reads the locale’s separators', () => {
        expect(parseDollars('5.000', 'es-AR')).toBe(5_000n * DOLLAR);
        expect(parseDollars('12,5', 'es-AR')).toBe(12_500_000n);
        expect(parseDollars('5,000', 'es-AR')).toBeNull();
        expect(parseDollars('5.000', 'en')).toBeNull();
    });
});

import { type Address, getBase64Decoder, getBase64Encoder } from '@solana/kit';
import {
    assertValidRules,
    type Config,
    Engine,
    type EnrollParamsArgs,
    getEnrollParamsDecoder,
    getEnrollParamsEncoder,
    TIERS,
    type UserState,
    UserStatus,
} from '@laterite/client';
import { addresses, type TokenSymbol } from '@laterite/devnet/addresses';

/** One dollar in payment-token raw units. */
export const DOLLAR = 1_000_000n;

/** A goal label is stored as at most 32 bytes of UTF-8. */
export const GOAL_LABEL_BYTES = 32;

/** What the wallet chooses on the onboarding screen, before it becomes `EnrollParams`. */
export type Choices = {
    /** How the user gets paid: only picks the defaults of the engine and the income rule, never stored. */
    paid: 'savings' | 'stablecoins';
    /** Index into `TIERS`: the combined weekly cap. */
    tier: number;
    engine: 'daily' | 'off' | 'weekly';
    /** What the engine buys each day or week, in raw units. */
    engineAmount: bigint;
    incomeRule: boolean;
    /** Change per payment: 0 (off) to 3. */
    changeMultiplier: number;
    /** Balance left untouched in each payment token, in raw units. */
    cushion: bigint;
    goalLabel: string;
    goalAmount: bigint;
    /** Index into `Config.assets`. */
    asset: number;
    /** Bit `i` set when `Config.paymentTokens[i]` is chosen. */
    paymentTokens: number;
    /** Payment tokens whose existing approval the user agreed to replace, as a bitmask. */
    replaceDelegates: number;
};

/** The defaults each answer to "How do you get paid?" picks: the income rule for stablecoins, $1 a day for savings. */
export function paidDefaults(paid: Choices['paid']): Pick<Choices, 'engine' | 'engineAmount' | 'incomeRule' | 'paid'> {
    return paid === 'stablecoins'
        ? { engine: 'off', engineAmount: 0n, incomeRule: true, paid }
        : { engine: 'daily', engineAmount: DOLLAR, incomeRule: false, paid };
}

/** The first choices a wallet sees: paid in stablecoins, $10 a week, $20 cushions, SPYx, every token it holds. */
export function initialChoices(offered: number): Choices {
    return {
        ...paidDefaults('stablecoins'),
        asset: 0,
        changeMultiplier: 0,
        cushion: 20n * DOLLAR,
        goalAmount: 0n,
        goalLabel: '',
        paymentTokens: offered,
        replaceDelegates: 0,
        tier: 0,
    };
}

/** The symbol of a devnet mint Laterite knows, from `@laterite/devnet/addresses`. */
export function symbolOf(mint: Address): TokenSymbol | null {
    const found = Object.entries(addresses.tokens).find(([, token]) => token.mint === mint);
    return found ? (found[0] as TokenSymbol) : null;
}

/** What a wallet's payment-token account allows at onboarding. */
export type TokenOffer = {
    paymentToken: number;
    symbol: TokenSymbol | null;
    /** The wallet has the account, so its authority can approve it; the faucet creates both otherwise. */
    offered: boolean;
    frozen: boolean;
    /** Another program the account already approves, which Laterite's approval would replace. */
    delegate: { address: Address; amount: bigint } | null;
    balance: bigint;
};

/**
 * The wallet's payment-token accounts as onboarding offers them: only an existing, unfrozen account can be chosen,
 * and an approval of anyone but the user's own Subscriptions authority is a prior delegate to confirm.
 */
export function tokenOffers(config: Config, state: UserState): TokenOffer[] {
    return state.tokens.map(token => {
        const account = token.accountState;
        const foreign = account?.delegate && account.delegate !== token.authority;
        return {
            balance: account?.amount ?? 0n,
            delegate: foreign ? { address: account.delegate!, amount: account.delegatedAmount } : null,
            frozen: account?.frozen ?? false,
            offered: account !== null && !account.frozen,
            paymentToken: token.paymentToken,
            symbol: symbolOf(config.paymentTokens[token.paymentToken]!.mint),
        };
    });
}

/** Why no signature can be asked for at all: the kill switch or a full beta, as `enroll` and `reactivate` refuse. */
export type Closed = 'full' | 'paused' | null;

export function closedReason(config: Config): Closed {
    if (config.paused) return 'paused';
    if (config.userCount >= config.maxUsers) return 'full';
    return null;
}

/** The tiers the beta's cap per user allows. */
export function offeredTiers(config: Config): number[] {
    return TIERS.flatMap((cap, tier) => (cap <= config.userWeeklyCap ? [tier] : []));
}

/** Why the choices cannot go to the permission screen yet, or null when they can. */
export type Problem =
    'delegate' | 'engineAboveCap' | 'engineAmount' | 'goalLabel' | 'noToken' | 'nothingInvests' | 'tier';

/** The first reason the choices cannot be signed, checked in the order the screen shows them. */
export function problemOf(choices: Choices, config: Config, offers: TokenOffer[]): Problem | null {
    if (!offeredTiers(config).includes(choices.tier)) return 'tier';
    const cap = TIERS[choices.tier as 0 | 1];
    if (choices.engine !== 'off' && choices.engineAmount === 0n) return 'engineAmount';
    if (choices.engine !== 'off' && choices.engineAmount > cap) return 'engineAboveCap';
    if (choices.engine === 'off' && !choices.incomeRule && choices.changeMultiplier === 0) return 'nothingInvests';
    if (new TextEncoder().encode(choices.goalLabel.trim()).length > GOAL_LABEL_BYTES) return 'goalLabel';
    const chosen = offers.filter(offer => choices.paymentTokens & (1 << offer.paymentToken));
    if (chosen.length === 0 || chosen.some(offer => !offer.offered)) return 'noToken';
    if (chosen.some(offer => offer.delegate && !(choices.replaceDelegates & (1 << offer.paymentToken)))) {
        return 'delegate';
    }
    return null;
}

/** The goal label as the program stores it: UTF-8, zero-padded to 32 bytes. */
export function goalLabelBytes(label: string): Uint8Array {
    const encoded = new TextEncoder().encode(label.trim());
    if (encoded.length > GOAL_LABEL_BYTES) throw new RangeError(`the goal label is ${encoded.length} bytes`);
    const bytes = new Uint8Array(GOAL_LABEL_BYTES);
    bytes.set(encoded);
    return bytes;
}

/** The `EnrollParams` the choices sign: an engine that is off is the daily engine with nothing to buy. */
export function enrollParams(choices: Choices): EnrollParamsArgs {
    return {
        asset: choices.asset,
        changeMultiplier: choices.changeMultiplier,
        cushions: [choices.cushion, choices.cushion],
        engine: choices.engine === 'weekly' ? Engine.Weekly : Engine.Daily,
        engineAmount: choices.engine === 'off' ? 0n : choices.engineAmount,
        goalAmount: choices.goalAmount,
        goalLabel: goalLabelBytes(choices.goalLabel),
        incomeRule: choices.incomeRule,
        paymentTokens: choices.paymentTokens,
        tier: choices.tier,
    };
}

/**
 * What onboarding hands to the permission screen: the validated `EnrollParams`, for `enroll` when the wallet never
 * enrolled and for `reactivate` when it exited (the same account returns with the settings chosen again).
 */
export type OnboardingIntent = { kind: 'enroll' | 'reactivate'; params: EnrollParamsArgs };

/** The intent for `choices`, checked as the program checks `EnrollParams` (`validate_rules`). */
export function onboardingIntent(choices: Choices, state: UserState): OnboardingIntent {
    const params = enrollParams(choices);
    assertValidRules(params);
    const status = state.userConfig?.status;
    if (status !== undefined && status !== UserStatus.Exited) throw new Error('the wallet is already enrolled');
    return { kind: status === UserStatus.Exited ? 'reactivate' : 'enroll', params };
}

/** An intent as the permission screen sends it to the sponsor route: its kind and its `EnrollParams` in base64. */
export type IntentBody = { kind: OnboardingIntent['kind']; params: string };

export function intentBody({ kind, params }: OnboardingIntent): IntentBody {
    return { kind, params: getBase64Decoder().decode(getEnrollParamsEncoder().encode(params)) };
}

/** The intent a request carries, or null unless it is a known kind with exactly one encoded `EnrollParams`. */
export function readIntentBody(body: unknown): OnboardingIntent | null {
    const { kind, params } = (body ?? {}) as Partial<Record<keyof IntentBody, unknown>>;
    if ((kind !== 'enroll' && kind !== 'reactivate') || typeof params !== 'string') return null;
    const decoder = getEnrollParamsDecoder();
    let bytes: Uint8Array;
    try {
        bytes = getBase64Encoder().encode(params) as Uint8Array;
    } catch {
        return null;
    }
    // Node's decoder skips what follows padding: only the canonical encoding of exactly one value is read
    if (bytes.length !== decoder.fixedSize || getBase64Decoder().decode(bytes) !== params) return null;
    try {
        return { kind, params: decoder.decode(bytes) };
    } catch {
        return null;
    }
}

/**
 * Dollars typed by the user as raw units, in `locale`'s separators (`5,000` and `12.5` in English, `5.000` and `12,5`
 * in Spanish), or null when the text is not an amount in cents.
 */
export function parseDollars(text: string, locale = 'en'): bigint | null {
    // a locale that writes 1,5 swaps the two separators before reading
    if (new Intl.NumberFormat(locale).format(1.5).includes(',')) {
        text = text.replace(/[.,]/g, separator => (separator === '.' ? ',' : '.'));
    }
    const match = /^\s*\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?\s*$/.exec(text);
    if (!match) return null;
    const cents = BigInt(match[1]!.replaceAll(',', '')) * 100n + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
    const raw = cents * (DOLLAR / 100n);
    return raw < 2n ** 64n ? raw : null;
}

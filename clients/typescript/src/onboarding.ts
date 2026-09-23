import {
    type Address,
    type GetMultipleAccountsApi,
    type Instruction,
    type Rpc,
    type TransactionSigner,
} from '@solana/kit';
import {
    findEventAuthorityPda,
    getCancelSubscriptionOverlayInstructionAsync,
    type Plan,
    SUBSCRIPTIONS_PROGRAM_ADDRESS,
    type SubscriptionDelegation,
} from '@solana/subscriptions';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import {
    ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    getCreateAssociatedTokenIdempotentInstructionAsync,
    TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';

import { enabledPaymentTokens, findPlanAddress, findVaultPda } from './addresses';
import { PAYMENT_TOKEN_COUNT, TIERS } from './constants';
import { LateriteCheckError, RecordedPayerRequiredError } from './errors';
import {
    type Config,
    type EnrollParamsArgs,
    findConfigPda,
    getEnrollInstructionAsync,
    getReactivateInstructionAsync,
    LATERITE_ERROR__BETA_FULL,
    LATERITE_ERROR__CAP_ABOVE_BETA_LIMIT,
    LATERITE_ERROR__INVALID_RULES,
    LATERITE_ERROR__INVALID_TIER,
    LATERITE_ERROR__NO_PAYMENT_TOKEN,
    LATERITE_ERROR__NOT_SPONSOR,
    LATERITE_ERROR__PROGRAM_PAUSED,
    LATERITE_ERROR__UNKNOWN_ASSET,
    LATERITE_ERROR__UNKNOWN_PAYMENT_TOKEN,
    LATERITE_ERROR__USER_NOT_ACTIVE,
    LATERITE_ERROR__USER_NOT_EXITED,
    LATERITE_PROGRAM_ADDRESS,
    UserStatus,
} from './generated';
import {
    fetchUserState,
    planState,
    readonly,
    subscriptionInstructions,
    type UserState,
    withRemainingAccounts,
} from './user-state';

/**
 * The accounts every onboarding shares, which the deployment puts in the onboarding lookup table (ADR-003): the
 * programs, Subscriptions' event authority, the config, the vault, the four mints and the four plans.
 */
export async function getOnboardingLookupTableAddresses(config: Config): Promise<Address[]> {
    const [[subscriptionsEventAuthority], [configAddress], [vault], plans] = await Promise.all([
        findEventAuthorityPda(),
        findConfigPda(),
        findVaultPda(),
        Promise.all([0, 1].flatMap(paymentToken => [0, 1].map(tier => findPlanAddress(paymentToken, tier)))),
    ]);
    return [
        SYSTEM_PROGRAM_ADDRESS,
        TOKEN_PROGRAM_ADDRESS,
        TOKEN_2022_PROGRAM_ADDRESS,
        ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
        SUBSCRIPTIONS_PROGRAM_ADDRESS,
        subscriptionsEventAuthority,
        LATERITE_PROGRAM_ADDRESS,
        configAddress,
        vault,
        ...config.assets.map(asset => asset.mint),
        ...config.paymentTokens.map(token => token.mint),
        ...plans,
    ];
}

/** The rules `EnrollParams::validate_rules` checks: the tier, the asset, the tokens and something to invest. */
export function assertValidRules(params: EnrollParamsArgs) {
    const cap = TIERS[params.tier as 0 | 1];
    if (cap === undefined) throw new LateriteCheckError(LATERITE_ERROR__INVALID_TIER);
    if (params.asset >= 2) throw new LateriteCheckError(LATERITE_ERROR__UNKNOWN_ASSET);
    if (params.paymentTokens === 0) throw new LateriteCheckError(LATERITE_ERROR__NO_PAYMENT_TOKEN);
    if (params.paymentTokens >> PAYMENT_TOKEN_COUNT !== 0) {
        throw new LateriteCheckError(LATERITE_ERROR__UNKNOWN_PAYMENT_TOKEN);
    }
    const engineAmount = BigInt(params.engineAmount);
    const invests = engineAmount > 0n || params.incomeRule || params.changeMultiplier > 0;
    if (!invests || params.changeMultiplier > 3 || engineAmount > cap) {
        throw new LateriteCheckError(LATERITE_ERROR__INVALID_RULES);
    }
}

/** What `enroll` and `reactivate` check before they take a seat: the kill switch, the seat, the beta cap, the rules. */
function assertCanJoin(config: Config, sponsor: TransactionSigner, params: EnrollParamsArgs) {
    if (config.paused) throw new LateriteCheckError(LATERITE_ERROR__PROGRAM_PAUSED);
    if (sponsor.address !== config.sponsor) throw new LateriteCheckError(LATERITE_ERROR__NOT_SPONSOR);
    if (config.userCount >= config.maxUsers) throw new LateriteCheckError(LATERITE_ERROR__BETA_FULL);
    const cap = TIERS[params.tier as 0 | 1];
    if (cap === undefined) throw new LateriteCheckError(LATERITE_ERROR__INVALID_TIER);
    if (config.userWeeklyCap < cap) throw new LateriteCheckError(LATERITE_ERROR__CAP_ABOVE_BETA_LIMIT);
    assertValidRules(params);
}

type JoinInput = {
    config: Config;
    params: EnrollParamsArgs;
    /** Retired sponsor keys, each able to close the subscriptions it recorded paying for. */
    payers?: readonly TransactionSigner[];
    rpc: Rpc<GetMultipleAccountsApi>;
    sponsor: TransactionSigner;
    user: TransactionSigner;
};

/** A sponsored transaction's instructions, and whether they create the user's account in an asset. */
export type SponsoredInstructions = { createsAssetAccount: boolean; instructions: Instruction[] };

/** The user's account in `asset` when it does not exist yet, paid by the sponsor. */
export async function assetAccountInstructions(input: {
    asset: number;
    config: Config;
    sponsor: TransactionSigner;
    state: UserState;
    user: TransactionSigner;
}): Promise<Instruction[]> {
    const { asset, config, sponsor, state, user } = input;
    if (state.assets[asset]!.exists) return [];
    const { mint, tokenProgram } = config.assets[asset]!;
    return [
        await getCreateAssociatedTokenIdempotentInstructionAsync({
            mint,
            owner: user.address,
            payer: sponsor,
            tokenProgram,
        }),
    ];
}

/** The asset's account when missing, then a live subscription to the tier's plan per enabled token, as `enroll` requires. */
async function joinInstructions(input: JoinInput, state: UserState) {
    const { config, params, sponsor, user } = input;
    const instructions = await assetAccountInstructions({ asset: params.asset, config, sponsor, state, user });
    const createsAssetAccount = instructions.length > 0;
    const subscriptions: Address[] = [];
    for (const paymentToken of enabledPaymentTokens(params.paymentTokens)) {
        const plan = planState(state, paymentToken, params.tier);
        const token = state.tokens[paymentToken]!;
        instructions.push(
            ...(await subscriptionInstructions({ now: state.now, payers: input.payers, plan, sponsor, token, user })),
        );
        subscriptions.push(plan.subscription);
    }
    return { createsAssetAccount, instructions, subscriptions };
}

/**
 * A new user's onboarding (ADR-003): the asset's account unless it exists, then per enabled payment token the
 * Subscriptions authority when the user has none for that mint (or its approval was removed) and the subscription to
 * the tier's plan, then `enroll` with the subscriptions as remaining accounts. The sponsor pays the fee and every
 * rent; the user signs once. Send it with {@link createSponsoredTransactionMessage}.
 */
export async function getOnboardingInstructions(input: JoinInput): Promise<SponsoredInstructions> {
    assertCanJoin(input.config, input.sponsor, input.params);
    const state = await fetchUserState(input.rpc, input.config, input.user.address);
    if (state.userConfig) {
        throw new Error(`${input.user.address} has enrolled before; it returns through reactivation`);
    }
    const { createsAssetAccount, instructions, subscriptions } = await joinInstructions(input, state);
    const enroll = await getEnrollInstructionAsync({ params: input.params, payer: input.sponsor, user: input.user });
    return {
        createsAssetAccount,
        instructions: [...instructions, withRemainingAccounts(enroll, subscriptions.map(readonly))],
    };
}

/**
 * An exited user's return, shaped like onboarding (the settings are chosen again): the asset's account unless it
 * exists, per enabled token the authority when it was revoked and the subscription (closing the ended one left at
 * the plan's address), then `reactivate`, signed by the user and the configured sponsor.
 */
export async function getReactivationInstructions(input: JoinInput): Promise<SponsoredInstructions> {
    assertCanJoin(input.config, input.sponsor, input.params);
    const state = await fetchUserState(input.rpc, input.config, input.user.address);
    if (state.userConfig?.status !== UserStatus.Exited) throw new LateriteCheckError(LATERITE_ERROR__USER_NOT_EXITED);
    const { createsAssetAccount, instructions, subscriptions } = await joinInstructions(input, state);
    const reactivate = await getReactivateInstructionAsync({
        params: input.params,
        sponsor: input.sponsor,
        user: input.user,
    });
    return {
        createsAssetAccount,
        instructions: [...instructions, withRemainingAccounts(reactivate, subscriptions.map(readonly))],
    };
}

/**
 * When a subscription cancelled at `now` stops running: the end of its current period, as `cancel_subscription`
 * sets it, never past the plan's end.
 */
export function cancellationExpiry(subscription: SubscriptionDelegation, plan: Plan, now: bigint): bigint {
    const period = subscription.terms.periodHours * 3_600n;
    const start = subscription.currentPeriodStartTs;
    const elapsed = now > start ? (now - start) / period : 0n;
    const end = start + (elapsed + 1n) * period;
    return plan.data.endTs !== 0n && plan.data.endTs < end ? plan.data.endTs : end;
}

/** Restore's result: the instructions, and when the token can be restored if they only prepare it. */
export type RestoreInstructions = { instructions: Instruction[]; restorableAt: bigint | null };

/**
 * Restores an enabled payment token of an active or paused user whose subscription or approval was ended outside
 * Laterite, sponsored: renews the account's approval, resumes a subscription the user cancelled that still runs, or
 * closes the ended one and subscribes again (the authority re-created when it was revoked). A subscription whose
 * authority is gone is closed by the payer it recorded, the sponsor or one of `payers` (retired sponsor keys, which
 * sign only that close); when none is at hand, the user cancels it instead and `restorableAt` says when it will have
 * run out, from which the same call closes it through the user and subscribes again. No Laterite instruction runs.
 */
export async function getRestoreInstructions(input: {
    config: Config;
    paymentToken: number;
    payers?: readonly TransactionSigner[];
    rpc: Rpc<GetMultipleAccountsApi>;
    sponsor: TransactionSigner;
    user: TransactionSigner;
}): Promise<RestoreInstructions> {
    const { paymentToken, sponsor, user } = input;
    const state = await fetchUserState(input.rpc, input.config, user.address);
    const { userConfig } = state;
    if (!userConfig || userConfig.status === UserStatus.Exited) {
        throw new LateriteCheckError(LATERITE_ERROR__USER_NOT_ACTIVE);
    }
    if ((userConfig.paymentTokens & (1 << paymentToken)) === 0) {
        throw new LateriteCheckError(LATERITE_ERROR__UNKNOWN_PAYMENT_TOKEN);
    }
    const plan = planState(state, paymentToken, userConfig.tier);
    const token = state.tokens[paymentToken]!;
    try {
        const instructions = await subscriptionInstructions({
            now: state.now,
            payers: input.payers,
            plan,
            sponsor,
            token,
            user,
        });
        return { instructions, restorableAt: null };
    } catch (error) {
        if (!(error instanceof RecordedPayerRequiredError)) throw error;
    }
    const subscription = plan.subscriptionState!;
    if (subscription.expiresAtTs !== 0n) return { instructions: [], restorableAt: subscription.expiresAtTs };
    return {
        instructions: [
            await getCancelSubscriptionOverlayInstructionAsync({
                planPda: plan.plan,
                subscriber: user,
                subscriptionPda: plan.subscription,
            }),
        ],
        restorableAt: cancellationExpiry(subscription, plan.planState, state.now),
    };
}

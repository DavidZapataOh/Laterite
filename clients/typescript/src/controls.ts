import {
    type AccountMeta,
    type Address,
    fetchEncodedAccounts,
    type GetMultipleAccountsApi,
    type GetProgramAccountsApi,
    type Instruction,
    type Rpc,
    type TransactionSigner,
} from '@solana/kit';
import { decodePlan, fetchDelegationsByDelegator, SUBSCRIPTIONS_PROGRAM_ADDRESS } from '@solana/subscriptions';

import { enabledPaymentTokens } from './addresses';
import { TIERS } from './constants';
import { LateriteCheckError } from './errors';
import {
    type Config,
    type EnrollParamsArgs,
    getChangePaymentTokensInstruction,
    getChangeTierInstruction,
    getExitInstruction,
    getLowerPendingInstructionAsync,
    getSetUserPausedInstructionAsync,
    getUpdateSettingsInstructionAsync,
    LATERITE_ERROR__CAP_ABOVE_BETA_LIMIT,
    LATERITE_ERROR__INVALID_RULES,
    LATERITE_ERROR__INVALID_TIER,
    LATERITE_ERROR__NO_PAYMENT_TOKEN,
    LATERITE_ERROR__PENDING_INCREASE,
    LATERITE_ERROR__PLAN_CHANGE_REQUIRED,
    LATERITE_ERROR__USER_NOT_ACTIVE,
    LATERITE_ERROR__USER_NOT_PAUSED,
    type UserConfig,
    UserStatus,
} from './generated';
import { assertValidRules, assetAccountInstructions, type SponsoredInstructions } from './onboarding';
import {
    closeSubscriptionInstruction,
    fetchUserState,
    isRunning,
    type PlanState,
    planState,
    revokeAuthorityInstruction,
    subscriptionInstructions,
    type TokenState,
    type UserState,
    withRemainingAccounts,
    writable,
    readonly,
} from './user-state';

/** Every control but reactivation refuses a user who exited. */
function assertNotExited(userConfig: UserConfig | null): asserts userConfig is UserConfig {
    if (!userConfig || userConfig.status === UserStatus.Exited)
        throw new LateriteCheckError(LATERITE_ERROR__USER_NOT_ACTIVE);
}

/**
 * New settings with the same tier and payment tokens (`PlanChangeRequired` otherwise). A new asset needs the user's
 * account in it, since the sweep pays into it, so its creation comes first, paid by the sponsor, unless it exists.
 */
export async function getUpdateSettingsInstructions(input: {
    config: Config;
    params: EnrollParamsArgs;
    rpc: Rpc<GetMultipleAccountsApi>;
    sponsor: TransactionSigner;
    user: TransactionSigner;
}): Promise<SponsoredInstructions> {
    const { config, params, rpc, sponsor, user } = input;
    const state = await fetchUserState(rpc, config, user.address);
    const { userConfig } = state;
    assertNotExited(userConfig);
    if (params.tier !== userConfig.tier || params.paymentTokens !== userConfig.paymentTokens) {
        throw new LateriteCheckError(LATERITE_ERROR__PLAN_CHANGE_REQUIRED);
    }
    assertValidRules(params);
    const instructions = await assetAccountInstructions({ asset: params.asset, config, sponsor, state, user });
    const createsAssetAccount = instructions.length > 0;
    instructions.push(await getUpdateSettingsInstructionAsync({ params, user }));
    return { createsAssetAccount, instructions };
}

/** Pauses an active user or resumes a paused one; a resume counts only transfers from then on. */
export async function getSetUserPausedInstructions(input: {
    paused: boolean;
    user: TransactionSigner;
    userConfig: UserConfig;
}): Promise<Instruction[]> {
    const { paused, user, userConfig } = input;
    assertNotExited(userConfig);
    if (paused && userConfig.status !== UserStatus.Active)
        throw new LateriteCheckError(LATERITE_ERROR__USER_NOT_ACTIVE);
    if (!paused && userConfig.status !== UserStatus.Paused)
        throw new LateriteCheckError(LATERITE_ERROR__USER_NOT_PAUSED);
    return [await getSetUserPausedInstructionAsync({ paused, user })];
}

/** Lowers the amount waiting to be invested; it never raises it (`PendingIncrease`). */
export async function getLowerPendingInstructions(input: {
    pending: bigint;
    user: TransactionSigner;
    userConfig: UserConfig;
}): Promise<Instruction[]> {
    const { pending, user, userConfig } = input;
    assertNotExited(userConfig);
    if (pending > userConfig.pending) throw new LateriteCheckError(LATERITE_ERROR__PENDING_INCREASE);
    return [await getLowerPendingInstructionAsync({ pending, user })];
}

type ControlInput = {
    config: Config;
    /** Retired sponsor keys, each able to close the subscriptions it recorded paying for. */
    payers?: readonly TransactionSigner[];
    rpc: Rpc<GetMultipleAccountsApi & GetProgramAccountsApi>;
    sponsor: TransactionSigner;
    user: TransactionSigner;
};

/**
 * A tier change: per enabled token, a live subscription to the new tier's plan (closing a subscription an earlier
 * switch left at its address), then `change_tier`, which ends the current subscriptions at once, then those
 * subscriptions closed, their rent to the payers they recorded.
 */
export async function getChangeTierInstructions(input: ControlInput & { tier: number }): Promise<Instruction[]> {
    const { config, rpc, sponsor, tier, user } = input;
    const state = await fetchUserState(rpc, config, user.address);
    const { userConfig } = state;
    assertNotExited(userConfig);
    const cap = TIERS[tier as 0 | 1];
    if (cap === undefined || tier === userConfig.tier) throw new LateriteCheckError(LATERITE_ERROR__INVALID_TIER);
    if (config.userWeeklyCap < cap) throw new LateriteCheckError(LATERITE_ERROR__CAP_ABOVE_BETA_LIMIT);
    if (userConfig.engineAmount > cap) throw new LateriteCheckError(LATERITE_ERROR__INVALID_RULES);
    const instructions: Instruction[] = [];
    const accounts: AccountMeta[] = [];
    const closes: Instruction[] = [];
    for (const token of enabledPaymentTokens(userConfig.paymentTokens)) {
        const current = planState(state, token, userConfig.tier);
        const next = planState(state, token, tier);
        instructions.push(
            ...(await subscriptionInstructions({
                now: state.now,
                payers: input.payers,
                plan: next,
                sponsor,
                token: state.tokens[token]!,
                user,
            })),
        );
        accounts.push(readonly(current.plan), writable(current.subscription), readonly(next.subscription));
        if (current.subscriptionState) closes.push(closeSubscriptionInstruction(user, current));
    }
    instructions.push(
        withRemainingAccounts(getChangeTierInstruction({ tier, user, userConfig: state.userConfigAddress }), accounts),
    );
    return [...instructions, ...closes];
}

/**
 * A payment-token change in place: per added token, a live subscription to the tier's plan (its authority first
 * when the user has none for that mint); `change_payment_tokens`, which ends each dropped token's subscription at
 * once; then each ended subscription closed and, under {@link getExitInstructions}' rule, its authority revoked.
 */
export async function getChangePaymentTokensInstructions(
    input: ControlInput & { paymentTokens: number },
): Promise<Instruction[]> {
    const { config, paymentTokens, rpc, sponsor, user } = input;
    if (paymentTokens === 0) throw new LateriteCheckError(LATERITE_ERROR__NO_PAYMENT_TOKEN);
    const state = await fetchUserState(rpc, config, user.address);
    const { userConfig } = state;
    assertNotExited(userConfig);
    const { tier } = userConfig;
    const changed = enabledPaymentTokens(userConfig.paymentTokens ^ paymentTokens);
    const instructions: Instruction[] = [];
    const accounts: AccountMeta[] = [];
    const dropped: PlanState[] = [];
    for (const token of changed) {
        const plan = planState(state, token, tier);
        if (paymentTokens & (1 << token)) {
            instructions.push(
                ...(await subscriptionInstructions({
                    now: state.now,
                    payers: input.payers,
                    plan,
                    sponsor,
                    token: state.tokens[token]!,
                    user,
                })),
            );
            accounts.push(readonly(plan.subscription));
        } else {
            accounts.push(readonly(plan.plan), writable(plan.subscription));
            dropped.push(plan);
        }
    }
    instructions.push(
        withRemainingAccounts(
            getChangePaymentTokensInstruction({ paymentTokens, user, userConfig: state.userConfigAddress }),
            accounts,
        ),
    );
    return [...instructions, ...(await endedSubscriptionInstructions(rpc, state, user, dropped))];
}

/**
 * An exit: `exit` ends every subscription at once (each passed at its derived address, even when already closed),
 * frees the seat and keeps `UserConfig`; then each subscription that still exists is closed and each authority
 * revoked when no other subscription of the user still needs that mint, every rent to the payer it recorded.
 */
export async function getExitInstructions(input: Omit<ControlInput, 'payers' | 'sponsor'>): Promise<Instruction[]> {
    const { config, rpc, user } = input;
    const state = await fetchUserState(rpc, config, user.address);
    const { userConfig } = state;
    assertNotExited(userConfig);
    const plans = enabledPaymentTokens(userConfig.paymentTokens).map(token => planState(state, token, userConfig.tier));
    const exit = withRemainingAccounts(
        getExitInstruction({ user, userConfig: state.userConfigAddress }),
        plans.flatMap(plan => [readonly(plan.plan), writable(plan.subscription)]),
    );
    return [exit, ...(await endedSubscriptionInstructions(rpc, state, user, plans))];
}

/**
 * Closes the subscriptions this transaction ends and revokes an authority only when the user's account in that
 * mint still exists and nothing else of theirs still draws on that mint through it: no other running subscription
 * and no live fixed or recurring delegation, to any merchant (the approval is per user and mint, not per merchant).
 */
async function endedSubscriptionInstructions(
    rpc: Rpc<GetMultipleAccountsApi & GetProgramAccountsApi>,
    state: UserState,
    user: TransactionSigner,
    ended: PlanState[],
): Promise<Instruction[]> {
    const closes = ended.filter(plan => plan.subscriptionState).map(plan => closeSubscriptionInstruction(user, plan));
    const needed = await mintsInUse(rpc, state, user.address, new Set(ended.map(plan => plan.subscription)));
    const revokes: TokenState[] = ended
        .map(plan => state.tokens[plan.paymentToken]!)
        .filter(token => token.authorityState && token.accountState && !needed.has(token.mint));
    return [...closes, ...(await Promise.all(revokes.map(token => revokeAuthorityInstruction(user, token))))];
}

/**
 * The mints the user's authorities still serve, except for `ending`: running subscriptions, fixed delegations not
 * expired with an amount left, and recurring delegations not expired, to any merchant, in one `getProgramAccounts`.
 */
async function mintsInUse(
    rpc: Rpc<GetMultipleAccountsApi & GetProgramAccountsApi>,
    state: UserState,
    user: Address,
    ending: Set<Address>,
): Promise<Set<Address>> {
    const live = (expiry: bigint) => expiry === 0n || expiry > state.now;
    const mints = new Set<Address>();
    const plans: Address[] = [];
    for (const delegation of await fetchDelegationsByDelegator(rpc, user)) {
        if (ending.has(delegation.address)) continue;
        if (delegation.kind === 'fixed') {
            if (live(delegation.data.expiryTs) && delegation.data.amount > 0n) mints.add(delegation.data.mint);
        } else if (delegation.kind === 'recurring') {
            if (live(delegation.data.expiryTs)) mints.add(delegation.data.mint);
        } else if (isRunning(delegation.data, state.now)) {
            plans.push(delegation.data.header.delegatee);
        }
    }
    for (const plan of await fetchEncodedAccounts(rpc, plans)) {
        if (plan.exists && plan.programAddress === SUBSCRIPTIONS_PROGRAM_ADDRESS)
            mints.add(decodePlan(plan).data.data.mint);
    }
    return mints;
}

import {
    type AccountMeta,
    AccountRole,
    type Address,
    fetchEncodedAccounts,
    type GetMultipleAccountsApi,
    type Instruction,
    type MaybeEncodedAccount,
    type Rpc,
    type TransactionSigner,
    unwrapOption,
} from '@solana/kit';
import {
    decodePlan,
    decodeSubscriptionAuthority,
    decodeSubscriptionDelegation,
    findSubscriptionDelegationPda,
    getInitSubscriptionAuthorityOverlayInstructionAsync,
    getResumeSubscriptionOverlayInstructionAsync,
    getRevokeAbandonedSubscriptionInstruction,
    getRevokeSubscriptionAuthorityOverlayInstructionAsync,
    getRevokeSubscriptionOverlayInstruction,
    getSubscribeOverlayInstructionAsync,
    type Plan,
    SUBSCRIPTIONS_PROGRAM_ADDRESS,
    type SubscriptionAuthority,
    type SubscriptionDelegation,
    UNKNOWN_INIT_ID,
} from '@solana/subscriptions';
import { getSysvarClockDecoder, SYSVAR_CLOCK_ADDRESS } from '@solana/sysvars';
import { AccountState, findAssociatedTokenPda, getTokenDecoder } from '@solana-program/token';

import { findPlanAddress, findSubscriptionAuthorityAddress, findVaultPda, planId } from './addresses';
import { TIERS } from './constants';
import { RecordedPayerRequiredError, RestoreRequiredError } from './errors';
import {
    type Config,
    decodeUserConfig,
    findUserConfigPda,
    LATERITE_PROGRAM_ADDRESS,
    type UserConfig,
} from './generated';

/** `instruction` with `accounts` appended as its remaining accounts. */
export const withRemainingAccounts = (instruction: Instruction, accounts: AccountMeta[]): Instruction => ({
    ...instruction,
    accounts: [...(instruction.accounts ?? []), ...accounts],
});

export const readonly = (address: Address): AccountMeta => ({ address, role: AccountRole.READONLY });
export const writable = (address: Address): AccountMeta => ({ address, role: AccountRole.WRITABLE });

/** A Subscriptions account as the program reads one: owned by Subscriptions, else absent. */
const ownedBySubscriptions = (account: MaybeEncodedAccount): account is MaybeEncodedAccount & { exists: true } =>
    account.exists && account.programAddress === SUBSCRIPTIONS_PROGRAM_ADDRESS;

/** The fields of a token account the pull depends on, at the same offsets under Token and Token-2022. */
export type TokenAccountState = { amount: bigint; delegate: Address | null; delegatedAmount: bigint; frozen: boolean };

/** Decodes a token account's base layout, or `null` when `account` is not an account of `tokenProgram`. */
export function decodeTokenAccountState(account: MaybeEncodedAccount, tokenProgram: Address): TokenAccountState | null {
    if (!account.exists || account.programAddress !== tokenProgram) return null;
    const token = getTokenDecoder().decode(account.data.slice(0, 165));
    return {
        amount: token.amount,
        delegate: unwrapOption(token.delegate),
        delegatedAmount: token.delegatedAmount,
        frozen: token.state === AccountState.Frozen,
    };
}

/** A user's accounts for one payment token: their account in it and their Subscriptions authority over it. */
export type TokenState = {
    account: Address;
    /** The account's balance and approval, `null` when it does not exist. */
    accountState: TokenAccountState | null;
    authority: Address;
    authorityState: SubscriptionAuthority | null;
    mint: Address;
    paymentToken: number;
    tokenProgram: Address;
};

/** A user's subscription to one plan, with the plan's live terms. */
export type PlanState = {
    paymentToken: number;
    plan: Address;
    planState: Plan;
    subscription: Address;
    subscriptionState: SubscriptionDelegation | null;
    tier: number;
};

/** Everything a sponsored user transaction reads, fetched in one `getMultipleAccounts`. */
export type UserState = {
    /** The user's account in each asset of the table, and whether it exists. */
    assets: { account: Address; exists: boolean }[];
    now: bigint;
    plans: PlanState[];
    tokens: TokenState[];
    userConfig: UserConfig | null;
    userConfigAddress: Address;
};

const PLANS = [0, 1].flatMap(paymentToken => [0, 1].map(tier => [paymentToken, tier] as const));

/**
 * Reads, in one request, `user`'s `UserConfig`, their accounts in both assets, their accounts and authorities for
 * both payment tokens, the four plans with the user's subscription to each, and the cluster's clock.
 */
export async function fetchUserState(
    rpc: Rpc<GetMultipleAccountsApi>,
    config: Config,
    user: Address,
): Promise<UserState> {
    const [userConfigAddress] = await findUserConfigPda({ user });
    const assetAccounts = await Promise.all(
        config.assets.map(
            async ({ mint, tokenProgram }) => (await findAssociatedTokenPda({ mint, owner: user, tokenProgram }))[0],
        ),
    );
    const tokenAddresses = await Promise.all(
        config.paymentTokens.map(async ({ mint, tokenProgram }) => {
            const [[account], authority] = await Promise.all([
                findAssociatedTokenPda({ mint, owner: user, tokenProgram }),
                findSubscriptionAuthorityAddress(user, mint),
            ]);
            return { account, authority };
        }),
    );
    const planAddresses = await Promise.all(
        PLANS.map(async ([paymentToken, tier]) => {
            const plan = await findPlanAddress(paymentToken, tier);
            const [subscription] = await findSubscriptionDelegationPda({ planPda: plan, subscriber: user });
            return { plan, subscription };
        }),
    );
    const addresses = [
        SYSVAR_CLOCK_ADDRESS,
        userConfigAddress,
        ...assetAccounts,
        ...tokenAddresses.flatMap(({ account, authority }) => [account, authority]),
        ...planAddresses.flatMap(({ plan, subscription }) => [plan, subscription]),
    ];
    const [clock, userConfig, ...rest] = await fetchEncodedAccounts(rpc, addresses);
    if (!clock?.exists) throw new Error('The cluster returned no clock');
    const assets = config.assets.map(({ tokenProgram }, index) => {
        const account = rest[index]!;
        return { account: account.address, exists: account.exists && account.programAddress === tokenProgram };
    });
    const tokenAccounts = rest.slice(assets.length);
    const tokens = config.paymentTokens.map(({ mint, tokenProgram }, paymentToken) => {
        const account = tokenAccounts[2 * paymentToken]!;
        const authority = tokenAccounts[2 * paymentToken + 1]!;
        return {
            account: account.address,
            accountState: decodeTokenAccountState(account, tokenProgram),
            authority: authority.address,
            authorityState: ownedBySubscriptions(authority) ? decodeSubscriptionAuthority(authority).data : null,
            mint,
            paymentToken,
            tokenProgram,
        };
    });
    const planAccounts = tokenAccounts.slice(2 * tokens.length);
    const planStates = PLANS.map(([paymentToken, tier], index) => {
        const plan = planAccounts[2 * index]!;
        const subscription = planAccounts[2 * index + 1]!;
        if (!ownedBySubscriptions(plan)) throw new Error(`Plan ${plan.address} does not exist`);
        const planState = decodePlan(plan).data;
        if (planState.data.terms.amount !== TIERS[tier as 0 | 1]) {
            throw new Error(`Plan ${plan.address} is not tier ${tier}`);
        }
        return {
            paymentToken,
            plan: plan.address,
            planState,
            subscription: subscription.address,
            subscriptionState: ownedBySubscriptions(subscription)
                ? decodeSubscriptionDelegation(subscription).data
                : null,
            tier,
        };
    });
    return {
        assets,
        now: getSysvarClockDecoder().decode(clock.data).unixTimestamp,
        plans: planStates,
        tokens,
        userConfig:
            userConfig?.exists && userConfig.programAddress === LATERITE_PROGRAM_ADDRESS
                ? decodeUserConfig(userConfig).data
                : null,
        userConfigAddress,
    };
}

/** The user's state for the plan of a payment token's tier. */
export function planState(state: UserState, paymentToken: number, tier: number): PlanState {
    const plan = state.plans.find(entry => entry.paymentToken === paymentToken && entry.tier === tier);
    if (!plan) throw new Error(`No plan for payment token ${paymentToken} and tier ${tier}`);
    return plan;
}

/** Whether a subscription still binds its authority at `now`: not closed and not past its expiry. */
export const isRunning = (subscription: SubscriptionDelegation | null, now: bigint) =>
    subscription !== null && (subscription.expiresAtTs === 0n || subscription.expiresAtTs > now);

/**
 * Closes a subscription that ended (or will be ended in the same transaction) with `revoke_delegation`, signed by
 * the user; its rent returns to the payer it recorded, whoever the sponsor is now.
 */
export function closeSubscriptionInstruction(user: TransactionSigner, plan: PlanState): Instruction {
    if (!plan.subscriptionState) throw new Error(`No subscription at ${plan.subscription}`);
    return getRevokeSubscriptionOverlayInstruction({
        authority: user,
        planPda: plan.plan,
        receiver: plan.subscriptionState.header.payer,
        subscriptionPda: plan.subscription,
    });
}

/** Revokes the user's Subscriptions authority over a token; its rent returns to the payer it recorded. */
export function revokeAuthorityInstruction(user: TransactionSigner, token: TokenState): Promise<Instruction> {
    if (!token.authorityState) throw new Error(`No subscription authority at ${token.authority}`);
    return getRevokeSubscriptionAuthorityOverlayInstructionAsync({
        receiver: token.authorityState.payer,
        tokenMint: token.mint,
        tokenProgram: token.tokenProgram,
        user,
    });
}

/**
 * What leaves `user` with a live subscription to `plan` that the sweep can pull through. The authority's approval of
 * the user's account is renewed (`init_subscription_authority` re-approves an existing authority and keeps its payer
 * and `init_id`) whenever the account's delegate is not the authority. A live subscription through the current
 * authority is kept, and one the user cancelled that still runs is resumed. Any other account at the plan's address
 * makes `subscribe` fail with `AlreadySubscribed`, so it is closed first: an expired one by the user
 * (`revoke_delegation`), one whose authority was revoked or re-created by the payer it recorded
 * (`revoke_abandoned_subscription`), who must be the sponsor or one of `payers` (`RecordedPayerRequiredError`
 * otherwise). Then the authority is created when there is none (the sentinel `init_id`) and `subscribe` runs with
 * the authority's `init_id`. Refuses a token whose account does not exist, since the authority approves it, or is
 * frozen.
 */
export async function subscriptionInstructions(input: {
    now: bigint;
    payers?: readonly TransactionSigner[];
    plan: PlanState;
    sponsor: TransactionSigner;
    token: TokenState;
    user: TransactionSigner;
}): Promise<Instruction[]> {
    const { now, plan, sponsor, token, user } = input;
    if (!token.accountState) throw new Error(`${user.address} has no account in ${token.mint}`);
    if (token.accountState.frozen) throw new RestoreRequiredError('frozen', token.account);
    const subscription = plan.subscriptionState;
    const authority = token.authorityState;
    const approve = async () =>
        getInitSubscriptionAuthorityOverlayInstructionAsync({
            owner: user,
            payer: sponsor,
            tokenMint: token.mint,
            tokenProgram: token.tokenProgram,
            userAta: token.account,
        });
    const approved = authority !== null && token.accountState.delegate === token.authority;
    const instructions: Instruction[] = [];
    if (subscription) {
        const expired = subscription.expiresAtTs !== 0n && subscription.expiresAtTs <= now;
        const bound = authority !== null && subscription.header.initId === authority.initId;
        if (expired) {
            instructions.push(closeSubscriptionInstruction(user, plan));
        } else if (!bound) {
            const payer = [sponsor, ...(input.payers ?? [])].find(
                signer => signer.address === subscription.header.payer,
            );
            if (!payer) throw new RecordedPayerRequiredError(subscription.header.payer, plan.subscription);
            instructions.push(
                getRevokeAbandonedSubscriptionInstruction({
                    payer,
                    planPda: plan.plan,
                    subscriptionAccount: plan.subscription,
                    subscriptionAuthority: token.authority,
                }),
            );
        } else {
            if (!approved) instructions.push(await approve());
            if (subscription.expiresAtTs === 0n) return instructions;
            instructions.push(
                await getResumeSubscriptionOverlayInstructionAsync({
                    expectedExpiresAtTs: subscription.expiresAtTs,
                    planPda: plan.plan,
                    subscriber: user,
                    subscriptionPda: plan.subscription,
                    tokenMint: token.mint,
                }),
            );
            return instructions;
        }
    }
    if (!approved) instructions.push(await approve());
    const { terms } = plan.planState.data;
    const [vault] = await findVaultPda();
    instructions.push(
        await getSubscribeOverlayInstructionAsync({
            expectedAmount: terms.amount,
            expectedCreatedAt: terms.createdAt,
            expectedPeriodHours: terms.periodHours,
            expectedSubscriptionAuthorityInitId: authority ? authority.initId : UNKNOWN_INIT_ID,
            merchant: vault,
            payer: sponsor,
            planId: planId(plan.paymentToken, plan.tier),
            subscriber: user,
            tokenMint: token.mint,
        }),
    );
    return instructions;
}

import {
    type Address,
    downgradeRoleToNonSigner,
    fetchEncodedAccounts,
    type GetMultipleAccountsApi,
    getTransactionMessageSize,
    type Instruction,
    type ReadonlyUint8Array,
    type Rpc,
    type TransactionSigner,
} from '@solana/kit';
import {
    decodeSubscriptionAuthority,
    decodeSubscriptionDelegation,
    SUBSCRIPTIONS_PROGRAM_ADDRESS,
    type SubscriptionAuthority,
    type SubscriptionDelegation,
} from '@solana/subscriptions';
import { getSysvarClockDecoder, SYSVAR_CLOCK_ADDRESS } from '@solana/sysvars';
import { findAssociatedTokenPda } from '@solana-program/token';

import {
    findEventAuthorityPda,
    findPlanAddress,
    findSubscriptionAddress,
    findSubscriptionAuthorityAddress,
    findSwapAuthorityPda,
} from './addresses';
import { cappedPull, nativeRemaining, pull as enginePull, type Pull, pullTotal, weekAt } from './amount';
import { DAY_SECONDS, USD_DECIMALS, WEEK_SECONDS } from './constants';
import { getPythEd25519Instruction } from './ed25519';
import { LateriteCheckError, RestoreRequiredError } from './errors';
import {
    type Config,
    decodeConfig,
    decodeUserConfig,
    Engine,
    findConfigPda,
    findUserConfigPda,
    getSweepInstruction,
    LATERITE_ERROR__ALREADY_SWEPT,
    LATERITE_ERROR__INVALID_ROUTER,
    LATERITE_ERROR__NOTHING_TO_SWEEP,
    LATERITE_ERROR__PROGRAM_PAUSED,
    LATERITE_ERROR__UNKNOWN_ASSET,
    LATERITE_ERROR__UNKNOWN_PAYMENT_TOKEN,
    LATERITE_PROGRAM_ADDRESS,
    type UserConfig,
} from './generated';
import { divEuclid, nextMarketSession, usMarketOpen } from './market';
import { minOut, PYTH_STORAGE_ADDRESS, quote } from './pyth';
import { createSweepTransactionMessage } from './transactions';
import { decodeTokenAccountState, isRunning, type TokenAccountState } from './user-state';

/** How close to a boundary that changes the pull a sweep is not built, by default: it could land past it. */
export const SWEEP_BOUNDARY_MARGIN_SECONDS = 15n;

/** Everything a sweep's amount depends on, read in one request at the cluster's clock. */
export type SweepState = {
    /** The user's Subscriptions authority over the payment token, and its state (`null` when revoked). */
    authority: Address;
    authorityState: SubscriptionAuthority | null;
    config: Config;
    /** The cluster's clock, never the host's. */
    now: bigint;
    /** The user's account in the payment token, and its balance and approval (`null` when it does not exist). */
    paymentAccount: Address;
    paymentAccountState: TokenAccountState | null;
    paymentToken: number;
    /** The user's subscription to their tier's plan in the payment token, `null` when it is closed. */
    subscription: SubscriptionDelegation | null;
    user: Address;
    userConfig: UserConfig;
};

/** Reads the state a sweep of `user`'s `paymentToken` depends on; `config` gives the (fixed) payment-token table. */
export async function fetchSweepState(
    rpc: Rpc<GetMultipleAccountsApi>,
    input: { config: Config; paymentToken: number; user: Address },
): Promise<SweepState> {
    const { config, paymentToken, user } = input;
    const token = config.paymentTokens[paymentToken];
    if (!token) throw new LateriteCheckError(LATERITE_ERROR__UNKNOWN_PAYMENT_TOKEN);
    const [[configAddress], [userConfigAddress], [account], authority, ...subscriptions] = await Promise.all([
        findConfigPda(),
        findUserConfigPda({ user }),
        findAssociatedTokenPda({ mint: token.mint, owner: user, tokenProgram: token.tokenProgram }),
        findSubscriptionAuthorityAddress(user, token.mint),
        findSubscriptionAddress(user, paymentToken, 0),
        findSubscriptionAddress(user, paymentToken, 1),
    ]);
    const [clock, configAccount, userConfigAccount, paymentAccount, authorityAccount, ...tiers] =
        await fetchEncodedAccounts(rpc, [
            SYSVAR_CLOCK_ADDRESS,
            configAddress,
            userConfigAddress,
            account,
            authority,
            ...subscriptions,
        ]);
    if (!clock?.exists || !configAccount?.exists) throw new Error('The cluster returned no clock or config');
    if (!userConfigAccount?.exists) throw new Error(`${user} is not enrolled`);
    const userConfig = decodeUserConfig(userConfigAccount).data;
    const subscription = tiers[userConfig.tier];
    const owned = (candidate: typeof authorityAccount) =>
        candidate?.exists && candidate.programAddress === SUBSCRIPTIONS_PROGRAM_ADDRESS ? candidate : null;
    const authorityData = owned(authorityAccount);
    return {
        authority,
        authorityState: authorityData ? decodeSubscriptionAuthority(authorityData).data : null,
        config: decodeConfig(configAccount).data,
        now: getSysvarClockDecoder().decode(clock.data).unixTimestamp,
        paymentAccount: account,
        paymentAccountState: paymentAccount ? decodeTokenAccountState(paymentAccount, token.tokenProgram) : null,
        paymentToken,
        subscription: owned(subscription) ? decodeSubscriptionDelegation(owned(subscription)!).data : null,
        user,
        userConfig,
    };
}

/**
 * Exactly what the sweep will pull, as the program computes it at the state's clock: the amount engine, within
 * what the subscription's current period still allows. Throws the error the program would return first when there
 * is nothing to sweep, the token was swept today, a weekly user is outside an NYSE session, or the kill switch is on;
 * and `RestoreRequiredError` when the token was ended outside Laterite (its subscription closed or run out, its
 * authority revoked or re-created, the account frozen or its delegate not the authority), which the crank skips
 * until the user restores it.
 */
export function getSweepPull(state: SweepState): Pull {
    const { config, now, paymentToken, userConfig } = state;
    if (config.paused) throw new LateriteCheckError(LATERITE_ERROR__PROGRAM_PAUSED);
    if (!config.paymentTokens[paymentToken]) throw new LateriteCheckError(LATERITE_ERROR__UNKNOWN_PAYMENT_TOKEN);
    const today = Number(BigInt.asUintN(32, divEuclid(now, DAY_SECONDS)));
    if (today <= userConfig.lastSweepDay[paymentToken]!) throw new LateriteCheckError(LATERITE_ERROR__ALREADY_SWEPT);
    if (userConfig.engine === Engine.Weekly && !usMarketOpen(now, config.marketCalendar)) {
        throw new LateriteCheckError(LATERITE_ERROR__NOTHING_TO_SWEEP);
    }
    const balance = state.paymentAccountState?.amount ?? 0n;
    const pull = enginePull(userConfig, paymentToken, balance, config.userWeeklyCap, config.marketCalendar, now);
    if (pullTotal(pull) === 0n) throw new LateriteCheckError(LATERITE_ERROR__NOTHING_TO_SWEEP);
    if ((userConfig.paymentTokens & (1 << paymentToken)) === 0) {
        throw new LateriteCheckError(LATERITE_ERROR__UNKNOWN_PAYMENT_TOKEN);
    }
    const { authorityState, paymentAccount, paymentAccountState, subscription } = state;
    if (!isRunning(subscription, now)) throw new RestoreRequiredError('subscription', paymentAccount);
    if (authorityState?.initId !== subscription!.header.initId) {
        throw new RestoreRequiredError('authority', paymentAccount);
    }
    if (paymentAccountState?.frozen) throw new RestoreRequiredError('frozen', paymentAccount);
    const capped = cappedPull(pull, nativeRemaining(subscription, now));
    if (pullTotal(capped) === 0n) throw new LateriteCheckError(LATERITE_ERROR__NOTHING_TO_SWEEP);
    if (paymentAccountState?.delegate !== state.authority || paymentAccountState.delegatedAmount < pullTotal(capped)) {
        throw new RestoreRequiredError('delegate', paymentAccount);
    }
    return capped;
}

/**
 * Seconds from the state's clock to the next instant that can change the pull: UTC midnight, the user's next week,
 * for a weekly user the session's open or close (13:00 on an early close), and the subscription's next native
 * period or its expiry.
 */
export function secondsToNextSweepBoundary(state: SweepState): bigint {
    const { config, now, subscription, userConfig } = state;
    const boundaries = [(divEuclid(now, DAY_SECONDS) + 1n) * DAY_SECONDS];
    boundaries.push(
        now < userConfig.enrolledAt
            ? userConfig.enrolledAt
            : userConfig.enrolledAt + BigInt(weekAt(userConfig, now) + 1) * WEEK_SECONDS,
    );
    if (userConfig.engine === Engine.Weekly) {
        const session = nextMarketSession(now, config.marketCalendar);
        if (session) boundaries.push(now < session.open ? session.open : session.close);
    }
    if (subscription) {
        if (subscription.expiresAtTs > now) boundaries.push(subscription.expiresAtTs);
        const period = subscription.terms.periodHours * 3_600n;
        const start = subscription.currentPeriodStartTs;
        if (period > 0n && now >= start) boundaries.push(start + ((now - start) / period + 1n) * period);
    }
    return boundaries.reduce((next, boundary) => (boundary < next ? boundary : next)) - now;
}

/**
 * A sweep as ADR-001 shapes it, `[ed25519, sweep]`: the ed25519 instruction's entry 0 is the asset update at
 * offset 12 of the sweep's data and, for a token priced by oracle (USDT), entry 1 the payment update after it;
 * then `sweep` with `route`, an instruction of `Config.router` built for exactly {@link getSweepPull}'s total from
 * the swap authority's payment account into the user's asset account, whose accounts become the sweep's remaining
 * accounts with no signer (the program signs as the swap authority). Checks both updates as the program will and
 * that the transaction fits 4,096 bytes, and returns the minimum output the program will require and the
 * transaction's size. Send it with {@link createSweepTransactionMessage}.
 */
export async function getSweepInstructions(input: {
    assetUpdate: ReadonlyUint8Array;
    boundaryMarginSeconds?: bigint;
    crank: TransactionSigner;
    /** The payment token's own update, only for a token priced by oracle (`usdFeedId` not 0). */
    paymentUpdate?: ReadonlyUint8Array;
    pythTreasury: Address;
    route: Instruction;
    state: SweepState;
}): Promise<{ instructions: [Instruction, Instruction]; minOut: bigint; pull: Pull; size: number }> {
    const { assetUpdate, crank, route, state } = input;
    const paymentUpdate = input.paymentUpdate ?? new Uint8Array();
    const { config, now, paymentToken, user, userConfig } = state;
    const pull = getSweepPull(state);
    const margin = input.boundaryMarginSeconds ?? SWEEP_BOUNDARY_MARGIN_SECONDS;
    if (secondsToNextSweepBoundary(state) < margin) {
        throw new Error(`A boundary that changes the pull is less than ${margin} s away; build after it`);
    }
    if (route.programAddress !== config.router) throw new LateriteCheckError(LATERITE_ERROR__INVALID_ROUTER);
    const token = config.paymentTokens[paymentToken]!;
    const asset = config.assets[userConfig.asset];
    if (!asset) throw new LateriteCheckError(LATERITE_ERROR__UNKNOWN_ASSET);
    const assetQuote = quote(assetUpdate, asset.pythFeedId, now);
    const paymentQuote = quote(paymentUpdate, token.usdFeedId, now);
    const minimum = minOut(pullTotal(pull), paymentQuote, USD_DECIMALS, assetQuote, asset.decimals);

    const [swapAuthority] = await findSwapAuthorityPda();
    const [
        [userConfigAddress],
        plan,
        subscription,
        subscriptionAuthority,
        [userPaymentAccount],
        [swapPaymentAccount],
        [userAssetAccount],
        [eventAuthority],
    ] = await Promise.all([
        findUserConfigPda({ user }),
        findPlanAddress(paymentToken, userConfig.tier),
        findSubscriptionAddress(user, paymentToken, userConfig.tier),
        findSubscriptionAuthorityAddress(user, token.mint),
        findAssociatedTokenPda({ mint: token.mint, owner: user, tokenProgram: token.tokenProgram }),
        findAssociatedTokenPda({ mint: token.mint, owner: swapAuthority, tokenProgram: token.tokenProgram }),
        findAssociatedTokenPda({ mint: asset.mint, owner: user, tokenProgram: asset.tokenProgram }),
        findEventAuthorityPda(),
    ]);
    const sweep = getSweepInstruction({
        assetMessage: assetUpdate,
        crank,
        ed25519Index: 0,
        eventAuthority,
        paymentMessage: paymentUpdate,
        paymentMint: token.mint,
        paymentToken,
        paymentTokenProgram: token.tokenProgram,
        plan,
        program: LATERITE_PROGRAM_ADDRESS,
        pythStorage: PYTH_STORAGE_ADDRESS,
        pythTreasury: input.pythTreasury,
        route: route.data ?? new Uint8Array(),
        router: config.router,
        subscription,
        subscriptionAuthority,
        swapPaymentAccount,
        userAssetAccount,
        userConfig: userConfigAddress,
        userPaymentAccount,
    });
    const routeAccounts = (route.accounts ?? []).map(meta => ({ ...meta, role: downgradeRoleToNonSigner(meta.role) }));
    const updates = [{ instructionIndex: 1, message: assetUpdate, offset: 12 }];
    if (paymentUpdate.length > 0) {
        updates.push({ instructionIndex: 1, message: paymentUpdate, offset: 16 + assetUpdate.length });
    }
    const instructions: [Instruction, Instruction] = [
        getPythEd25519Instruction(updates),
        { ...sweep, accounts: [...sweep.accounts, ...routeAccounts] },
    ];
    const size = getTransactionMessageSize(createSweepTransactionMessage({ crank, instructions }));
    return { instructions, minOut: minimum, pull, size };
}

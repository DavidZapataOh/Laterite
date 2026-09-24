import {
    type Config,
    createSweepTransactionMessage,
    fetchSweepState,
    findSwapAuthorityPda,
    findSweptEvent,
    getSweepInstructions,
    getSweepPull,
    LATERITE_PROGRAM_ADDRESS,
    PYTH_PRO_PROGRAM_ADDRESS,
    pullTotal,
} from '@laterite/client';
import {
    buildJupiterSweepRoute,
    type SwapAuthorityAccount,
    SwapAuthorityAccountsRequiredError,
} from '@laterite/client/node';
import {
    type Address,
    fetchEncodedAccounts,
    type Instruction,
    isWritableRole,
    type TransactionSigner,
} from '@solana/kit';
import {
    findAssociatedTokenPda,
    getCreateAssociatedTokenIdempotentInstructionAsync,
    TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';

import type { ForkKeys } from './deployment';
import { alignClock, cheatcodes, invocations, type Landed, logBytes, rpc, send } from './fork';
import { CLASSIC_DEXES, jupiter } from './jupiter';
import { priceUpdates } from './prices';
import { fetchForkConfig } from './users';

/** A route for exactly `amount` into the user's asset account, and the swap-authority accounts created for it. */
export type RouteSource = (input: {
    amount: bigint;
    assetMint: Address;
    paymentMint: Address;
    swapAuthority: Address;
    userAssetAccount: Address;
}) => Promise<{ created?: SwapAuthorityAccount[]; outAmount: bigint; route: Instruction }>;

/**
 * Jupiter's route, only through `dexes` when given, built and checked by the builders' `buildJupiterSweepRoute`. The
 * swap-authority accounts a route needs in an intermediate mint the deployment did not create are created by the
 * crank in a transaction of their own, as the crank does on mainnet (each mint's owner must be the token program the
 * builder named), and the route is built again.
 */
export const jupiterRoute =
    (crank: TransactionSigner, dexes?: string[]): RouteSource =>
    async input => {
        const build = () => buildJupiterSweepRoute({ ...input, ...jupiter, crank: crank.address, dexes, rpc });
        try {
            return await build();
        } catch (error) {
            if (!(error instanceof SwapAuthorityAccountsRequiredError)) throw error;
            const mints = await fetchEncodedAccounts(
                rpc,
                error.accounts.map(({ mint }) => mint),
            );
            for (const [index, { mint, tokenProgram }] of error.accounts.entries()) {
                const account = mints[index]!;
                if (!account.exists || account.programAddress !== tokenProgram) {
                    throw new Error(`${mint} is not a mint of ${tokenProgram}`);
                }
            }
            await send(
                crank,
                await Promise.all(
                    error.accounts.map(({ mint, tokenProgram }) =>
                        getCreateAssociatedTokenIdempotentInstructionAsync({
                            mint,
                            owner: input.swapAuthority,
                            payer: crank,
                            tokenProgram,
                        }),
                    ),
                ),
            );
            return { ...(await build()), created: error.accounts };
        }
    };

/** A sweep of `user`'s `paymentToken` built as the crank builds it, not yet sent. */
export async function prepareSweep(
    keys: ForkKeys,
    user: Address,
    paymentToken: number,
    source?: RouteSource,
    { freshVenues = true }: { freshVenues?: boolean } = {},
) {
    const config = await fetchForkConfig();
    const token = config.paymentTokens[paymentToken]!;
    const { userConfig } = await fetchSweepState(rpc, { config, paymentToken, user });
    const asset = config.assets[userConfig.asset]!;
    const [[swapAuthority], [userAssetAccount]] = await Promise.all([
        findSwapAuthorityPda(),
        findAssociatedTokenPda({ mint: asset.mint, owner: user, tokenProgram: asset.tokenProgram }),
    ]);
    const { pull } = await currentState(config, user, paymentToken);
    const {
        created = [],
        outAmount,
        route,
    } = await (source ?? jupiterRoute(keys.authority, CLASSIC_DEXES))({
        amount: pullTotal(pull),
        assetMint: asset.mint,
        paymentMint: token.mint,
        swapAuthority,
        userAssetAccount,
    });
    if (freshVenues) await refetchVenueAccounts(route, userAssetAccount);
    // The prices and the state are read after the route, right before sending, as a crank builds: a route can take
    // Jupiter's rate limit and an account's creation, and an update must still be fresh when the sweep lands.
    const updates = await priceUpdates(asset.pythFeedId, token.usdFeedId);
    const { state, pull: now } = await currentState(config, user, paymentToken);
    if (pullTotal(now) !== pullTotal(pull)) throw new Error('The pull changed while the route was built');
    const sweep = await getSweepInstructions({
        assetUpdate: updates.asset,
        crank: keys.authority,
        paymentUpdate: updates.payment,
        pythTreasury: updates.treasury,
        route,
        state,
    });
    return {
        ...sweep,
        clockDrift: updates.clockDrift,
        created,
        message: createSweepTransactionMessage({ crank: keys.authority, instructions: sweep.instructions }),
        outAmount,
        route,
        treasury: updates.treasury,
        userAssetAccount,
    };
}

/**
 * Drops the fork's copy of every account the route writes but the swap authority's and the user's, so the fork reads
 * the venues' state from mainnet again: Jupiter quotes mainnet, and a pool the fork cloned earlier in a run has moved
 * there since (a stale Raydium CLMM pool fails the route with its own error).
 */
async function refetchVenueAccounts(route: Instruction, userAssetAccount: Address) {
    const own = new Set([...(await swapAuthorityTokenAccounts()).keys(), userAssetAccount]);
    const venues = (route.accounts ?? [])
        .filter(meta => isWritableRole(meta.role) && !own.has(meta.address))
        .map(meta => meta.address);
    for (const address of new Set(venues)) await cheatcodes.resetAccount(address).send();
}

/** The sweep's state and pull at the fork's clock, aligned to wall time first. */
async function currentState(config: Config, user: Address, paymentToken: number) {
    await alignClock();
    const state = await fetchSweepState(rpc, { config, paymentToken, user });
    return { pull: getSweepPull(state), state };
}

export type PreparedSweep = Awaited<ReturnType<typeof prepareSweep>>;

/** Every token account the swap authority holds under both token programs, by address, with its data. */
export async function swapAuthorityTokenAccounts(): Promise<Map<Address, string>> {
    const [swapAuthority] = await findSwapAuthorityPda();
    const accounts = new Map<Address, string>();
    for (const programId of [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]) {
        const { value } = await rpc
            .getTokenAccountsByOwner(swapAuthority, { programId }, { commitment: 'confirmed', encoding: 'base64' })
            .send();
        for (const { account, pubkey } of value) accounts.set(pubkey, account.data[0]);
    }
    return accounts;
}

/** What a sweep's route and transaction measure, from the built route and the landed (or simulated) logs. */
export async function measureSweep(prepared: PreparedSweep, logs: readonly string[]) {
    const [swapAuthority] = await findSwapAuthorityPda();
    const held = await swapAuthorityTokenAccounts();
    const writable = (prepared.route.accounts ?? []).filter(meta => isWritableRole(meta.role));
    const called = invocations(logs);
    const laterite = called.find(({ depth, program }) => depth === 1 && program === LATERITE_PROGRAM_ADDRESS);
    const children = called.filter(({ depth }) => depth === 2).reduce((total, { units }) => total + units, 0);
    return {
        laterite: laterite && laterite.units - children,
        logBytes: logBytes(logs),
        pythUnits: called.filter(({ program }) => program === PYTH_PRO_PROGRAM_ADDRESS).map(({ units }) => units),
        routeAccounts: new Set((prepared.route.accounts ?? []).map(({ address }) => address)).size,
        routeData: prepared.route.data?.length ?? 0,
        swapAuthorityAccounts: new Set(writable.map(({ address }) => address).filter(address => held.has(address)))
            .size,
        swapAuthorityIsOnlySigner: (prepared.route.accounts ?? [])
            .filter(meta => meta.role >= 2)
            .every(({ address }) => address === swapAuthority),
    };
}

/** The `Swept` event of a landed sweep, read from its inner instructions. */
export const sweptEvent = (landed: Landed) => findSweptEvent(landed.inner);

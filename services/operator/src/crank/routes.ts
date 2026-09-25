import { setTimeout as sleep } from 'node:timers/promises';

import {
    buildJupiterSweepRoute,
    type SwapAuthorityAccount,
    SwapAuthorityAccountsRequiredError,
} from '@laterite/client/node';
import { type Database, swapAccountCreations } from '@laterite/db';
import { type DevnetAddresses, expectedAmountOut, POOL_FEES, poolReserves, routeInstruction } from '@laterite/devnet';
import {
    type Address,
    fetchEncodedAccounts,
    type GetAccountInfoApi,
    type GetMultipleAccountsApi,
    type GetTokenAccountBalanceApi,
    type Instruction,
    type Rpc,
} from '@solana/kit';
import { getCreateAssociatedTokenIdempotentInstructionAsync } from '@solana-program/token';
import { gt } from 'drizzle-orm';

import { THRESHOLDS } from '../alarms/checks';
import type { Logger } from '../log';
import type { Sender } from '../send';

/** A token by its mint and program, as `Config`'s tables list them. */
type TokenMint = { mint: Address; tokenProgram: Address };

/** What a sweep's route must do: swap exactly `amount` of the payment token into the user's asset account. */
export type RouteRequest = {
    amount: bigint;
    asset: TokenMint;
    /** Venues that failed this token's sweep today. */
    excludeVenues: readonly string[];
    payment: TokenMint;
    swapAuthority: Address;
    userAssetAccount: Address;
};

/** A route for the sweep and what it quotes: the asset it expects to deliver and the venues it passes through. */
export type Route = { instruction: Instruction; quoted: bigint; venues: string[] };

/** Where a cluster's sweeps swap: `Config.router`'s routes. */
export type Routes = (request: RouteRequest) => Promise<Route>;

/** Every route a request allows was excluded or refused: the token waits for a later run. */
export class NoRouteError extends Error {
    constructor(reason: string) {
        super(`No route: ${reason}`);
        this.name = 'NoRouteError';
    }
}

/** The day's bound on new swap-authority accounts would be passed: routes that need one wait for an operator. */
export class SwapAccountBoundError extends Error {
    constructor(readonly created: number) {
        super(
            `The crank created ${created} swap-authority accounts in 24 hours; a route needing more waits for an operator`,
        );
        this.name = 'SwapAccountBoundError';
    }
}

/**
 * Devnet's routes: our CPMM pool of the asset and the payment token, with no minimum of its own (the program enforces
 * `min_out`), quoting the pool's constant-product output after its fee at the reserves read now.
 */
export function cpmmRoutes(
    rpc: Rpc<GetAccountInfoApi & GetTokenAccountBalanceApi>,
    addresses: Pick<DevnetAddresses, 'cpmm' | 'pools' | 'tokens'>,
): Routes {
    return async ({ amount, asset, excludeVenues, payment, swapAuthority, userAssetAccount }) => {
        const pool = Object.entries(addresses.pools).find(
            ([, { base, quote }]) =>
                addresses.tokens[base].mint === asset.mint && addresses.tokens[quote].mint === payment.mint,
        );
        if (!pool) throw new NoRouteError(`no devnet pool swaps ${payment.mint} into ${asset.mint}`);
        const [name, info] = pool;
        if (excludeVenues.includes(name)) throw new NoRouteError(`${name} failed today`);
        const [instruction, reserves] = await Promise.all([
            routeInstruction({
                amountIn: amount,
                ammConfig: addresses.cpmm.ammConfig,
                authority: swapAuthority,
                destination: userAssetAccount,
                pool: info,
                tokens: addresses.tokens,
            }),
            poolReserves(rpc, info, addresses.tokens),
        ]);
        return {
            instruction,
            quoted: expectedAmountOut(reserves.quote, reserves.base, amount, POOL_FEES),
            venues: [name],
        };
    };
}

/** Jupiter's rate limits: a free key allows a request a second, keyless access one every two (with a margin). */
export const JUPITER_REQUEST_INTERVAL_MS = { keyed: 1_100, keyless: 2_100 };

/**
 * A `fetch` that keeps requests at least `intervalMs` apart and waits out a 429, doubling the spacing, so the crank
 * stays within Jupiter's rate limit however many sweeps are due; `requests()` counts what it sent.
 */
export function rateLimitedFetch(intervalMs: number, fetch = globalThis.fetch) {
    // Requests take turns; each waits the spacing from when the previous one actually left, so a late wake-up never
    // brings the next one closer than the limit.
    let turn: Promise<void> = Promise.resolve();
    let sentAt = -Infinity;
    let spacing = 0;
    let requests = 0;
    const leave = (attempt: number) => {
        const left = turn.then(async () => {
            const wait = sentAt + spacing - Date.now();
            if (wait > 0) await sleep(wait);
            sentAt = Date.now();
            spacing = intervalMs * 2 ** attempt;
        });
        turn = left;
        return left;
    };
    const limited = (async (url: string, init?: RequestInit) => {
        for (let attempt = 0; ; attempt++) {
            await leave(attempt);
            requests += 1;
            const response = await fetch(url, init);
            if (response.status !== 429 || attempt === 5) return response;
        }
    }) as typeof globalThis.fetch;
    return Object.assign(limited, { requests: () => requests });
}

/** Pools whose state lives wholly in their accounts, which the crank falls back on when a route cannot be used. */
export const CLASSIC_VENUES = ['Raydium CLMM', 'Whirlpool'];
/** How old Jupiter's view of the route's state may be when the sweep is built. */
export const MAX_ROUTE_AGE_SECONDS = 10;
/** Routes built for one sweep before the token waits for a later run. */
const ROUTE_ATTEMPTS = 4;

/**
 * Jupiter's routes (`buildJupiterSweepRoute`: at most 40 accounts, every venue unless one failed), rebuilt when
 * Jupiter's view of their state is older than {@link MAX_ROUTE_AGE_SECONDS}, and restricted to classic pools when the
 * builder refuses a route (one naming the crank, or needing another setup). The swap-authority accounts a route names
 * in a mint the deployment did not cover are created by the crank, which pays their rent, in a transaction of their
 * own (the token program checked against the mint's owner), recorded in `swap_account_creations`, at most
 * `THRESHOLDS.swapAccountCreationsPerDay` in 24 hours; then the route is built again.
 */
export function jupiterRoutes(input: {
    apiKey?: string;
    db: Database;
    fetch: typeof globalThis.fetch;
    log: Logger;
    rpc: Rpc<GetMultipleAccountsApi>;
    /** The crank's sender, which pays for the accounts it creates; routes that name the crank are refused. */
    sender: Sender;
}): Routes {
    const { apiKey, db, fetch, log, rpc, sender } = input;

    async function create(accounts: SwapAuthorityAccount[], owner: Address) {
        const since = new Date(Date.now() - 86_400_000);
        const created = await db.$count(swapAccountCreations, gt(swapAccountCreations.createdAt, since));
        if (created + accounts.length > THRESHOLDS.swapAccountCreationsPerDay) throw new SwapAccountBoundError(created);
        const mints = await fetchEncodedAccounts(
            rpc,
            accounts.map(({ mint }) => mint),
        );
        accounts.forEach(({ mint, tokenProgram }, index) => {
            const account = mints[index]!;
            if (!account.exists || account.programAddress !== tokenProgram) {
                throw new Error(`${mint} is not a mint of ${tokenProgram}`);
            }
        });
        const instructions = await Promise.all(
            accounts.map(({ mint, tokenProgram }) =>
                getCreateAssociatedTokenIdempotentInstructionAsync({ mint, owner, payer: sender.payer, tokenProgram }),
            ),
        );
        const signature = await sender.send(await sender.build(instructions));
        await db
            .insert(swapAccountCreations)
            .values(accounts.map(({ address, mint, tokenProgram }) => ({ address, mint, signature, tokenProgram })))
            .onConflictDoNothing();
        log.info({ accounts: accounts.map(({ address }) => address), signature }, 'swap-authority accounts created');
    }

    return async request => {
        let dexes: string[] | undefined;
        for (let attempt = 0; attempt < ROUTE_ATTEMPTS; attempt++) {
            const excludeDexes = dexes
                ? undefined
                : request.excludeVenues.length > 0
                  ? [...request.excludeVenues]
                  : undefined;
            try {
                const built = await buildJupiterSweepRoute({
                    amount: request.amount,
                    apiKey,
                    assetMint: request.asset.mint,
                    crank: sender.payer.address,
                    dexes,
                    excludeDexes,
                    fetch,
                    paymentMint: request.payment.mint,
                    rpc,
                    swapAuthority: request.swapAuthority,
                    userAssetAccount: request.userAssetAccount,
                });
                if (built.quotedAt !== null && Date.now() / 1_000 - built.quotedAt > MAX_ROUTE_AGE_SECONDS) continue;
                return { instruction: built.route, quoted: built.outAmount, venues: built.venues };
            } catch (error) {
                if (error instanceof SwapAuthorityAccountsRequiredError) {
                    await create(error.accounts, request.swapAuthority);
                    continue;
                }
                // The builder refused the route itself: ask again through classic pools only.
                if (!dexes && error instanceof Error && /names the crank|another setup/.test(error.message)) {
                    log.warn({ err: error }, 'route refused; asking for classic pools only');
                    dexes = CLASSIC_VENUES.filter(venue => !request.excludeVenues.includes(venue));
                    continue;
                }
                throw error;
            }
        }
        throw new NoRouteError(`no fresh, usable Jupiter route in ${ROUTE_ATTEMPTS} requests`);
    };
}

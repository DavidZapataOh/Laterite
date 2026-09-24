import {
    fetchUserConfig,
    findSwapAuthorityPda,
    findUserConfigPda,
    LATERITE_ERROR__SLIPPAGE_EXCEEDED,
} from '@laterite/client';
import { buildJupiterSwap, getJupiterSweepRoute, type JupiterSwap } from '@laterite/client/node';
import { MAINNET_MINTS } from '@laterite/devnet';
import {
    type Address,
    appendTransactionMessageInstructions,
    compressTransactionMessageUsingAddressLookupTables,
    createTransactionMessage,
    generateKeyPairSigner,
    isWritableRole,
    pipe,
    setTransactionMessageFeePayerSigner,
} from '@solana/kit';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { describe, expect, it } from 'vitest';

import { forkContext } from './src/deployment';
import {
    airdrop,
    cheatcodes,
    DOLLAR,
    failure,
    fundToken,
    invocations,
    lateriteError,
    rpc,
    sendMessage,
    sendUnchecked,
    simulateMessage,
} from './src/fork';
import { jupiter } from './src/jupiter';
import { report } from './src/report';
import { jupiterRoute, prepareSweep, type RouteSource } from './src/sweep';
import { enroll, enrollParams } from './src/users';

// Whirlpool's SPYx pools are shallow: a few trades of this size move them past the program's bound, each within a
// transaction's compute limit.
const DEXES = ['Whirlpool'];
const WHALE_TRADE = 10_000n * DOLLAR;
const WHALE_TRADES = 12;
type RoutePlan = { percent: number; swapInfo: { ammKey: string; inputMint: string; outputMint: string } }[];
const plan = (swap: JupiterSwap) => (swap.response as unknown as { routePlan: RoutePlan }).routePlan;
const pools = (swap: JupiterSwap) => plan(swap).map(({ swapInfo }) => swapInfo.ammKey);
/**
 * The pool that takes the largest share of a route's USDC straight into SPYx: moving it moves the fill. A hop's
 * `percent` is its share of its own input, so only the direct hops' shares compare.
 */
const mainPool = (swap: JupiterSwap) =>
    plan(swap)
        .filter(
            ({ swapInfo }) => swapInfo.inputMint === MAINNET_MINTS.USDC && swapInfo.outputMint === MAINNET_MINTS.SPYx,
        )
        .reduce((main, hop) => (hop.percent > main.percent ? hop : main)).swapInfo.ammKey;

describe('a manipulated pool', () => {
    it("reverts the sweep at the oracle's minimum when a route's own bound would let it through", async () => {
        const fork = await forkContext();
        const { user } = await enroll(fork, enrollParams({ asset: 0, paymentTokens: 1 }));
        const [swapAuthority] = await findSwapAuthorityPda();

        // The caller picks the route: here one whose own slippage bound is 50%, through the pools it is about to move,
        // quoted once, before the move; each attempt below rebuilds the sweep around it with fresh prices.
        let hostile: JupiterSwap | undefined;
        const source: RouteSource = async input => {
            if (hostile) return { outAmount: hostile.outAmount, route: getJupiterSweepRoute(hostile, input) };
            // The honest route through the same pools first, which creates any intermediate account they need.
            await jupiterRoute(fork.keys.authority, DEXES)(input);
            hostile = await buildJupiterSwap({
                ...input,
                ...jupiter,
                destinationTokenAccount: input.userAssetAccount,
                dexes: DEXES,
                inputMint: input.paymentMint,
                maxAccounts: 40,
                outputMint: input.assetMint,
                slippageBps: 5_000,
                taker: swapAuthority,
            });
            return { outAmount: hostile.outAmount, route: getJupiterSweepRoute(hostile, input) };
        };
        // The venues are read from mainnet again only for the first build: later ones must see the whale's trades.
        let freshVenues = true;
        const sweep = async () => {
            const prepared = await prepareSweep(fork.keys, user.address, 0, source, { freshVenues });
            freshVenues = false;
            return prepared;
        };

        // A whale buys SPYx with USDC through the same pools, pushing SPYx's price up on the fork.
        const whale = await generateKeyPairSigner();
        await airdrop(whale.address, 1n);
        await fundToken(whale.address, MAINNET_MINTS.USDC, WHALE_TRADE * BigInt(WHALE_TRADES), TOKEN_PROGRAM_ADDRESS);
        let refused = await simulateMessage((await sweep()).message);
        expect(failure(refused)).toBeUndefined();
        let bought = 0n;
        const moved = new Set<Address>();
        // Jupiter quotes mainnet, where the pools have not moved, so each trade takes the same pools; one that does
        // not pass through the pool delivering most of the sweep's output is not sent.
        for (let trades = 0; trades < WHALE_TRADES && refused.err === null; trades++) {
            const trade = await buildJupiterSwap({
                ...jupiter,
                amount: WHALE_TRADE,
                dexes: DEXES,
                inputMint: MAINNET_MINTS.USDC,
                maxAccounts: 40,
                outputMint: MAINNET_MINTS.SPYx,
                payer: whale.address,
                slippageBps: 5_000,
                taker: whale.address,
            });
            if (!pools(trade).includes(mainPool(hostile!))) continue;
            await sendMessage(
                compressTransactionMessageUsingAddressLookupTables(
                    pipe(
                        createTransactionMessage({ version: 0 }),
                        m => setTransactionMessageFeePayerSigner(whale, m),
                        m => appendTransactionMessageInstructions(trade.instructions, m),
                    ),
                    trade.lookupTables,
                ),
            );
            bought += WHALE_TRADE;
            for (const { address, role } of trade.swap.accounts ?? []) if (isWritableRole(role)) moved.add(address);
            refused = await simulateMessage((await sweep()).message);
        }

        // The route still clears Jupiter's 50% bound; the program's Pyth-derived minimum refuses it, in simulation and
        // on the fork's record, where the failed sweep spends no day and moves no funds.
        expect(lateriteError(refused)).toBe(LATERITE_ERROR__SLIPPAGE_EXCEEDED);
        const last = await sweep();
        const reverted = await sendUnchecked(last.message);
        expect(lateriteError(reverted)).toBe(LATERITE_ERROR__SLIPPAGE_EXCEEDED);
        const { data } = await fetchUserConfig(rpc, (await findUserConfigPda({ user: user.address }))[0]);
        expect(data.lastSweepDay[0]).toBe(0);
        report('trace', [
            {
                sweep: 'USDC into SPYx through a manipulated pool (reverted)',
                signature: reverted.signature,
                bytes: reverted.size,
                units: reverted.units,
                error: lateriteError(reverted),
                invocations: invocations(reverted.logs),
                logs: reverted.logs,
            },
        ]);

        // Back to mainnet's state, the pools let the same sweep through, and later tests find them unmoved.
        for (const account of moved) await cheatcodes.resetAccount(account).send();
        expect((await simulateMessage((await sweep()).message)).err).toBeNull();
        report('manipulated-pool', [
            {
                whaleUsdc: bought / DOLLAR,
                routePools: pools(hostile!).join(' '),
                mainPool: mainPool(hostile!),
                routeQuote: hostile!.outAmount,
                minOut: last.minOut,
                refused: lateriteError(refused),
                revertedSignature: reverted.signature,
            },
        ]);
    });
});

import {
    LATERITE_ERROR__ALREADY_SWEPT,
    LATERITE_ERROR__INVALID_PRICE_UPDATE,
    LATERITE_ERROR__INVALID_ROUTER,
    LATERITE_ERROR__INVALID_TOKEN_ACCOUNT,
    LATERITE_ERROR__NOTHING_TO_SWEEP,
    LATERITE_ERROR__PRICE_UNAVAILABLE,
    LATERITE_ERROR__PRICE_UNCERTAIN,
    LATERITE_ERROR__PROGRAM_PAUSED,
    LATERITE_ERROR__SLIPPAGE_EXCEEDED,
    LATERITE_ERROR__STALE_PRICE,
    LATERITE_ERROR__SUBSCRIPTION_MISMATCH,
    LATERITE_ERROR__SWAP_ACCOUNT_CHANGED,
    LATERITE_PROGRAM_ADDRESS,
    PYTH_PRO_PROGRAM_ADDRESS,
} from '@laterite/client';
import { JUPITER_PROGRAM_ADDRESS } from '@laterite/client/node';
import { addresses as devnet } from '@laterite/devnet/addresses';
import { type Address, getSolanaErrorFromTransactionError } from '@solana/kit';
import { SUBSCRIPTIONS_PROGRAM_ADDRESS } from '@solana/subscriptions';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { describe, expect, it } from 'vitest';

import { failingInvocation, sweepFailure } from '../src/crank/failures';

/** A failed transaction as Kit reads it: the instruction error at `index`, and the runtime's logs. */
const failed = (index: number, code: number | undefined) =>
    getSolanaErrorFromTransactionError({
        InstructionError: [index, code === undefined ? 'InvalidAccountData' : { Custom: code }],
    } as never);

/** The logs of a sweep whose innermost failure is `failing`, called along `path` (outermost first). */
function logs(path: Address[]): string[] {
    const lines = path.map((program, depth) => `Program ${program} invoke [${depth + 1}]`);
    return [...lines, `Program ${path.at(-1)} failed: custom program error`];
}

describe('what a failed sweep means', () => {
    const router = devnet.cpmm.program;
    const sweep = [LATERITE_PROGRAM_ADDRESS];
    const inPull = [LATERITE_PROGRAM_ADDRESS, SUBSCRIPTIONS_PROGRAM_ADDRESS];
    const inRoute = [LATERITE_PROGRAM_ADDRESS, router];

    it("follows the outcome table for the program's own errors", () => {
        const action = (code: number) => sweepFailure(failed(1, code), logs(sweep), router);
        expect(action(LATERITE_ERROR__SWAP_ACCOUNT_CHANGED)).toMatchObject({
            action: 'rebuild',
            reason: 'SwapAccountChanged',
        });
        expect(action(LATERITE_ERROR__STALE_PRICE)).toMatchObject({ action: 'price', reason: 'StalePrice' });
        expect(action(LATERITE_ERROR__PRICE_UNCERTAIN)).toMatchObject({ action: 'price', reason: 'PriceUncertain' });
        expect(action(LATERITE_ERROR__SLIPPAGE_EXCEEDED)).toMatchObject({ action: 'slippage' });
        expect(action(LATERITE_ERROR__ALREADY_SWEPT)).toMatchObject({ action: 'swept', reason: 'AlreadySwept' });
        expect(action(LATERITE_ERROR__NOTHING_TO_SWEEP)).toMatchObject({ action: 'recompute' });
        for (const code of [
            LATERITE_ERROR__PROGRAM_PAUSED,
            LATERITE_ERROR__INVALID_ROUTER,
            LATERITE_ERROR__SUBSCRIPTION_MISMATCH,
        ]) {
            expect(action(code).action).toBe('refetch');
        }
        expect(action(LATERITE_ERROR__INVALID_TOKEN_ACCOUNT)).toMatchObject({ action: 'pull' });
        expect(action(LATERITE_ERROR__PRICE_UNAVAILABLE)).toMatchObject({ action: 'alert' });
        expect(action(LATERITE_ERROR__INVALID_PRICE_UPDATE)).toMatchObject({ action: 'alert' });
    });

    it('reads the pull, the route, Pyth Pro and the precompile by the program that failed first', () => {
        const at = (code: number | undefined, path: Address[]) => sweepFailure(failed(1, code), logs(path), router);
        // Subscriptions' revoked authority (103) and cancelled subscription (508) are pull failures; its period cap an alert.
        expect(at(103, inPull)).toMatchObject({ action: 'pull', reason: 'Subscriptions 103' });
        expect(at(508, inPull)).toMatchObject({ action: 'pull', reason: 'Subscriptions 508' });
        expect(at(400, inPull)).toMatchObject({ action: 'alert', reason: 'Subscriptions 400' });
        // An SPL error on the user's account inside the pull; an insufficient-funds error inside the route.
        expect(at(4, [...inPull, TOKEN_PROGRAM_ADDRESS])).toMatchObject({ action: 'pull', reason: 'token 4' });
        expect(at(1, [...inRoute, TOKEN_PROGRAM_ADDRESS])).toMatchObject({ action: 'rebuild', reason: 'token 1' });
        // A venue's 6024 is not Laterite's PriceUncertain.
        expect(at(6_024, inRoute)).toMatchObject({ action: 'venue', program: router });
        const jupiter = [LATERITE_PROGRAM_ADDRESS, JUPITER_PROGRAM_ADDRESS];
        expect(sweepFailure(failed(1, 6_001), logs(jupiter), JUPITER_PROGRAM_ADDRESS)).toMatchObject({
            action: 'slippage',
            reason: 'Jupiter SlippageToleranceExceeded',
        });
        expect(at(2, [LATERITE_PROGRAM_ADDRESS, PYTH_PRO_PROGRAM_ADDRESS])).toMatchObject({ action: 'alert' });
        expect(sweepFailure(failed(0, 2), [], router)).toMatchObject({ action: 'alert', reason: 'ed25519 2' });
        expect(sweepFailure(failed(1, undefined), [], router)).toMatchObject({ action: 'unknown' });
    });

    it('finds the innermost failing program under nested calls that succeeded', () => {
        const nested = [
            `Program ${LATERITE_PROGRAM_ADDRESS} invoke [1]`,
            `Program ${SUBSCRIPTIONS_PROGRAM_ADDRESS} invoke [2]`,
            `Program ${TOKEN_PROGRAM_ADDRESS} invoke [3]`,
            `Program ${TOKEN_PROGRAM_ADDRESS} success`,
            `Program ${SUBSCRIPTIONS_PROGRAM_ADDRESS} success`,
            `Program ${router} invoke [2]`,
            `Program ${TOKEN_PROGRAM_ADDRESS} invoke [3]`,
            `Program ${TOKEN_PROGRAM_ADDRESS} failed: insufficient funds`,
            `Program ${router} failed: insufficient funds`,
            `Program ${LATERITE_PROGRAM_ADDRESS} failed: insufficient funds`,
        ];
        expect(failingInvocation(nested)).toEqual([LATERITE_PROGRAM_ADDRESS, router, TOKEN_PROGRAM_ADDRESS]);
    });
});

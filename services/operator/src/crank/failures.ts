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
    type LateriteError,
    PYTH_PRO_PROGRAM_ADDRESS,
} from '@laterite/client';
import { JUPITER_PROGRAM_ADDRESS } from '@laterite/client/node';
import { type Address, isSolanaError, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM, type SolanaError } from '@solana/kit';
import { SUBSCRIPTIONS_ERROR__AMOUNT_EXCEEDS_PERIOD_LIMIT, SUBSCRIPTIONS_PROGRAM_ADDRESS } from '@solana/subscriptions';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';

/** The program's errors the crank acts on, by the program's names for them. */
export const LATERITE_ERROR_NAMES = new Map<LateriteError, string>([
    [LATERITE_ERROR__ALREADY_SWEPT, 'AlreadySwept'],
    [LATERITE_ERROR__INVALID_PRICE_UPDATE, 'InvalidPriceUpdate'],
    [LATERITE_ERROR__INVALID_ROUTER, 'InvalidRouter'],
    [LATERITE_ERROR__INVALID_TOKEN_ACCOUNT, 'InvalidTokenAccount'],
    [LATERITE_ERROR__NOTHING_TO_SWEEP, 'NothingToSweep'],
    [LATERITE_ERROR__PRICE_UNAVAILABLE, 'PriceUnavailable'],
    [LATERITE_ERROR__PRICE_UNCERTAIN, 'PriceUncertain'],
    [LATERITE_ERROR__PROGRAM_PAUSED, 'ProgramPaused'],
    [LATERITE_ERROR__SLIPPAGE_EXCEEDED, 'SlippageExceeded'],
    [LATERITE_ERROR__STALE_PRICE, 'StalePrice'],
    [LATERITE_ERROR__SUBSCRIPTION_MISMATCH, 'SubscriptionMismatch'],
    [LATERITE_ERROR__SWAP_ACCOUNT_CHANGED, 'SwapAccountChanged'],
]);

/** The name of a Laterite error, or its code when the crank has no action of its own for it. */
export const lateriteErrorName = (code: number) =>
    LATERITE_ERROR_NAMES.get(code as LateriteError) ?? `Laterite ${code}`;

/** Jupiter's `SlippageToleranceExceeded`: the route fell below Jupiter's own bound, the quote less the slippage. */
const JUPITER_SLIPPAGE_TOLERANCE_EXCEEDED = 6_001;
/** The token programs' `InsufficientFunds`. */
const TOKEN_INSUFFICIENT_FUNDS = 1;
const TOKEN_PROGRAMS: readonly Address[] = [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS];

/**
 * What the crank does after a failed sweep, as the outcome table decides it:
 * - `rebuild`: the pull changed after building (`SwapAccountChanged`, or the route short of funds): read the state and
 *   build once more;
 * - `price`: `StalePrice` or `PriceUncertain`: retry with a fresh update later in the day, then skip;
 * - `slippage`: the route fell below `min_out` or Jupiter's own bound: retry with a fresh route (a re-peg first on
 *   devnet), then skip;
 * - `swept`: `AlreadySwept`, final for the day (someone swept it first);
 * - `recompute`: `NothingToSweep`, which spends no day: read the state again before anything is resent;
 * - `refetch`: `ProgramPaused`, `InvalidRouter` or `SubscriptionMismatch`: read `Config` and the user again, build once;
 * - `pull`: the pull from the user failed (Subscriptions' revoked authority or cancelled subscription, an SPL error on
 *   the user's account, `InvalidTokenAccount`): tolerated and notified, never retried the same day;
 * - `alert`: a failure the local checks should have caught (the price updates, Subscriptions' period cap, Pyth Pro):
 *   a builder or relay bug;
 * - `venue`: a venue of the route failed: build a route without it;
 * - `unknown`: anything else, retried later.
 */
export type FailureAction =
    'alert' | 'price' | 'pull' | 'rebuild' | 'recompute' | 'refetch' | 'slippage' | 'swept' | 'unknown' | 'venue';

export type SweepFailure = { action: FailureAction; program?: Address; reason: string };

/**
 * The programs invoked at the first failure in `logs`, outermost first: the last one is the program that failed, the
 * others the ones that called it.
 */
export function failingInvocation(logs: readonly string[]): Address[] {
    const stack: Address[] = [];
    for (const line of logs) {
        const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(line);
        if (invoke) {
            stack.push(invoke[1] as Address);
            continue;
        }
        const failed = /^Program (\w+) failed/.exec(line);
        if (failed && stack.at(-1) === failed[1]) return stack;
        if (/^Program \w+ success$/.test(line)) stack.pop();
    }
    return stack;
}

/**
 * The failed instruction's index and custom error code in a transaction error, as Kit reads it along the cause chain
 * (`InstructionError`, `Custom`).
 */
export function instructionError(error: unknown): { code?: number; index?: number } {
    for (let cause = error; cause; cause = (cause as { cause?: unknown }).cause) {
        if (isSolanaError(cause, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) {
            const { code, index } = (cause as SolanaError<typeof SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM>).context;
            return { code: Number(code), index: Number(index) };
        }
        const index = isSolanaError(cause) ? (cause.context as { index?: number }).index : undefined;
        if (index !== undefined) return { index: Number(index) };
    }
    return {};
}

/**
 * Reads a failed sweep from its error and logs: the program that failed first (the innermost, as a venue's error codes
 * overlap Laterite's) and its code, and what the crank does about it. `router` is `Config.router`.
 */
export function sweepFailure(error: unknown, logs: readonly string[], router: Address): SweepFailure {
    const stack = failingInvocation(logs);
    const program = stack.at(-1);
    const { code, index } = instructionError(error);
    const inPull = stack.includes(SUBSCRIPTIONS_PROGRAM_ADDRESS);
    const inRoute = stack.includes(router);
    const named = (action: FailureAction, reason: string): SweepFailure => ({ action, program, reason });
    if (program === LATERITE_PROGRAM_ADDRESS && code !== undefined) {
        const reason = lateriteErrorName(code);
        switch (code) {
            case LATERITE_ERROR__SWAP_ACCOUNT_CHANGED:
                return named('rebuild', reason);
            case LATERITE_ERROR__STALE_PRICE:
            case LATERITE_ERROR__PRICE_UNCERTAIN:
                return named('price', reason);
            case LATERITE_ERROR__SLIPPAGE_EXCEEDED:
                return named('slippage', reason);
            case LATERITE_ERROR__ALREADY_SWEPT:
                return named('swept', reason);
            case LATERITE_ERROR__NOTHING_TO_SWEEP:
                return named('recompute', reason);
            case LATERITE_ERROR__PROGRAM_PAUSED:
            case LATERITE_ERROR__INVALID_ROUTER:
            case LATERITE_ERROR__SUBSCRIPTION_MISMATCH:
                return named('refetch', reason);
            case LATERITE_ERROR__INVALID_TOKEN_ACCOUNT:
                return named('pull', reason);
            case LATERITE_ERROR__PRICE_UNAVAILABLE:
            case LATERITE_ERROR__INVALID_PRICE_UPDATE:
                return named('alert', reason);
            default:
                return named('unknown', reason);
        }
    }
    // The pull itself failed: a revoked authority (103), a cancelled subscription (508) or any other refusal, except the
    // period cap, which the sweep's native-period bound rules out unless the builder's mirror differs from the program.
    if (program === SUBSCRIPTIONS_PROGRAM_ADDRESS) {
        const reason = `Subscriptions ${code ?? 'error'}`;
        return named(code === SUBSCRIPTIONS_ERROR__AMOUNT_EXCEEDS_PERIOD_LIMIT ? 'alert' : 'pull', reason);
    }
    if (program && TOKEN_PROGRAMS.includes(program)) {
        const reason = `token ${code ?? 'error'}`;
        if (inPull) return named('pull', reason);
        if (inRoute && code === TOKEN_INSUFFICIENT_FUNDS) return named('rebuild', reason);
        return inRoute ? named('venue', reason) : named('unknown', reason);
    }
    if (program === PYTH_PRO_PROGRAM_ADDRESS) return named('alert', `Pyth Pro ${code ?? 'error'}`);
    if (program === JUPITER_PROGRAM_ADDRESS && code === JUPITER_SLIPPAGE_TOLERANCE_EXCEEDED) {
        return named('slippage', 'Jupiter SlippageToleranceExceeded');
    }
    if (inRoute) {
        const name = program === SYSTEM_PROGRAM_ADDRESS ? 'System' : program;
        return named('venue', `${name} ${code ?? 'error'}`);
    }
    // The ed25519 precompile (the sweep's first instruction) logs nothing: its refusal is an update the local checks passed.
    if (!program && index === 0) return named('alert', `ed25519 ${code ?? 'error'}`);
    return named('unknown', program ? `${program} ${code ?? 'error'}` : String(error));
}

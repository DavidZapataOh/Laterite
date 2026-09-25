import {
    AccountRole,
    type Address,
    appendTransactionMessageInstructions,
    assertIsTransactionWithBlockhashLifetime,
    assertIsTransactionWithinSizeLimit,
    createTransactionMessage,
    estimateAndSetResourceLimitsFactory,
    estimateResourceLimitsFactory,
    fillTransactionMessageProvisoryResourceLimits,
    getSignatureFromTransaction,
    getSolanaErrorFromTransactionError,
    type GetRecentPrioritizationFeesApi,
    getTransactionSize,
    type Instruction,
    isSolanaError,
    type MicroLamports,
    pipe,
    type Rpc,
    type RpcSubscriptions,
    sendAndConfirmTransactionFactory,
    setTransactionMessageComputeUnitLimit,
    setTransactionMessageComputeUnitPrice,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    setTransactionMessageLoadedAccountsDataSizeLimit,
    setTransactionMessagePriorityFeeLamports,
    type Signature,
    signTransactionMessageWithSigners,
    type SignatureNotificationsApi,
    type SlotNotificationsApi,
    SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
    SOLANA_ERROR__TRANSACTION__FAILED_WHEN_SIMULATING_TO_ESTIMATE_RESOURCE_LIMITS,
    type SolanaRpcApi,
    type TransactionMessage,
    type TransactionMessageWithFeePayer,
    type TransactionSigner,
} from '@solana/kit';

import { type Executed, executedInstructions, fetchTransaction } from './transaction';

/** The compute-unit price the service pays, in micro-lamports: a percentile of recent fees, clamped. */
export const PRIORITY_FEE = { ceiling: 1_000_000n, floor: 1_000n, percentile: 75 };

/** The share of simulated compute units and loaded account data added to each transaction's limits. */
const LIMIT_MARGIN = 1.1;

const withMargin = (limit: number) => Math.ceil(limit * LIMIT_MARGIN);

/**
 * The compute-unit price for a transaction writing `accounts`: the given percentile of the fees paid in the recent
 * slots that wrote them (`getRecentPrioritizationFees`), within the floor and ceiling.
 */
export async function recentPriorityFee(
    rpc: Rpc<GetRecentPrioritizationFeesApi>,
    accounts: readonly Address[],
    { ceiling, floor, percentile } = PRIORITY_FEE,
): Promise<MicroLamports> {
    const fees = (await rpc.getRecentPrioritizationFees(accounts).send())
        .map(({ prioritizationFee }) => BigInt(prioritizationFee))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const fee = fees[Math.min(fees.length - 1, Math.floor((fees.length * percentile) / 100))] ?? 0n;
    return (fee < floor ? floor : fee > ceiling ? ceiling : fee) as MicroLamports;
}

/** The accounts `instructions` write, once each. */
const writableAccounts = (instructions: readonly Instruction[]) => [
    ...new Set(
        instructions.flatMap(({ accounts = [] }) =>
            accounts
                .filter(({ role }) => role === AccountRole.WRITABLE || role === AccountRole.WRITABLE_SIGNER)
                .map(({ address }) => address),
        ),
    ),
];

/** A version 1 transaction as it landed, with the limits and fee it was sent with. */
export type Landed = {
    computeUnitLimit: number;
    computeUnits: number;
    executed: Executed[];
    fee: bigint;
    loadedAccountsDataSizeLimit: number;
    logs: readonly string[];
    priorityFeeLamports: bigint;
    signature: Signature;
    size: number;
};

/** A simulation whose compute units, with the margin, exceed what the service sends: nothing was sent. */
export class ComputeLimitExceededError extends Error {
    constructor(
        readonly computeUnitLimit: number,
        readonly ceiling: number,
    ) {
        super(`The transaction needs a compute limit of ${computeUnitLimit}, above ${ceiling}`);
        this.name = 'ComputeLimitExceededError';
    }
}

/**
 * A transaction that failed: in simulation or preflight (nothing sent, no `signature`), or on-chain. `cause` is the
 * transaction's error as Kit reads it (a custom error carries the instruction's index and code) and `logs` the
 * runtime's, which name the program that failed.
 */
export class TransactionFailedError extends Error {
    constructor(
        override readonly cause: unknown,
        readonly logs: readonly string[],
        readonly signature?: Signature,
    ) {
        super(signature ? `${signature} failed` : 'The transaction failed in simulation', { cause });
        this.name = 'TransactionFailedError';
    }
}

/** A simulation or preflight failure as a {@link TransactionFailedError}, or `null` for any other error. */
function simulationFailure(error: unknown): TransactionFailedError | null {
    if (
        isSolanaError(error, SOLANA_ERROR__TRANSACTION__FAILED_WHEN_SIMULATING_TO_ESTIMATE_RESOURCE_LIMITS) ||
        isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)
    ) {
        const { logs } = error.context as { logs?: readonly string[] | null };
        return new TransactionFailedError(error.cause, logs ?? []);
    }
    return null;
}

/** Builds and sends the service's transactions, `payer` paying their fees and the rent of what they create. */
export type Sender = ReturnType<typeof createSender>;

export function createSender({
    estimate: estimator,
    payer,
    rpc,
    rpcSubscriptions,
}: {
    /** The resource-limit estimator; Kit's simulation-based one unless a cluster's simulations under-report. */
    estimate?: ReturnType<typeof estimateResourceLimitsFactory>;
    payer: TransactionSigner;
    rpc: Rpc<SolanaRpcApi>;
    rpcSubscriptions: RpcSubscriptions<SignatureNotificationsApi & SlotNotificationsApi>;
}) {
    const estimate = estimator ?? estimateResourceLimitsFactory({ rpc });
    const estimateAndSet = estimateAndSetResourceLimitsFactory((async (message, config) => {
        const limits = await estimate(message, { ...config, commitment: 'confirmed' });
        return { ...limits, computeUnitLimit: withMargin(limits.computeUnitLimit) };
    }) as typeof estimate);
    const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

    return {
        /** Pays every fee and the rent of what the transactions create. */
        payer,

        /**
         * A version 0 message of `instructions` with a provisory compute-unit limit and a price from the recent fees
         * on the accounts it writes (or `writable`); its lifetime and limit are set by {@link send}.
         */
        async build(instructions: readonly Instruction[], writable?: readonly Address[]) {
            const price = await recentPriorityFee(rpc, writable ?? writableAccounts(instructions));
            return pipe(
                createTransactionMessage({ version: 0 }),
                message => setTransactionMessageFeePayerSigner(payer, message),
                message => fillTransactionMessageProvisoryResourceLimits(message),
                message => setTransactionMessageComputeUnitPrice(price, message),
                message => appendTransactionMessageInstructions(instructions, message),
            );
        },

        /**
         * Simulates `message` against the confirmed state and throws its failure (Kit's simulation error, the
         * instruction's error as its `cause`); otherwise sets the limit to the simulated units plus 10%, signs, sends
         * and returns the signature once confirmed.
         */
        async send(message: TransactionMessage & TransactionMessageWithFeePayer): Promise<Signature> {
            const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
            const limited = await estimateAndSet(setTransactionMessageLifetimeUsingBlockhash(blockhash, message));
            const transaction = await signTransactionMessageWithSigners(limited);
            assertIsTransactionWithBlockhashLifetime(transaction);
            await sendAndConfirm(transaction, { commitment: 'confirmed' });
            return getSignatureFromTransaction(transaction);
        },

        /**
         * Sends `instructions` in a version 1 transaction with every account inline: simulated against the confirmed
         * state, its compute-unit and loaded-accounts data limits set to the simulation's plus 10%, and a priority fee
         * of the recent fees' price on the accounts it writes times that compute limit. Throws
         * {@link ComputeLimitExceededError} above `maxComputeUnitLimit` and Kit's size error past 4,096 bytes, both
         * before sending, and {@link TransactionFailedError} for a failed simulation, preflight or execution; returns
         * the transaction once confirmed, read back at that commitment.
         */
        async sendVersion1(
            instructions: readonly Instruction[],
            { maxComputeUnitLimit }: { maxComputeUnitLimit: number },
        ): Promise<Landed> {
            const price = await recentPriorityFee(rpc, writableAccounts(instructions));
            const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
            const message = pipe(
                createTransactionMessage({ version: 1 }),
                m => setTransactionMessageFeePayerSigner(payer, m),
                m => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
                m => fillTransactionMessageProvisoryResourceLimits(m),
                m => appendTransactionMessageInstructions(instructions, m),
            );
            let limits: Awaited<ReturnType<typeof estimate>>;
            try {
                limits = await estimate(message, { commitment: 'confirmed' });
            } catch (error) {
                throw simulationFailure(error) ?? error;
            }
            const computeUnitLimit = withMargin(limits.computeUnitLimit);
            if (computeUnitLimit > maxComputeUnitLimit) {
                throw new ComputeLimitExceededError(computeUnitLimit, maxComputeUnitLimit);
            }
            const loadedAccountsDataSizeLimit = withMargin(limits.loadedAccountsDataSizeLimit!);
            const priorityFeeLamports = (BigInt(price) * BigInt(computeUnitLimit) + 999_999n) / 1_000_000n;
            const transaction = await signTransactionMessageWithSigners(
                pipe(
                    message,
                    m => setTransactionMessageComputeUnitLimit(computeUnitLimit, m),
                    m => setTransactionMessageLoadedAccountsDataSizeLimit(loadedAccountsDataSizeLimit, m),
                    m => setTransactionMessagePriorityFeeLamports(priorityFeeLamports, m),
                ),
            );
            assertIsTransactionWithinSizeLimit(transaction);
            assertIsTransactionWithBlockhashLifetime(transaction);
            const signature = getSignatureFromTransaction(transaction);
            try {
                await sendAndConfirm(transaction, { commitment: 'confirmed' });
            } catch (error) {
                const failure = simulationFailure(error);
                if (failure) throw failure;
                // Executed and failed: its error and logs are on the cluster's record.
                const landed = await fetchTransaction(rpc, signature, 'confirmed').catch(() => null);
                if (landed?.meta?.err) {
                    const cause = getSolanaErrorFromTransactionError(landed.meta.err as never);
                    throw new TransactionFailedError(cause, landed.meta.logMessages ?? [], signature);
                }
                throw error;
            }
            const landed = await fetchTransaction(rpc, signature, 'confirmed');
            if (!landed?.meta) throw new Error(`${signature} was confirmed but cannot be read back`);
            return {
                computeUnitLimit,
                computeUnits: Number(landed.meta.computeUnitsConsumed ?? 0n),
                executed: executedInstructions(landed).executed,
                fee: landed.meta.fee ?? 0n,
                loadedAccountsDataSizeLimit,
                logs: landed.meta.logMessages ?? [],
                priorityFeeLamports,
                signature,
                size: getTransactionSize(transaction),
            };
        },
    };
}

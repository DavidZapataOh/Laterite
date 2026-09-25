import {
    AccountRole,
    type Address,
    appendTransactionMessageInstructions,
    assertIsTransactionWithBlockhashLifetime,
    createTransactionMessage,
    estimateAndSetResourceLimitsFactory,
    estimateResourceLimitsFactory,
    fillTransactionMessageProvisoryResourceLimits,
    getSignatureFromTransaction,
    type GetRecentPrioritizationFeesApi,
    type Instruction,
    type MicroLamports,
    pipe,
    type Rpc,
    type RpcSubscriptions,
    sendAndConfirmTransactionFactory,
    setTransactionMessageComputeUnitPrice,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    type Signature,
    signTransactionMessageWithSigners,
    type SignatureNotificationsApi,
    type SlotNotificationsApi,
    type SolanaRpcApi,
    type TransactionMessage,
    type TransactionMessageWithFeePayer,
    type TransactionSigner,
} from '@solana/kit';

/** The compute-unit price the service pays, in micro-lamports: a percentile of recent fees, clamped. */
export const PRIORITY_FEE = { ceiling: 1_000_000n, floor: 1_000n, percentile: 75 };

/** The share of simulated compute units added to each transaction's limit. */
const COMPUTE_MARGIN = 1.1;

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

/** Builds and sends the service's transactions, `payer` paying their fees and the rent of what they create. */
export type Sender = ReturnType<typeof createSender>;

export function createSender({
    payer,
    rpc,
    rpcSubscriptions,
}: {
    payer: TransactionSigner;
    rpc: Rpc<SolanaRpcApi>;
    rpcSubscriptions: RpcSubscriptions<SignatureNotificationsApi & SlotNotificationsApi>;
}) {
    const estimate = estimateResourceLimitsFactory({ rpc });
    const estimateAndSet = estimateAndSetResourceLimitsFactory((async (message, config) => {
        const limits = await estimate(message, { ...config, commitment: 'confirmed' });
        return { ...limits, computeUnitLimit: Math.ceil(limits.computeUnitLimit * COMPUTE_MARGIN) };
    }) as typeof estimate);
    const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

    return {
        /**
         * A version 0 message of `instructions` with a provisory compute-unit limit and a price from the recent fees
         * on the accounts it writes (or `writable`); its lifetime and limit are set by {@link send}.
         */
        async build(instructions: readonly Instruction[], writable?: readonly Address[]) {
            const accounts =
                writable ??
                instructions.flatMap(({ accounts = [] }) =>
                    accounts
                        .filter(({ role }) => role === AccountRole.WRITABLE || role === AccountRole.WRITABLE_SIGNER)
                        .map(({ address }) => address),
                );
            const price = await recentPriorityFee(rpc, [...new Set(accounts)]);
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
    };
}

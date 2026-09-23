import {
    type AddressesByLookupTableAddress,
    appendTransactionMessageInstructions,
    assertIsTransactionMessageWithinSizeLimit,
    compressTransactionMessageUsingAddressLookupTables,
    createTransactionMessage,
    fillTransactionMessageProvisoryResourceLimits,
    type Instruction,
    type Lamports,
    type MicroLamports,
    pipe,
    setTransactionMessageComputeUnitPrice,
    setTransactionMessageFeePayerSigner,
    setTransactionMessagePriorityFeeLamports,
    type TransactionSigner,
} from '@solana/kit';

/**
 * A sponsored user transaction as ADR-003 shapes it: version 0, compiled against the onboarding lookup table, the
 * sponsor paying the fee at `computeUnitPrice`. The compute-unit limit is provisory: estimate it before sending
 * (`estimateAndSetResourceLimitsFactory`).
 */
export function createSponsoredTransactionMessage(input: {
    computeUnitPrice: MicroLamports;
    instructions: readonly Instruction[];
    lookupTable: AddressesByLookupTableAddress;
    sponsor: TransactionSigner;
}) {
    return pipe(
        createTransactionMessage({ version: 0 }),
        message => setTransactionMessageFeePayerSigner(input.sponsor, message),
        message => fillTransactionMessageProvisoryResourceLimits(message),
        message => setTransactionMessageComputeUnitPrice(input.computeUnitPrice, message),
        message => appendTransactionMessageInstructions(input.instructions, message),
        message => compressTransactionMessageUsingAddressLookupTables(message, input.lookupTable),
    );
}

/**
 * A sweep as ADR-001 shapes it: version 1 with every account inline, the crank paying, within 4,096 bytes. The
 * compute-unit and loaded-accounts data limits are provisory (a version 1 transaction budgets none by default):
 * estimate them before sending (`estimateAndSetResourceLimitsFactory`).
 */
export function createSweepTransactionMessage(input: {
    crank: TransactionSigner;
    instructions: readonly Instruction[];
    priorityFeeLamports?: Lamports;
}) {
    return pipe(
        createTransactionMessage({ version: 1 }),
        message => setTransactionMessageFeePayerSigner(input.crank, message),
        message => fillTransactionMessageProvisoryResourceLimits(message),
        message =>
            input.priorityFeeLamports === undefined
                ? message
                : setTransactionMessagePriorityFeeLamports(input.priorityFeeLamports, message),
        message => appendTransactionMessageInstructions(input.instructions, message),
        message => {
            assertIsTransactionMessageWithinSizeLimit(message);
            return message;
        },
    );
}

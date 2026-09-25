import { type AttestationArgs, EventKind, type PaymentToken } from '@laterite/client';
import { AccountRole, type Address, getBase58Encoder, type Signature } from '@solana/kit';
import {
    identifyTokenInstruction,
    parseTransferCheckedInstruction,
    parseTransferInstruction,
    TokenInstruction,
} from '@solana-program/token';

import { type Executed, executedInstructions, type FetchedTransaction } from '../transaction';

/** A transfer of a configured payment token to or from a user, numbered as the attestation's `transfer_index`. */
export type PaymentTransfer = {
    amount: bigint;
    destination: Address;
    destinationOwner: Address | null;
    /** Its position among the transaction's payment-token transfers to or from the user, from 0. */
    index: number;
    paymentToken: number;
    source: Address;
    sourceOwner: Address | null;
};

/** The transfer an instruction makes, if it is a Token or Token-2022 `Transfer` or `TransferChecked`. */
function tokenTransfer(instruction: Executed, mints: ReadonlyMap<Address, Address>) {
    const parsable = {
        accounts: instruction.accounts.map(address => ({ address, role: AccountRole.READONLY })),
        data: instruction.data,
        programAddress: instruction.programAddress,
    };
    let kind: TokenInstruction;
    try {
        kind = identifyTokenInstruction(instruction.data);
    } catch {
        return null;
    }
    if (kind === TokenInstruction.Transfer) {
        const { accounts, data } = parseTransferInstruction(parsable);
        const [source, destination] = [accounts.source.address, accounts.destination.address];
        const mint = mints.get(source) ?? mints.get(destination);
        return mint ? { amount: data.amount, destination, mint, source } : null;
    }
    if (kind === TokenInstruction.TransferChecked) {
        const { accounts, data } = parseTransferCheckedInstruction(parsable);
        return {
            amount: data.amount,
            destination: accounts.destination.address,
            mint: accounts.mint.address,
            source: accounts.source.address,
        };
    }
    return null;
}

/**
 * The transaction's transfers of a configured payment token (both, whether `user` enabled them or not) whose source
 * or destination account `user` owns, in the order they ran: each top-level instruction, then those it invoked. Mints
 * and owners come from the transaction's own token balances (before it ran, else after), so every copy of a finalized
 * transaction numbers its transfers alike.
 */
export function getPaymentTransfers(
    transaction: FetchedTransaction,
    user: Address,
    paymentTokens: readonly PaymentToken[],
): PaymentTransfer[] {
    const { executed, keys } = executedInstructions(transaction);
    const accounts = new Map<Address, { mint: Address; owner: Address | null }>();
    for (const balances of [transaction.meta?.postTokenBalances, transaction.meta?.preTokenBalances]) {
        for (const { accountIndex, mint, owner } of balances ?? []) {
            accounts.set(keys[accountIndex]!, { mint, owner: owner ?? null });
        }
    }
    const mints = new Map([...accounts].map(([address, { mint }]) => [address, mint]));
    const programs = new Set(paymentTokens.map(({ tokenProgram }) => tokenProgram));
    const transfers: PaymentTransfer[] = [];
    for (const instruction of executed) {
        if (!programs.has(instruction.programAddress)) continue;
        const transfer = tokenTransfer(instruction, mints);
        const paymentToken = paymentTokens.findIndex(
            ({ mint, tokenProgram }) => mint === transfer?.mint && tokenProgram === instruction.programAddress,
        );
        if (!transfer || paymentToken < 0) continue;
        const sourceOwner = accounts.get(transfer.source)?.owner ?? null;
        const destinationOwner = accounts.get(transfer.destination)?.owner ?? null;
        if (sourceOwner !== user && destinationOwner !== user) continue;
        transfers.push({
            amount: transfer.amount,
            destination: transfer.destination,
            destinationOwner,
            index: transfers.length,
            paymentToken,
            source: transfer.source,
            sourceOwner,
        });
    }
    return transfers;
}

/** The token account a watched user is credited through: their associated account in one payment token. */
export type WatchedAccount = { address: Address; paymentToken: number; user: Address };

/**
 * The attestations one finalized transaction yields for a watched account: Income for each transfer into it and
 * Payment for each transfer out of it, except zero amounts and transfers with another account of the same owner or
 * with the swap authority (a sweep's pull). Whether they count is the user's state's to decide.
 */
export function getAttestations(
    signature: Signature,
    transaction: FetchedTransaction,
    account: WatchedAccount,
    paymentTokens: readonly PaymentToken[],
    swapAuthority: Address,
): AttestationArgs[] {
    if (!transaction.meta || transaction.meta.err || transaction.blockTime === null) return [];
    const excluded = new Set<Address | null>([account.user, swapAuthority]);
    const signatureBytes = getBase58Encoder().encode(signature);
    return getPaymentTransfers(transaction, account.user, paymentTokens).flatMap(transfer => {
        const kind =
            transfer.destination === account.address && !excluded.has(transfer.sourceOwner)
                ? EventKind.Income
                : transfer.source === account.address && !excluded.has(transfer.destinationOwner)
                  ? EventKind.Payment
                  : null;
        if (kind === null || transfer.amount === 0n || transfer.paymentToken !== account.paymentToken) return [];
        return [
            {
                amount: transfer.amount,
                eventTime: transaction.blockTime!,
                kind,
                paymentToken: transfer.paymentToken,
                signature: signatureBytes,
                transferIndex: transfer.index,
                user: account.user,
            },
        ];
    });
}

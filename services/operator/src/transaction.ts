import {
    type Address,
    getBase58Encoder,
    getBase64Encoder,
    getCompiledTransactionMessageDecoder,
    type GetTransactionApi,
    getTransactionDecoder,
    type ReadonlyUint8Array,
    type Rpc,
    type Signature,
} from '@solana/kit';

/** A token account's balance entry in a transaction's metadata: its index among the account keys, mint and owner. */
export type TokenBalance = { accountIndex: number; mint: Address; owner?: Address };

/** A finalized transaction as `getTransaction` returns it with `encoding: 'base64'`. */
export type FetchedTransaction = {
    blockTime: bigint | null;
    meta: {
        err: unknown;
        innerInstructions?:
            | readonly {
                  index: number;
                  instructions: readonly { accounts: readonly number[]; data: string; programIdIndex: number }[];
              }[]
            | null;
        loadedAddresses?: { readonly: readonly Address[]; writable: readonly Address[] };
        logMessages?: readonly string[] | null;
        postTokenBalances?: readonly TokenBalance[] | null;
        preTokenBalances?: readonly TokenBalance[] | null;
    } | null;
    slot: bigint;
    transaction: readonly [string, 'base64'];
};

/** An instruction as it ran: its program, accounts and data. */
export type Executed = { accounts: Address[]; data: ReadonlyUint8Array; programAddress: Address };

/** A finalized transaction, every version included (sweeps are version 1), or `null` while the node lacks it. */
export async function fetchTransaction(rpc: Rpc<GetTransactionApi>, signature: Signature) {
    return (await rpc
        .getTransaction(signature, { commitment: 'finalized', encoding: 'base64', maxSupportedTransactionVersion: 1 })
        .send()) as FetchedTransaction | null;
}

/**
 * The instructions a transaction ran, in order: each top-level one followed by those it invoked; and its account keys
 * (static, then those loaded from lookup tables), which token balances index.
 */
export function executedInstructions(transaction: FetchedTransaction): { executed: Executed[]; keys: Address[] } {
    const wire = getTransactionDecoder().decode(getBase64Encoder().encode(transaction.transaction[0]));
    const message = getCompiledTransactionMessageDecoder().decode(wire.messageBytes);
    const loaded = transaction.meta?.loadedAddresses;
    const keys = [...message.staticAccounts, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
    const outer =
        'instructions' in message
            ? message.instructions.map(({ accountIndices, data, programAddressIndex }) => ({
                  accounts: accountIndices ?? [],
                  data: data ?? new Uint8Array(),
                  programIdIndex: programAddressIndex,
              }))
            : message.instructionHeaders.map((header, index) => ({
                  accounts: message.instructionPayloads[index]!.instructionAccountIndices,
                  data: message.instructionPayloads[index]!.instructionData,
                  programIdIndex: header.programAccountIndex,
              }));
    const inner = new Map(
        (transaction.meta?.innerInstructions ?? []).map(({ index, instructions }) => [index, instructions]),
    );
    const resolve = (accounts: readonly number[], data: ReadonlyUint8Array, programIdIndex: number): Executed => ({
        accounts: accounts.map(index => keys[index]!),
        data,
        programAddress: keys[programIdIndex]!,
    });
    const executed = outer.flatMap(({ accounts, data, programIdIndex }, index) => [
        resolve(accounts, data, programIdIndex),
        ...(inner.get(index) ?? []).map(instruction =>
            resolve(instruction.accounts, getBase58Encoder().encode(instruction.data), instruction.programIdIndex),
        ),
    ]);
    return { executed, keys };
}

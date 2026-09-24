import {
    address,
    type Address,
    getBase64Encoder,
    getCompiledTransactionMessageDecoder,
    getTransactionDecoder,
    MAX_SUPPORTED_TRANSACTION_VERSION,
    type GetSignaturesForAddressApi,
    type GetTransactionApi,
    type ReadonlyUint8Array,
    type Rpc,
    type Signature,
} from '@solana/kit';

import { ED25519_PROGRAM_ADDRESS, ED25519_THIS_INSTRUCTION } from '../ed25519';
import { hasFeed, PYTH_STORAGE_ADDRESS } from '../pyth';

/** Kamino Scope, which posts a signed Pyth Pro update with SPYX/USD and QQQX/USD on mainnet about every 40 s. */
export const KAMINO_SCOPE_PROGRAM_ADDRESS = address('HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ');

const u16 = (data: ReadonlyUint8Array, offset: number) => (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8);

/**
 * The Solana-format Pyth Pro update a posting transaction (legacy, version 0 or version 1) carries, sliced out of the instruction its ed25519
 * instruction points into at the offsets it names (they move with the length of whatever precedes the update).
 * Returns `null` when the transaction verifies no such update.
 */
export function getPythUpdateFromTransaction(wireTransaction: ReadonlyUint8Array): ReadonlyUint8Array | null {
    const { messageBytes } = getTransactionDecoder().decode(wireTransaction);
    const message = getCompiledTransactionMessageDecoder().decode(messageBytes);
    const instructions =
        'instructions' in message
            ? message.instructions.map(({ data, programAddressIndex }) => ({ data, programAddressIndex }))
            : message.instructionHeaders.map((header, index) => ({
                  data: message.instructionPayloads[index]!.instructionData,
                  programAddressIndex: header.programAccountIndex,
              }));
    for (const [index, instruction] of instructions.entries()) {
        if (message.staticAccounts[instruction.programAddressIndex] !== ED25519_PROGRAM_ADDRESS) continue;
        const data = instruction.data ?? new Uint8Array();
        if (data[0] !== 1) continue;
        const signatureOffset = u16(data, 2);
        const signatureIndex = u16(data, 4);
        const publicKeyOffset = u16(data, 6);
        const publicKeyIndex = u16(data, 8);
        const messageOffset = u16(data, 10);
        const messageSize = u16(data, 12);
        const messageIndex = u16(data, 14);
        const source = messageIndex === ED25519_THIS_INSTRUCTION ? index : messageIndex;
        // A Solana-format update: magic, signature, public key, payload length, payload.
        const start = signatureOffset - 4;
        const valid =
            signatureIndex === messageIndex &&
            publicKeyIndex === messageIndex &&
            publicKeyOffset === signatureOffset + 64 &&
            messageOffset === signatureOffset + 98 &&
            start >= 0;
        const carrier = instructions[source]?.data;
        if (!valid || !carrier || carrier.length < messageOffset + messageSize) continue;
        return carrier.slice(start, messageOffset + messageSize);
    }
    return null;
}

/** An update Kamino Scope posted: the update, its transaction's signature and block time. */
export type KaminoUpdate = { blockTime: bigint | null; message: ReadonlyUint8Array; signature: Signature };

/** Reads the Pyth Pro update a Kamino Scope transaction posted, or `null` when it posted none. */
export async function fetchKaminoUpdate(
    rpc: Rpc<GetTransactionApi>,
    signature: Signature,
): Promise<KaminoUpdate | null> {
    const transaction = await rpc
        .getTransaction(signature, {
            commitment: 'confirmed',
            encoding: 'base64',
            maxSupportedTransactionVersion: MAX_SUPPORTED_TRANSACTION_VERSION,
        })
        .send();
    if (!transaction || transaction.meta?.err) return null;
    const message = getPythUpdateFromTransaction(getBase64Encoder().encode(transaction.transaction[0]));
    return message && { blockTime: transaction.blockTime, message, signature };
}

/**
 * Finds Kamino Scope's latest Pyth Pro post carrying each of `feedIds` from a mainnet RPC, leaving out a feed no recent
 * post carries. Scope refreshes many oracles and Pyth Pro verifies updates for many programs, so its posts are the
 * transactions both lists name. Check an update with `verifyPythUpdate` and `quote` (with the sender's own freshness
 * margin) before a sweep carries it.
 */
export async function fetchLatestKaminoUpdates(
    rpc: Rpc<GetSignaturesForAddressApi & GetTransactionApi>,
    feedIds: readonly number[],
): Promise<Map<number, KaminoUpdate>> {
    const recent = (address: Address) =>
        rpc.getSignaturesForAddress(address, { commitment: 'confirmed', limit: 1_000 }).send();
    const [scope, pyth] = await Promise.all([recent(KAMINO_SCOPE_PROGRAM_ADDRESS), recent(PYTH_STORAGE_ADDRESS)]);
    const verified = new Set(pyth.filter(({ err }) => !err).map(({ signature }) => signature));
    const latest = new Map<number, KaminoUpdate>();
    for (const { signature } of scope) {
        if (latest.size === feedIds.length) break;
        if (!verified.has(signature)) continue;
        const update = await fetchKaminoUpdate(rpc, signature);
        if (!update) continue;
        for (const feedId of feedIds) {
            if (!latest.has(feedId) && hasFeed(update.message, feedId)) latest.set(feedId, update);
        }
    }
    return latest;
}

/** Kamino Scope's latest Pyth Pro post carrying `feedId`, as {@link fetchLatestKaminoUpdates} finds it. */
export async function fetchLatestKaminoUpdate(
    rpc: Rpc<GetSignaturesForAddressApi & GetTransactionApi>,
    feedId: number,
): Promise<KaminoUpdate> {
    const update = (await fetchLatestKaminoUpdates(rpc, [feedId])).get(feedId);
    if (!update) throw new Error(`No Pyth Pro update with feed ${feedId} among Kamino Scope latest transactions`);
    return update;
}

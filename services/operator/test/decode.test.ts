import { EVENT_IX_TAG_LE, getSweptEventEncoder, LATERITE_PROGRAM_ADDRESS } from '@laterite/client';
import {
    AccountRole,
    type Address,
    appendTransactionMessageInstruction,
    compileTransaction,
    createTransactionMessage,
    getBase58Decoder,
    getBase64EncodedWireTransaction,
    getCompiledTransactionMessageDecoder,
    pipe,
    setTransactionMessageFeePayer,
    setTransactionMessageLifetimeUsingBlockhash,
    type Blockhash,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';

import { decodeTransaction, type FetchedTransaction } from '../src/indexer/decode';

const FORGER = 'Forger1111111111111111111111111111111111111' as Address;
const PAYER = 'Payer11111111111111111111111111111111111111' as Address;

/** A `Swept` event as a self-CPI carries it: Anchor's event tag, then the event with its discriminator. */
const sweptData = (received: bigint) =>
    getBase58Decoder().decode(
        new Uint8Array([
            ...EVENT_IX_TAG_LE,
            ...getSweptEventEncoder().encode({
                asset: 0,
                assetExponent: -8,
                assetPrice: 1n,
                engine: 1n,
                minOut: 1n,
                paymentToken: 0,
                pending: 0n,
                received,
                user: PAYER,
            }),
        ]),
    );

describe('decoding', () => {
    it("takes Swept only from Laterite's own self-CPI, never from another program's instruction data", () => {
        const message = pipe(
            createTransactionMessage({ version: 0 }),
            m => setTransactionMessageFeePayer(PAYER, m),
            m =>
                setTransactionMessageLifetimeUsingBlockhash(
                    { blockhash: PAYER as unknown as Blockhash, lastValidBlockHeight: 0n },
                    m,
                ),
            m =>
                appendTransactionMessageInstruction(
                    {
                        accounts: [{ address: LATERITE_PROGRAM_ADDRESS, role: AccountRole.READONLY }],
                        programAddress: FORGER,
                    },
                    m,
                ),
        );
        const transaction = compileTransaction(message);
        const { staticAccounts } = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
        const index = (address: Address) => staticAccounts.indexOf(address);
        const fetched: FetchedTransaction = {
            blockTime: 1_790_000_000n,
            meta: {
                err: null,
                innerInstructions: [
                    {
                        index: 0,
                        instructions: [
                            { accounts: [], data: sweptData(1n), programIdIndex: index(FORGER) },
                            { accounts: [], data: sweptData(2n), programIdIndex: index(LATERITE_PROGRAM_ADDRESS) },
                        ],
                    },
                ],
                logMessages: [],
            },
            slot: 1n,
            transaction: [getBase64EncodedWireTransaction(transaction), 'base64'],
        };
        expect(decodeTransaction('forged', fetched).sweeps.map(row => row.received)).toEqual([2n]);
    });
});

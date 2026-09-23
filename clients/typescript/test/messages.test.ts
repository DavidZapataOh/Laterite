import {
    type Address,
    createSignableMessage,
    getBase16Decoder,
    getBase16Encoder,
    type ReadonlyUint8Array,
} from '@solana/kit';
import { describe, expect, it } from 'vitest';

import * as client from '../src';
import {
    DOLLAR_QUOTE,
    type EventKind,
    findAttestationRecordPda,
    getAttestationMessage,
    getEd25519SignatureInstruction,
    getPythEd25519Instruction,
    LATERITE_PROGRAM_ADDRESS,
    LateriteCheckError,
    minOut,
    type Quote,
    quote,
} from '../src';
import { attestorSigner, DEVNET_GENESIS_HASH, PYTH_SPYX_QQQX, PYTH_USDT, vectors } from './fixtures';

const hex = getBase16Encoder();
const toHex = (bytes: ReadonlyUint8Array) => getBase16Decoder().decode(bytes);

/** The program's error name for a check the mirror failed, as the vectors record it. */
function errorName(error: unknown): string {
    if (!(error instanceof LateriteCheckError)) throw error;
    const constant = Object.entries(client).find(
        ([name, value]) => name.startsWith('LATERITE_ERROR__') && value === error.code,
    )![0];
    return constant
        .slice('LATERITE_ERROR__'.length)
        .toLowerCase()
        .replace(/(^|_)([a-z])/g, (_, __, letter: string) => letter.toUpperCase());
}

type QuoteResult = { confidence: string; exponent: number; price: string } | { error: string };

describe('Pyth Pro prices mirror the program', () => {
    const price = vectors<{
        minOuts: {
            amount: string;
            asset: [string, string, number];
            assetDecimals: number;
            payment: [string, string, number];
            paymentDecimals: number;
            result: { error: string } | { value: string };
        }[];
        quotes: {
            cut?: number;
            feedId: number;
            message?: string;
            now: string;
            result: QuoteResult;
            set?: [number, number];
            update?: string;
        }[];
    }>('price');
    const updates: Record<string, Uint8Array> = { empty: new Uint8Array(), spyx_qqqx: PYTH_SPYX_QQQX, usdt: PYTH_USDT };

    it(`quotes what the program quotes in all ${price.quotes.length} cases`, () => {
        for (const vector of price.quotes) {
            let message = vector.message
                ? new Uint8Array(hex.encode(vector.message))
                : updates[vector.update!]!.slice();
            if (vector.cut !== undefined) message = message.slice(0, vector.cut);
            if (vector.set) message[vector.set[0]] = vector.set[1];
            let result: QuoteResult;
            try {
                const { confidence, exponent, price: value } = quote(message, vector.feedId, BigInt(vector.now));
                result = { confidence: String(confidence), exponent, price: String(value) };
            } catch (error) {
                result = { error: errorName(error) };
            }
            expect(result, JSON.stringify({ ...vector, result: undefined })).toEqual(vector.result);
        }
    });

    it(`derives the program's minimum output in all ${price.minOuts.length} cases`, () => {
        const toQuote = ([value, confidence, exponent]: [string, string, number]): Quote => ({
            confidence: BigInt(confidence),
            exponent,
            price: BigInt(value),
        });
        for (const vector of price.minOuts) {
            let result: { error: string } | { value: string };
            try {
                const value = minOut(
                    BigInt(vector.amount),
                    toQuote(vector.payment),
                    vector.paymentDecimals,
                    toQuote(vector.asset),
                    vector.assetDecimals,
                );
                result = { value: String(value) };
            } catch (error) {
                result = { error: errorName(error) };
            }
            expect(result, JSON.stringify(vector)).toEqual(vector.result);
        }
        expect(DOLLAR_QUOTE).toEqual({ confidence: 0n, exponent: 0, price: 1n });
    });
});

describe('attestations and ed25519 instructions match the program tests', () => {
    const attestation = vectors<{
        cases: {
            attestation: {
                amount: string;
                eventTime: string;
                kind: number;
                paymentToken: number;
                signature: string;
                transferIndex: number;
                user: Address;
            };
            ed25519: string;
            genesisHash: string;
            message: string;
            record: Address;
        }[];
        sweepEd25519: { usdc: string; usdt: string };
    }>('attestation');

    it('builds the 203-byte message, the standard signature instruction and the record address', async () => {
        const attestor = await attestorSigner();
        for (const vector of attestation.cases) {
            const args = {
                ...vector.attestation,
                amount: BigInt(vector.attestation.amount),
                eventTime: BigInt(vector.attestation.eventTime),
                kind: vector.attestation.kind as EventKind,
                signature: hex.encode(vector.attestation.signature),
            };
            const message = getAttestationMessage(hex.encode(vector.genesisHash), args);
            expect(message.length).toBe(203);
            expect(toHex(message)).toBe(vector.message);
            const [signatures] = await attestor.signMessages([createSignableMessage(message)]);
            const instruction = getEd25519SignatureInstruction({
                message,
                publicKey: attestor.address,
                signature: signatures![attestor.address]!,
            });
            expect(toHex(instruction.data!)).toBe(vector.ed25519);
            expect((await findAttestationRecordPda(args))[0]).toBe(vector.record);
        }
    });

    it("equals the program's parity bytes for devnet", () => {
        const message = getAttestationMessage(DEVNET_GENESIS_HASH, {
            amount: 12_340_000n,
            eventTime: 1_790_000_060n,
            kind: 1,
            paymentToken: 1,
            signature: new Uint8Array(64).fill(7),
            transferIndex: 3,
            user: LATERITE_PROGRAM_ADDRESS,
        });
        expect(toHex(message)).toBe(
            '6c617465726974653a6174746573746174696f6e3a7631050458a88bf6320d82ff0f991bb809a12fee69032ff49ab91dcc25db07dfba8ece59db5080fc2c6d3bcf7ca90712d3c2e5e6c28f27f0dfbb9953bdb0894c03ab01050458a88bf6320d82ff0f991bb809a12fee69032ff49ab91dcc25db07dfba8e01204bbc0000000000bc3bb16a00000000070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070707070300',
        );
    });

    it("lays out a sweep's ed25519 instruction as the program tests do", () => {
        const sweep = (payment: Uint8Array) => {
            const updates: { instructionIndex: number; message: ReadonlyUint8Array; offset: number }[] = [
                { instructionIndex: 1, message: PYTH_SPYX_QQQX, offset: 12 },
            ];
            if (payment.length)
                updates.push({ instructionIndex: 1, message: payment, offset: 16 + PYTH_SPYX_QQQX.length });
            return toHex(getPythEd25519Instruction(updates).data!);
        };
        expect(sweep(new Uint8Array())).toBe(attestation.sweepEd25519.usdc);
        expect(sweep(PYTH_USDT)).toBe(attestation.sweepEd25519.usdt);
        expect(attestation.sweepEd25519.usdc.length / 2).toBe(2 + 14);
        expect(attestation.sweepEd25519.usdt.length / 2).toBe(2 + 14 * 2);
    });
});

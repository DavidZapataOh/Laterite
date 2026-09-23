import {
    address,
    type Address,
    getAddressEncoder,
    getArrayEncoder,
    getStructEncoder,
    getU16Encoder,
    getU8Encoder,
    type Instruction,
    type ReadonlyUint8Array,
    type SignatureBytes,
} from '@solana/kit';

/** The ed25519 signature-verification precompile. */
export const ED25519_PROGRAM_ADDRESS = address('Ed25519SigVerify111111111111111111111111111');

/** An instruction index that names the ed25519 instruction itself. */
export const ED25519_THIS_INSTRUCTION = 0xffff;

/** Where one signature, its public key and its message are, each in the data of the instruction at an index. */
export type Ed25519SignatureOffsets = {
    messageDataOffset: number;
    messageDataSize: number;
    messageInstructionIndex: number;
    publicKeyInstructionIndex: number;
    publicKeyOffset: number;
    signatureInstructionIndex: number;
    signatureOffset: number;
};

const offsetsEncoder = getStructEncoder([
    ['signatureOffset', getU16Encoder()],
    ['signatureInstructionIndex', getU16Encoder()],
    ['publicKeyOffset', getU16Encoder()],
    ['publicKeyInstructionIndex', getU16Encoder()],
    ['messageDataOffset', getU16Encoder()],
    ['messageDataSize', getU16Encoder()],
    ['messageInstructionIndex', getU16Encoder()],
]);

const headerEncoder = getStructEncoder([
    ['count', getU8Encoder()],
    ['padding', getU8Encoder()],
    ['entries', getArrayEncoder(offsetsEncoder, { size: 'remainder' })],
]);

/** The ed25519 precompile over `entries`, followed by `inline` bytes that entries can point into. */
export function getEd25519Instruction(
    entries: Ed25519SignatureOffsets[],
    inline: ReadonlyUint8Array = new Uint8Array(),
): Instruction {
    const header = headerEncoder.encode({ count: entries.length, entries, padding: 0 });
    const data = new Uint8Array(header.length + inline.length);
    data.set(header);
    data.set(inline, header.length);
    return { data, programAddress: ED25519_PROGRAM_ADDRESS };
}

/**
 * The standard single-signature layout: `publicKey` at 16, `signature` at 48 and `message` at 112 of this
 * instruction's own data, as `new_ed25519_instruction_with_signature` builds it.
 */
export function getEd25519SignatureInstruction(input: {
    message: ReadonlyUint8Array;
    publicKey: Address;
    signature: SignatureBytes;
}): Instruction {
    const publicKeyOffset = 16;
    const signatureOffset = publicKeyOffset + 32;
    const messageDataOffset = signatureOffset + 64;
    const inline = new Uint8Array(96 + input.message.length);
    inline.set(getAddressEncoder().encode(input.publicKey));
    inline.set(input.signature, 32);
    inline.set(input.message, 96);
    const entry = {
        messageDataOffset,
        messageDataSize: input.message.length,
        messageInstructionIndex: ED25519_THIS_INSTRUCTION,
        publicKeyInstructionIndex: ED25519_THIS_INSTRUCTION,
        publicKeyOffset,
        signatureInstructionIndex: ED25519_THIS_INSTRUCTION,
        signatureOffset,
    };
    return getEd25519Instruction([entry], inline);
}

/**
 * The ed25519 precompile over Solana-format Pyth Pro updates carried in another instruction's data, each given
 * with that instruction's index and the update's offset in its data. An update's position here is the signature
 * index Pyth Pro's `verify_message` takes for it.
 */
export function getPythEd25519Instruction(
    updates: { instructionIndex: number; message: ReadonlyUint8Array; offset: number }[],
): Instruction {
    return getEd25519Instruction(
        updates.map(({ instructionIndex, message, offset }) => ({
            // Magic (4), signature (64), public key (32), payload length (2), payload.
            messageDataOffset: offset + 102,
            messageDataSize: message.length - 102,
            messageInstructionIndex: instructionIndex,
            publicKeyInstructionIndex: instructionIndex,
            publicKeyOffset: offset + 68,
            signatureInstructionIndex: instructionIndex,
            signatureOffset: offset + 4,
        })),
    );
}

import {
    createSignableMessage,
    getAddressEncoder,
    getProgramDerivedAddress,
    getU16Encoder,
    type Instruction,
    type MessagePartialSigner,
    type ReadonlyUint8Array,
    type TransactionSigner,
} from '@solana/kit';

import { getEd25519SignatureInstruction } from './ed25519';
import {
    ATTESTATION_DOMAIN,
    ATTESTATION_SEED,
    type AttestationArgs,
    findUserConfigPda,
    getAttestationEncoder,
    getAttestInstruction,
    LATERITE_PROGRAM_ADDRESS,
} from './generated';

/**
 * What the attestor signs for `attestation` in this program's deployment on the cluster with `genesisHash`
 * (`Config.genesisHash`): `ATTESTATION_DOMAIN`, the program address, the genesis hash, then the Borsh attestation;
 * 203 bytes. The program rebuilds it from its own address and `Config`.
 */
export function getAttestationMessage(genesisHash: ReadonlyUint8Array, attestation: AttestationArgs) {
    const parts = [
        ATTESTATION_DOMAIN,
        getAddressEncoder().encode(LATERITE_PROGRAM_ADDRESS),
        genesisHash,
        getAttestationEncoder().encode(attestation),
    ];
    const message = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
    parts.reduce((offset, part) => (message.set(part, offset), offset + part.length), 0);
    return message;
}

/** The record that counts a transfer once: keyed by the user, the transfer's signature and its index. */
export function findAttestationRecordPda(attestation: Pick<AttestationArgs, 'signature' | 'transferIndex' | 'user'>) {
    return getProgramDerivedAddress({
        programAddress: LATERITE_PROGRAM_ADDRESS,
        seeds: [
            ATTESTATION_SEED,
            getAddressEncoder().encode(attestation.user),
            attestation.signature.slice(0, 32),
            attestation.signature.slice(32, 64),
            getU16Encoder().encode(attestation.transferIndex),
        ],
    });
}

/**
 * The `[ed25519, attest]` pair of one attestation: `attestor` signs its message and nothing else, `payer` pays
 * the fee and the record's rent. Several pairs may share a transaction; `attest` reads the instruction right
 * before it.
 */
export async function getAttestInstructions(input: {
    attestation: AttestationArgs;
    attestor: MessagePartialSigner;
    genesisHash: ReadonlyUint8Array;
    payer: TransactionSigner;
}): Promise<[Instruction, Instruction]> {
    const message = getAttestationMessage(input.genesisHash, input.attestation);
    const [signatures] = await input.attestor.signMessages([createSignableMessage(message)]);
    const signature = signatures?.[input.attestor.address];
    if (!signature) throw new Error(`${input.attestor.address} did not sign the attestation`);
    const [[userConfig], [record]] = await Promise.all([
        findUserConfigPda({ user: input.attestation.user }),
        findAttestationRecordPda(input.attestation),
    ]);
    return [
        getEd25519SignatureInstruction({ message, publicKey: input.attestor.address, signature }),
        getAttestInstruction({ attestation: input.attestation, payer: input.payer, record, userConfig }),
    ];
}

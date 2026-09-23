import { readFileSync } from 'node:fs';

import {
    type Address,
    createKeyPairSignerFromPrivateKeyBytes,
    getBase58Encoder,
    type KeyPairSigner,
} from '@solana/kit';

export const root = new URL('../../../', import.meta.url);
export const read = (path: string) => readFileSync(new URL(path, root));
export const fixture = (name: string) => read(`programs/laterite/tests/fixtures/${name}`);
export const vectors = <T>(name: string): T =>
    JSON.parse(read(`programs/laterite/tests/vectors/${name}.json`).toString());

/** Monday 2026-09-21, 14:13:20 UTC, the program tests' clock. */
export const NOW = 1_790_000_000n;
/** When both real Pyth Pro updates were published. */
export const PYTH_UPDATES_AT = 1_790_043_964n;
export const PYTH_SPYX_QQQX = new Uint8Array(fixture('pyth_spyx_qqqx.bin'));
export const PYTH_USDT = new Uint8Array(fixture('pyth_usdt.bin'));
export const PYTH_SPYX_QUOTE = { confidence: 30_532_893n, exponent: -8, price: 77_847_155_496n };
export const PYTH_USDT_QUOTE = { confidence: 7_028n, exponent: -8, price: 99_972_708n };
export const DEVNET_GENESIS_HASH = getBase58Encoder().encode('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
export const MAINNET_GENESIS_HASH = getBase58Encoder().encode('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d');
export const DOLLAR = 1_000_000n;

/** Each cluster's Pyth Pro: its program, its storage and the treasury that storage names. */
export const PYTH = {
    devnet: {
        program: 'pyth_pro_devnet.so',
        storage: 'pyth_storage_devnet.bin',
        treasury: 'opsLibxVY7Vz5eYMmSfX8cLFCFVYTtH6fr6MiifMpA7' as Address,
    },
    mainnet: {
        program: 'pyth_pro_mainnet.so',
        storage: 'pyth_storage_mainnet.bin',
        treasury: 'Gx4MBPb1vqZLJajZmsKLg8fGw9ErhoKsR8LeKcCKFyak' as Address,
    },
};

/** A signer from a 32-byte seed filled with `byte`, as the program tests' `Keypair::new_from_array([byte; 32])`. */
export function seeded(byte: number): Promise<KeyPairSigner> {
    // One instance per key: a transaction refuses two signer objects for one address.
    let signer = signers.get(byte);
    if (!signer) signers.set(byte, (signer = createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(byte))));
    return signer;
}
const signers = new Map<number, Promise<KeyPairSigner>>();
export const sponsorSigner = () => seeded(7);
export const attestorSigner = () => seeded(8);

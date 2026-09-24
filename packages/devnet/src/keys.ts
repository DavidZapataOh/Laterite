import { readFile } from 'node:fs/promises';

import { createKeyPairSignerFromBytes, type KeyPairSigner } from '@solana/kit';

const KEYS_DIR = new URL('../../../keys/', import.meta.url);

export type KeyName =
    | 'devnet-attestor'
    | 'devnet-authority'
    | 'devnet-cpmm'
    | 'devnet-faucet'
    | 'devnet-issuer'
    | 'devnet-qqqx'
    | 'devnet-spyx'
    | 'devnet-sponsor'
    | 'devnet-treasury'
    | 'devnet-usdc'
    | 'devnet-usdt';

/** Loads a keypair written by `just devnet-keys`. */
export async function loadSigner(name: KeyName): Promise<KeyPairSigner> {
    const bytes = JSON.parse(await readFile(new URL(`${name}.json`, KEYS_DIR), 'utf8')) as number[];
    return await createKeyPairSignerFromBytes(new Uint8Array(bytes));
}

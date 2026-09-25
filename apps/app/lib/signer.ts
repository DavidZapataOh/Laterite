import 'server-only';

import { createKeyPairSignerFromBytes, type KeyPairSigner } from '@solana/kit';

/** The server's keys, each a Vercel secret holding a keypair file's contents. */
export type KeyVariable = 'FAUCET_KEYPAIR' | 'SPONSOR_KEYPAIR';

/** Reads the key in `name`: a JSON array of 64 bytes, as the Solana CLI writes a keypair file. */
export async function signerFromEnv(name: KeyVariable, env: NodeJS.ProcessEnv = process.env): Promise<KeyPairSigner> {
    let bytes: unknown;
    try {
        bytes = JSON.parse(env[name] ?? '');
    } catch {
        // reported below without the value
    }
    if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every(b => Number.isInteger(b) && b >= 0 && b < 256)) {
        throw new Error(`${name} is not a JSON array of 64 bytes`);
    }
    return createKeyPairSignerFromBytes(new Uint8Array(bytes));
}

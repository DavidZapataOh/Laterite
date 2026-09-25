import { createHash, createPrivateKey, type JsonWebKey } from 'node:crypto';

import { type Address, getBase58Decoder } from '@solana/kit';

/** An Ed25519 private key in PKCS #8 is this prefix and the 32-byte seed. */
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

export type TestKey = { address: Address; jwk: JsonWebKey };

/** A test-only wallet key derived from `name`, so the validator's accounts and the tests agree on its address. */
export function testKey(name: string): TestKey {
    const seed = createHash('sha256').update(`laterite-app-e2e:${name}`).digest();
    const jwk = createPrivateKey({ format: 'der', key: Buffer.concat([PKCS8_ED25519, seed]), type: 'pkcs8' }).export({
        format: 'jwk',
    });
    return { address: getBase58Decoder().decode(Buffer.from(jwk.x!, 'base64url')) as Address, jwk };
}

/** A key as the Solana CLI writes a keypair file: its 32-byte seed then its public key, as a JSON array. */
export function keypairJson({ jwk }: TestKey): string {
    return JSON.stringify([...Buffer.from(jwk.d!, 'base64url'), ...Buffer.from(jwk.x!, 'base64url')]);
}

/** The tests' own faucet: mint authority of the test validator's stand-in USDC and USDT, never a devnet key. */
export const faucet = testKey('faucet');

/**
 * The wallets that declared eligibility before the tests: enrolled and active, enrolled and paused, and exited, whose
 * `UserConfig` the validator holds; a newcomer, who never enrolled and holds no test dollars; a holder with USDC and
 * USDT accounts; and one whose USDC account already approves another program.
 */
export const users = {
    active: testKey('active'),
    delegated: testKey('delegated'),
    exited: testKey('exited'),
    holder: testKey('holder'),
    newcomer: testKey('newcomer'),
    paused: testKey('paused'),
};

/** Enrollment of every genesis user: 2026-09-20 14:00 UTC. */
export const ENROLLED_AT = 1_789_912_800n;

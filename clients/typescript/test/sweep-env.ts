import { addresses as devnet, type PoolInfo } from '@laterite/devnet/addresses';
import { type Address, generateKeyPairSigner, getAddressEncoder, signBytes } from '@solana/kit';
import { getCreateAssociatedTokenIdempotentInstructionAsync, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';

import { findSwapAuthorityPda, PYTH_PRO_PROGRAM_ADDRESS, PYTH_STORAGE_ADDRESS, type Quote } from '../src';
import { addPlans, defaultParams, enrolled, type Env, initialize, setup, validParams } from './env';
import { fixture, PYTH, PYTH_SPYX_QUOTE, PYTH_UPDATES_AT, seeded } from './fixtures';

const tokens = devnet.tokens;
const POOL_DEPTH = 1_000n * 100_000_000n;

const loadDevnetAccount = (env: Env, address: Address, owner: Address) =>
    env.write(address, new Uint8Array(fixture(`devnet/${address}.bin`)), owner);

/** The committed copies of the devnet mints, CPMM and pools, and a cluster's Pyth Pro with a funded treasury. */
function loadDevnet(env: Env, pyth: (typeof PYTH)['devnet']) {
    loadDevnetAccount(env, devnet.cpmm.ammConfig, devnet.cpmm.program);
    for (const symbol of ['SPYx', 'QQQx', 'USDC', 'USDT'] as const) {
        loadDevnetAccount(env, tokens[symbol].mint, tokens[symbol].tokenProgram);
    }
    for (const name of ['SPYx-USDC', 'SPYx-USDT', 'QQQx-USDC'] as const) {
        const pool = devnet.pools[name];
        const assetVault = pool.token0Mint === tokens[pool.base].mint ? pool.token0Vault : pool.token1Vault;
        const paymentVault = assetVault === pool.token0Vault ? pool.token1Vault : pool.token0Vault;
        loadDevnetAccount(env, pool.address, devnet.cpmm.program);
        loadDevnetAccount(env, pool.observation, devnet.cpmm.program);
        loadDevnetAccount(env, assetVault, TOKEN_2022_PROGRAM_ADDRESS);
        loadDevnetAccount(env, paymentVault, TOKEN_PROGRAM_ADDRESS);
    }
    env.svm.addProgram(devnet.cpmm.program, fixture('cpmm.so'));
    env.svm.addProgram(PYTH_PRO_PROGRAM_ADDRESS, fixture(pyth.program));
    env.write(PYTH_STORAGE_ADDRESS, new Uint8Array(fixture(pyth.storage)), PYTH_PRO_PROGRAM_ADDRESS);
    env.airdrop(pyth.treasury, 1_000_000_000n);
}

/** Prices `pool` at `price` per whole asset token: accrued fees cleared, then the vault balances set. */
export function peg(env: Env, pool: PoolInfo, price: Quote) {
    const state = env.data(pool.address);
    for (const offset of [341, 349, 357, 365, 397, 405]) state.fill(0, offset, offset + 8);
    env.write(pool.address, state, devnet.cpmm.program);
    const assetVault = pool.token0Mint === tokens[pool.base].mint ? pool.token0Vault : pool.token1Vault;
    const paymentVault = assetVault === pool.token0Vault ? pool.token1Vault : pool.token0Vault;
    env.setTokenAmount(assetVault, POOL_DEPTH);
    env.setTokenAmount(paymentVault, (POOL_DEPTH * price.price) / 10n ** 10n);
}

/**
 * The program tests' `sweep_env`: the devnet copies, a user `[11; 32]` enrolled with `params`, the swap authority's
 * payment accounts, the clock at the real updates' time and each pool at its asset's price in them, a funded crank.
 */
export async function sweepEnv(params = defaultParams(), pyth: keyof typeof PYTH = 'devnet') {
    const env = await setup();
    loadDevnet(env, PYTH[pyth]);
    await initialize(env, await validParams());
    await addPlans(env);
    const [swapAuthority] = await findSwapAuthorityPda();
    for (const symbol of ['USDC', 'USDT'] as const) {
        const create = await getCreateAssociatedTokenIdempotentInstructionAsync({
            mint: tokens[symbol].mint,
            owner: swapAuthority,
            payer: env.authority,
            tokenProgram: tokens[symbol].tokenProgram,
        });
        await env.expectSuccess(env.send(env.authority, [create]));
    }
    const user = await seeded(11);
    await enrolled(env, user, params);
    env.setNow(PYTH_UPDATES_AT);
    for (const name of ['SPYx-USDC', 'SPYx-USDT', 'QQQx-USDC'] as const) {
        const qqqx = { confidence: 40_282_152n, exponent: -8, price: 74_597_430_644n };
        peg(env, devnet.pools[name], name.startsWith('SPYx') ? PYTH_SPYX_QUOTE : qqqx);
    }
    const crank = await generateKeyPairSigner();
    env.airdrop(crank.address);
    return { crank, env, user };
}

/** The key the sweep tests' Pyth Pro storage also trusts, for updates composed at a chosen time. */
export const pythTestSigner = () => seeded(5);

/** Adds `signer` to the LiteSVM copy of Pyth Pro's storage as a trusted key. Test only: clusters trust Pyth's keys. */
export function trust(env: Env, signer: Address) {
    const storage = env.data(PYTH_STORAGE_ADDRESS);
    // Storage: the trusted-signer count at 80, then 40-byte slots of public key and expiry.
    const slot = 81 + 40 * storage[80]!;
    storage[80]! += 1;
    storage.set(getAddressEncoder().encode(signer), slot);
    new DataView(storage.buffer).setBigInt64(slot + 32, 2n ** 63n - 1n, true);
    env.write(PYTH_STORAGE_ADDRESS, storage, PYTH_PRO_PROGRAM_ADDRESS);
}

/** A Solana-format update composed for a test: `feeds` updated at `at`, signed by {@link pythTestSigner}. */
export async function pythUpdate(at: bigint, feeds: [number, Quote][]): Promise<Uint8Array> {
    const payload: number[] = [];
    const push = (bytes: ArrayLike<number>) => payload.push(...Array.from(bytes));
    const le = (value: bigint, size: number) =>
        Array.from({ length: size }, (_, i) => Number((value >> BigInt(8 * i)) & 0xffn));
    const micros = le(at * 1_000_000n, 8);
    push(le(2_479_346_549n, 4));
    push(micros);
    push([3, feeds.length]);
    for (const [id, { confidence, exponent, price }] of feeds) {
        push(le(BigInt(id), 4));
        push([4, 0]);
        push(le(price, 8));
        push([4]);
        push(le(BigInt.asUintN(16, BigInt(exponent)), 2));
        push([5]);
        push(le(confidence, 8));
        push([12, 1]);
        push(micros);
    }
    const signer = await pythTestSigner();
    const bytes = new Uint8Array(payload);
    const signature = await signBytes(signer.keyPair.privateKey, bytes);
    return new Uint8Array([
        ...le(2_182_742_457n, 4),
        ...signature,
        ...getAddressEncoder().encode(signer.address),
        ...le(BigInt(bytes.length), 2),
        ...bytes,
    ]);
}

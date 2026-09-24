import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
    ATTESTATION_TTL_SECONDS,
    Engine,
    findUserConfigPda,
    getUserConfigEncoder,
    LATERITE_PROGRAM_ADDRESS,
    PYTH_PRO_PROGRAM_ADDRESS,
    PYTH_STORAGE_ADDRESS,
    UserStatus,
} from '@laterite/client';
import { addresses as devnet } from '@laterite/devnet/addresses';
import {
    type Address,
    createKeyPairSignerFromPrivateKeyBytes,
    getAddressEncoder,
    getBase64Decoder,
    type KeyPairSigner,
    some,
    unwrapOption,
} from '@solana/kit';
import { findAssociatedTokenPda } from '@solana-program/token';
import { getMintDecoder, getMintEncoder } from '@solana-program/token-2022';

const root = new URL('../../../../', import.meta.url);
const fixture = (name: string) => readFile(new URL(`programs/laterite/tests/fixtures/${name}`, root));
const SUBSCRIPTIONS_PROGRAM = 'De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44';
const PYTH_TREASURY = 'opsLibxVY7Vz5eYMmSfX8cLFCFVYTtH6fr6MiifMpA7' as Address;

/**
 * The local validator's RPC port (its WebSocket on the next one), clear of Agave's and Surfpool's defaults; its other
 * ports follow it, so runs on ports 100 apart never meet.
 */
export const RPC_PORT = Number(process.env.VALIDATOR_RPC_PORT ?? 28_899);
const GOSSIP_PORT = RPC_PORT + 2;
const DYNAMIC_PORTS = `${RPC_PORT + 3}-${RPC_PORT + 60}`;
const FAUCET_PORT = RPC_PORT + 61;

const DOLLAR = 1_000_000n;
/** The pools' depth in the asset, 1,000 whole tokens, as the program tests peg them. */
const POOL_DEPTH = 1_000n * 100_000_000n;
/** SPYx in Pyth Pro's units (price × 10^exponent dollars per 10^8 raw units), as the real update of the program tests. */
export const SPYX_QUOTE = { confidence: 30_532_893n, exponent: -8, price: 77_847_155_496n };

/** A signer from a 32-byte seed filled with `byte`, as the program tests' `Keypair::new_from_array([byte; 32])`. */
const signers = new Map<number, Promise<KeyPairSigner>>();
function seeded(byte: number): Promise<KeyPairSigner> {
    let signer = signers.get(byte);
    if (!signer) signers.set(byte, (signer = createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(byte))));
    return signer;
}

/** The chain's keys: every one test-only, derived from a seed. */
export const keys = {
    attestor: () => seeded(8),
    authority: () => seeded(1),
    crank: () => seeded(9),
    /** SPYx's multiplier authority here, in place of the devnet issuer. */
    issuer: () => seeded(3),
    /** Signs the price updates the tests compose; the local Pyth Pro storage trusts it. */
    pythSigner: () => seeded(5),
    sponsor: () => seeded(7),
    /** Holds USDC and USDT from genesis. */
    users: () => Promise.all([seeded(11), seeded(12)]),
    /** Enrolled eight days before genesis with the income rule on, so its attestations can expire and close here. */
    veteran: () => seeded(13),
};

type GenesisAccount = { address: Address; data: Uint8Array; lamports?: bigint; owner: Address };

const account = ({ address, data, lamports = 1_000_000_000n, owner }: GenesisAccount) => ({
    account: {
        data: [getBase64Decoder().decode(data), 'base64'],
        executable: false,
        lamports: Number(lamports),
        owner,
        rentEpoch: 0,
        space: data.length,
    },
    pubkey: address,
});

const u64 = (data: Uint8Array, offset: number, value: bigint) =>
    new DataView(data.buffer, data.byteOffset).setBigUint64(offset, value, true);

/** An initialized token account without extensions. */
function tokenAccount(mint: Address, owner: Address, amount: bigint) {
    const data = new Uint8Array(165);
    data.set(getAddressEncoder().encode(mint), 0);
    data.set(getAddressEncoder().encode(owner), 32);
    u64(data, 64, amount);
    data[108] = 1;
    return data;
}

/**
 * The genesis accounts: devnet's mints (SPYx's multiplier authority the tests' issuer), CPMM config and SPYx pools from
 * the committed copies with each pool at {@link SPYX_QUOTE}, Pyth Pro's devnet storage also trusting the tests' price
 * signer, the users' dollars, and the veteran's `UserConfig`.
 */
async function genesisAccounts(now: bigint): Promise<GenesisAccount[]> {
    const { tokens, pools, cpmm } = devnet;
    const copy = async (address: Address, owner: Address) => ({
        address,
        data: new Uint8Array(await fixture(`devnet/${address}.bin`)),
        owner,
    });
    const accounts: GenesisAccount[] = [await copy(cpmm.ammConfig, cpmm.program)];
    for (const symbol of ['SPYx', 'QQQx', 'USDC', 'USDT'] as const) {
        accounts.push(await copy(tokens[symbol].mint, tokens[symbol].tokenProgram));
    }
    const spyx = accounts.find(({ address }) => address === tokens.SPYx.mint)!;
    const mint = getMintDecoder().decode(spyx.data);
    const issuer = (await keys.issuer()).address;
    const extensions = unwrapOption(mint.extensions)!.map(extension =>
        extension.__kind === 'ScaledUiAmountConfig' ? { ...extension, authority: issuer } : extension,
    );
    spyx.data = new Uint8Array(getMintEncoder().encode({ ...mint, extensions: some(extensions) }));
    for (const name of ['SPYx-USDC', 'SPYx-USDT'] as const) {
        const pool = pools[name];
        const state = await copy(pool.address, cpmm.program);
        // Accrued protocol and fund fees, which the CPMM leaves out of its reserves.
        for (const offset of [341, 349, 357, 365, 397, 405]) state.data.fill(0, offset, offset + 8);
        accounts.push(state, await copy(pool.observation, cpmm.program));
        const assetVault = pool.token0Mint === tokens.SPYx.mint ? pool.token0Vault : pool.token1Vault;
        const paymentVault = assetVault === pool.token0Vault ? pool.token1Vault : pool.token0Vault;
        for (const [vault, amount] of [
            [assetVault, POOL_DEPTH],
            [paymentVault, (POOL_DEPTH * SPYX_QUOTE.price) / 10n ** 10n],
        ] as const) {
            const copied = await copy(
                vault,
                vault === assetVault ? tokens.SPYx.tokenProgram : tokens[pool.quote].tokenProgram,
            );
            u64(copied.data, 64, amount);
            accounts.push(copied);
        }
    }
    const storage = new Uint8Array(await fixture('pyth_storage_devnet.bin'));
    // Storage: the trusted-signer count at 80, then 40-byte slots of public key and expiry.
    const slot = 81 + 40 * storage[80]!;
    storage[80]! += 1;
    storage.set(getAddressEncoder().encode((await keys.pythSigner()).address), slot);
    new DataView(storage.buffer).setBigInt64(slot + 32, 2n ** 63n - 1n, true);
    accounts.push({ address: PYTH_STORAGE_ADDRESS, data: storage, owner: PYTH_PRO_PROGRAM_ADDRESS });
    accounts.push({
        address: PYTH_TREASURY,
        data: new Uint8Array(),
        owner: '11111111111111111111111111111111' as Address,
    });
    for (const user of await keys.users()) {
        for (const symbol of ['USDC', 'USDT'] as const) {
            const { mint, tokenProgram } = tokens[symbol];
            const [ata] = await findAssociatedTokenPda({ mint, owner: user.address, tokenProgram });
            accounts.push({ address: ata, data: tokenAccount(mint, user.address, 100n * DOLLAR), owner: tokenProgram });
        }
    }
    const veteran = await keys.veteran();
    const [userConfig, bump] = await findUserConfigPda({ user: veteran.address });
    const enrolledAt = now - ATTESTATION_TTL_SECONDS - 86_400n;
    accounts.push({
        address: userConfig,
        data: new Uint8Array(
            getUserConfigEncoder().encode({
                asset: 0,
                attestableFrom: enrolledAt,
                bump,
                changeMultiplier: 0,
                cushions: [0n, 0n],
                engine: Engine.Daily,
                engineAmount: 0n,
                engineRanAt: enrolledAt - 1n,
                enrolledAt,
                goalAmount: 0n,
                goalLabel: new Uint8Array(32),
                incomeRule: true,
                lastSweepDay: [0, 0],
                paymentTokens: 0b01,
                pending: 0n,
                status: UserStatus.Active,
                tier: 0,
                user: veteran.address,
                week: 0,
                weekSpent: 0n,
            }),
        ),
        owner: LATERITE_PROGRAM_ADDRESS,
    });
    return accounts;
}

export type Validator = { rpcUrl: string; stop: () => Promise<void>; wsUrl: string };

/**
 * Starts a new chain on Agave's test validator with Laterite (its upgrade authority the tests' key), the programs it
 * calls (Subscriptions, Pyth Pro and the CPMM, from the committed fixtures) and {@link genesisAccounts}, offline.
 */
export async function startValidator(): Promise<Validator> {
    const dir = await mkdtemp(join(tmpdir(), 'laterite-validator-'));
    const accountDir = join(dir, 'accounts');
    await mkdir(accountDir);
    for (const entry of await genesisAccounts(BigInt(Math.floor(Date.now() / 1_000)))) {
        await writeFile(join(accountDir, `${entry.address}.json`), JSON.stringify(account(entry)));
    }
    const fixtures = fileURL('programs/laterite/tests/fixtures/');
    const args = [
        '--reset',
        '--quiet',
        '--ledger',
        join(dir, 'ledger'),
        '--rpc-port',
        String(RPC_PORT),
        '--faucet-port',
        String(FAUCET_PORT),
        '--gossip-port',
        String(GOSSIP_PORT),
        '--dynamic-port-range',
        DYNAMIC_PORTS,
        '--upgradeable-program',
        LATERITE_PROGRAM_ADDRESS,
        fileURL('target/deploy/laterite.so'),
        (await keys.authority()).address,
        '--bpf-program',
        SUBSCRIPTIONS_PROGRAM,
        `${fixtures}subscriptions.so`,
        '--bpf-program',
        PYTH_PRO_PROGRAM_ADDRESS,
        `${fixtures}pyth_pro_devnet.so`,
        '--bpf-program',
        devnet.cpmm.program,
        `${fixtures}cpmm.so`,
        '--account-dir',
        accountDir,
    ];
    const validator: ChildProcess = spawn('solana-test-validator', args, { stdio: 'ignore' });
    const rpcUrl = `http://127.0.0.1:${RPC_PORT}`;
    const exited = new Promise(resolve => validator.once('exit', resolve));
    const stop = async () => {
        validator.kill('SIGTERM');
        await exited;
        await rm(dir, { force: true, recursive: true });
    };
    for (let attempt = 0; attempt < 120; attempt++) {
        if (validator.exitCode !== null) break;
        const healthy = await fetch(rpcUrl, {
            body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'getHealth' }),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
        })
            .then(response => response.ok)
            .catch(() => false);
        if (healthy) return { rpcUrl, stop, wsUrl: `ws://127.0.0.1:${RPC_PORT + 1}` };
        await sleep(500);
    }
    await stop();
    throw new Error(`solana-test-validator did not start on port ${RPC_PORT}`);
}

function fileURL(path: string) {
    return new URL(path, root).pathname;
}

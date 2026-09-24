import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

import {
    findConfigPda,
    findPlanAddress,
    findSwapAuthorityPda,
    getConfigSize,
    LATERITE_PROGRAM_ADDRESS,
} from '@laterite/client';
import { createClient } from '@laterite/devnet';
import { addresses as devnet } from '@laterite/devnet/addresses';
import {
    type Address,
    address,
    type Base58EncodedBytes,
    fetchEncodedAccount,
    fetchEncodedAccounts,
    getAddressEncoder,
    getBase58Decoder,
    getProgramDerivedAddress,
    getUtf8Encoder,
    type ReadonlyUint8Array,
} from '@solana/kit';
import { PLAN_SIZE } from '@solana/subscriptions';
import { findAssociatedTokenPda } from '@solana-program/token';

import { deploymentFile, readDeploymentRecord } from '../src';

// Read-only: what a deployment run, or an upgrade to a new build, needs from the upgrade authority and the issuer at
// the cluster's current rent, and the conditions it relies on. Exits non-zero when anything is missing.

const LOADER = address('BPFLoaderUpgradeab1e11111111111111111111111');
const PROGRAM_METADATA = address('ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S');
const VERIFIER = address('verifycLy8mB96wd9wqq3WDXQwM4oU6r42Th37Db9fC');
const DISABLE_SBPF_V0_V1_V2_DEPLOYMENT = address('B8JJXCy5amZyWG9r7EnUYLwzXSXTxG7GZ1qZ1qggo83g');
// Program data and buffer headers, a program account, a token account, the table's header and each address, the
// Program Metadata header, and the verification PDA as solana-verify 0.5.2 writes it for this repository.
const PROGRAM_DATA_HEADER = 45;
const BUFFER_HEADER = 37;
const PROGRAM_ACCOUNT = 36;
const TOKEN_ACCOUNT = 165;
const LOOKUP_TABLE = 56 + 32 * 17;
const METADATA_HEADER = 96;
const VERIFICATION_PDA = 229;
// The base fee and a priority fee per transaction; about 1,000 bytes of program per write.
const FEE = 6_000n;
const WRITE_BYTES = 1_000;
const SPONSOR_MINIMUM = 500_000_000n;
const SPONSOR_FUNDING = 1_000_000_000n;

const env = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return address(value);
};
const { rpc } = createClient();
const encoder = getAddressEncoder();
const base58 = (bytes: ReadonlyUint8Array) => getBase58Decoder().decode(bytes) as Base58EncodedBytes;
const rent = async (space: number) => await rpc.getMinimumBalanceForRentExemption(BigInt(space)).send();
const sol = (lamports: bigint) => (Number(lamports) / 1e9).toFixed(4);
const problems: string[] = [];

/** `solana-verify`'s executable hash: the SHA-256 of a program's bytes without the zero padding after them. */
function executableHash(bytes: ReadonlyUint8Array) {
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end -= 1;
    return createHash('sha256').update(bytes.subarray(0, end)).digest('hex');
}

/** The executable hash the cluster runs at `program` and the bytes its program data holds, or `null` without one. */
async function running(program: Address) {
    const [programData] = await getProgramDerivedAddress({ programAddress: LOADER, seeds: [encoder.encode(program)] });
    const account = await fetchEncodedAccount(rpc, programData);
    if (!account.exists) return null;
    const bytes = account.data.subarray(PROGRAM_DATA_HEADER);
    return { capacity: bytes.length, hash: executableHash(bytes) };
}

/** The loader buffers `authority` holds other than `kept`, the one a rerun resumes. */
async function strayBuffers(authority: Address, kept: string | undefined) {
    const buffers = await rpc
        .getProgramAccounts(LOADER, {
            dataSlice: { length: 0, offset: 0 },
            encoding: 'base64',
            filters: [
                { memcmp: { bytes: base58(new Uint8Array([1, 0, 0, 0])), encoding: 'base58', offset: 0n } },
                {
                    memcmp: {
                        bytes: base58(new Uint8Array([1, ...encoder.encode(authority)])),
                        encoding: 'base58',
                        offset: 4n,
                    },
                },
            ],
        })
        .send();
    return buffers.map(({ pubkey }) => pubkey).filter(pubkey => pubkey !== kept);
}

/** Prints what `payer` needs for `items` and records a problem when its balance does not cover it with a 10% margin. */
async function requireBalance(payer: string, key: Address, items: [string, bigint][]) {
    const total = items.reduce((sum, [, lamports]) => sum + lamports, 0n);
    const needed = total + total / 10n;
    const balance = (await rpc.getBalance(key).send()).value;
    console.log(`${payer} ${key}: needs ${sol(needed)} SOL with a 10% margin, holds ${sol(balance)}`);
    for (const [item, lamports] of items) console.log(`  ${sol(lamports).padStart(10)}  ${item}`);
    if (balance < needed) problems.push(`${payer} is ${sol(needed - balance)} SOL short`);
}

const record = await readDeploymentRecord(deploymentFile());
const authority = env('DEVNET_AUTHORITY');
const issuer = env('DEVNET_ISSUER');
const sponsor = env('DEVNET_SPONSOR');
const buffers = { cpmm: process.env.DEVNET_CPMM_BUFFER, laterite: process.env.DEVNET_LATERITE_BUFFER };

const feature = await fetchEncodedAccount(rpc, DISABLE_SBPF_V0_V1_V2_DEPLOYMENT);
if (feature.exists && feature.data[0] === 1) {
    problems.push('SIMD-0500 is active: the SBPF v0 CPMM can no longer be upgraded');
}

const root = new URL('../../../', import.meta.url);
const program = new Uint8Array(await readFile(new URL('target/deploy/laterite.so', root)));
const cpmm = new Uint8Array(await readFile(new URL('target/cp-swap/target/deploy/raydium_cp_swap.so', root)));
const build = executableHash(program);
const [programRunning, cpmmRunning] = await Promise.all([
    running(LATERITE_PROGRAM_ADDRESS),
    running(devnet.cpmm.program),
]);
if (programRunning && programRunning.hash !== build) {
    console.log(`${LATERITE_PROGRAM_ADDRESS} runs ${programRunning.hash}: the deploy upgrades it to ${build}`);
}
for (const [holder, kept] of [
    [authority, buffers.laterite],
    [issuer, buffers.cpmm],
] as const) {
    const stray = await strayBuffers(holder, kept);
    if (stray.length > 0) problems.push(`${holder} holds other buffers (close them first): ${stray.join(', ')}`);
}

const [[config], [swapAuthority]] = await Promise.all([findConfigPda(), findSwapAuthorityPda()]);
const plans = await Promise.all([0, 1].flatMap(token => [0, 1].map(tier => findPlanAddress(token, tier))));
const swapAccounts = await Promise.all(
    [devnet.tokens.USDC, devnet.tokens.USDT].map(
        async ({ mint, tokenProgram }) =>
            (await findAssociatedTokenPda({ mint, owner: swapAuthority, tokenProgram }))[0],
    ),
);
const [verification] = await getProgramDerivedAddress({
    programAddress: VERIFIER,
    seeds: [
        getUtf8Encoder().encode('otter_verify'),
        encoder.encode(authority),
        encoder.encode(LATERITE_PROGRAM_ADDRESS),
    ],
});
const [configAccount, verificationAccount, tableAccount, ...rest] = await fetchEncodedAccounts(rpc, [
    config,
    verification,
    record?.lookupTable ?? config,
    ...plans,
    ...swapAccounts,
]);
const missingPlans = rest.slice(0, 4).filter(account => !account.exists).length;
const missingSwapAccounts = rest.slice(4).filter(account => !account.exists).length;
const metadata = await rpc
    .getProgramAccounts(PROGRAM_METADATA, {
        dataSlice: { length: 0, offset: 0 },
        encoding: 'base64',
        filters: [
            { memcmp: { bytes: base58(encoder.encode(LATERITE_PROGRAM_ADDRESS)), encoding: 'base58', offset: 1n } },
        ],
    })
    .send();
const idl = deflateSync(await readFile(new URL('idl/laterite.json', root))).length;
const sponsorBalance = (await rpc.getBalance(sponsor).send()).value;
const keptBuffer = buffers.laterite ? await fetchEncodedAccount(rpc, address(buffers.laterite)) : null;

const items: [string, bigint][] = [];
if (!programRunning) {
    const size = program.length;
    items.push([`program data (${size + PROGRAM_DATA_HEADER} bytes), kept`, await rent(size + PROGRAM_DATA_HEADER)]);
    if (!keptBuffer?.exists) {
        items.push([`buffer (${size + BUFFER_HEADER} bytes), returned`, await rent(size + BUFFER_HEADER)]);
    }
    items.push(['program account', await rent(PROGRAM_ACCOUNT)]);
    items.push(['upload fees', BigInt(Math.ceil(size / WRITE_BYTES) + 3) * FEE]);
} else if (programRunning.hash !== build) {
    const size = program.length;
    if (!keptBuffer?.exists) {
        items.push([`upgrade buffer (${size + BUFFER_HEADER} bytes), returned`, await rent(size + BUFFER_HEADER)]);
    }
    if (size > programRunning.capacity) {
        const extension =
            (await rent(size + PROGRAM_DATA_HEADER)) - (await rent(programRunning.capacity + PROGRAM_DATA_HEADER));
        items.push([`program data extension (${size - programRunning.capacity} bytes), kept`, extension]);
    }
    items.push(['upload fees', BigInt(Math.ceil(size / WRITE_BYTES) + 3) * FEE]);
    if (verificationAccount!.exists) items.push(['verification PDA update', FEE]);
}
if (!configAccount!.exists) items.push(['config', await rent(getConfigSize())]);
if (missingPlans > 0) items.push([`${missingPlans} plans`, BigInt(missingPlans) * (await rent(PLAN_SIZE))]);
if (missingSwapAccounts > 0) {
    const lamports = BigInt(missingSwapAccounts) * (await rent(TOKEN_ACCOUNT));
    items.push([`${missingSwapAccounts} swap-authority accounts`, lamports]);
}
if (!record?.lookupTable || !tableAccount!.exists) items.push(['onboarding lookup table', await rent(LOOKUP_TABLE)]);
items.push(['configuration fees', 8n * FEE]);
if (sponsorBalance < SPONSOR_MINIMUM) items.push(['sponsor funding', SPONSOR_FUNDING - sponsorBalance]);
if (metadata.length === 0) {
    items.push([`IDL (${METADATA_HEADER + idl} bytes) and its fees`, (await rent(METADATA_HEADER + idl)) + 20n * FEE]);
}
if (!verificationAccount!.exists) items.push(['verification PDA', (await rent(VERIFICATION_PDA)) + FEE]);
items.push(["smoke: two wallets' token accounts and fees", 2n * (await rent(TOKEN_ACCOUNT)) + 8n * FEE]);
await requireBalance('Upgrade authority', authority, items);

if (cpmmRunning?.hash === executableHash(cpmm)) {
    console.log(`Issuer ${issuer}: the CPMM already runs the build`);
} else {
    const size = cpmm.length;
    await requireBalance('Issuer', issuer, [
        [`CPMM upgrade buffer (${size + BUFFER_HEADER} bytes), returned`, await rent(size + BUFFER_HEADER)],
        ['upload fees', BigInt(Math.ceil(size / WRITE_BYTES) + 3) * FEE],
    ]);
}

if (problems.length > 0) {
    for (const problem of problems) console.error(`✗ ${problem}`);
    process.exit(1);
}
console.log('✓ Preflight passed');

import { createHash } from 'node:crypto';

import {
    fetchConfig,
    fetchPythStorage,
    findPlanAddress,
    findSwapAuthorityPda,
    findVaultPda,
    getConfigParamsEncoder,
    getLateriteLogEvents,
    getOnboardingLookupTableAddresses,
    getPythEd25519Instruction,
    LATERITE_PROGRAM_ADDRESS,
    MARKET_CALENDAR_SET_EVENT_DISCRIMINATOR,
    parseMarketCalendarSetEvent,
    PLAN_PERIOD_HOURS,
    PYTH_PRO_PROGRAM_ADDRESS,
    PYTH_STORAGE_ADDRESS,
    TIERS,
} from '@laterite/client';
import {
    AccountRole,
    type Address,
    address,
    appendTransactionMessageInstructions,
    compileTransaction,
    containsBytes,
    createNoopSigner,
    createTransactionMessage,
    fetchEncodedAccount,
    getAddressEncoder,
    getBase64EncodedWireTransaction,
    getProgramDerivedAddress,
    type Instruction,
    isNone,
    pipe,
    type ReadonlyUint8Array,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import { fetchPlan } from '@solana/subscriptions';
import { fetchAddressLookupTable } from '@solana-program/address-lookup-table';
import { SYSTEM_PROGRAM_ADDRESS } from '@solana-program/system';
import { fetchToken, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { describe, expect, it } from 'vitest';

import { devnetConfigParams, isMarketCalendarLoaded, MARKET_CALENDAR_FILE, readMarketCalendar } from '../../src';
import { client, deployment, read } from './context';

const { rpc } = client;
const LOADER = address('BPFLoaderUpgradeab1e11111111111111111111111');
const SBPF_V3_FEATURE = address('5cC3foj77CWun58pC51ebHFUWavHWKarWyR5UUik7dnC');
const TRANSACTION_V1_FEATURE = address('txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL');
const PYTH_MAINNET_SIGNER = address('9gKEEcFzSd1PDYBKWAKZi4Sq4ZCUaVX5oTr8kEjdwsfR');
const DEVNET_PYTH_TREASURY = address('opsLibxVY7Vz5eYMmSfX8cLFCFVYTtH6fr6MiifMpA7');
const INSTRUCTIONS_SYSVAR = address('Sysvar1nstructions1111111111111111111111111');
const VERIFY_MESSAGE = [180, 193, 120, 55, 189, 135, 203, 83];

const config = (await fetchConfig(rpc, deployment.config)).data;

/** `solana-verify`'s executable hash: the SHA-256 of a program's bytes without the zero padding after them. */
function executableHash(bytes: ReadonlyUint8Array) {
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end -= 1;
    return createHash('sha256').update(bytes.subarray(0, end)).digest('hex');
}

/** Pyth Pro's `verify_message` for an update in its own data, signature entry `signatureIndex` of instruction 0. */
function verifyMessage(payer: Address, treasury: Address, message: ReadonlyUint8Array, signatureIndex: number) {
    const data = new Uint8Array(8 + 4 + message.length + 3);
    data.set(VERIFY_MESSAGE);
    new DataView(data.buffer).setUint32(8, message.length, true);
    data.set(message, 12);
    data[data.length - 1] = signatureIndex;
    return {
        accounts: [
            { address: payer, role: AccountRole.WRITABLE_SIGNER },
            { address: PYTH_STORAGE_ADDRESS, role: AccountRole.READONLY },
            { address: treasury, role: AccountRole.WRITABLE },
            { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
            { address: INSTRUCTIONS_SYSVAR, role: AccountRole.READONLY },
        ],
        data,
        programAddress: PYTH_PRO_PROGRAM_ADDRESS,
    } satisfies Instruction;
}

/** Simulates `instructions` paid by the upgrade authority, unsigned, and returns the treasury's balance after. */
async function simulate(instructions: Instruction[], treasury: Address) {
    const { value: blockhash } = await rpc.getLatestBlockhash().send();
    const transaction = compileTransaction(
        pipe(
            createTransactionMessage({ version: 0 }),
            message => setTransactionMessageFeePayerSigner(createNoopSigner(deployment.upgradeAuthority), message),
            message => setTransactionMessageLifetimeUsingBlockhash(blockhash, message),
            message => appendTransactionMessageInstructions(instructions, message),
        ),
    );
    const { value } = await rpc
        .simulateTransaction(getBase64EncodedWireTransaction(transaction), {
            accounts: { addresses: [treasury], encoding: 'base64' },
            encoding: 'base64',
            replaceRecentBlockhash: true,
            sigVerify: false,
        })
        .send();
    expect(value.err, JSON.stringify(value.logs)).toBeNull();
    return value.accounts[0]!.lamports;
}

describe('deployment', () => {
    it('runs on a cluster with SBPF v3 programs and version 1 transactions active', async () => {
        for (const id of [SBPF_V3_FEATURE, TRANSACTION_V1_FEATURE]) {
            const feature = await fetchEncodedAccount(rpc, id);
            expect(feature.exists && feature.data[0], id).toBe(1);
        }
    });

    it('runs the verifiable build, upgradeable by the recorded authority', async () => {
        const [programData] = await getProgramDerivedAddress({
            programAddress: LOADER,
            seeds: [getAddressEncoder().encode(LATERITE_PROGRAM_ADDRESS)],
        });
        const account = await fetchEncodedAccount(rpc, programData);
        if (!account.exists) throw new Error('The program is not deployed');
        expect(account.data[12]).toBe(1);
        expect(account.data.subarray(13, 45)).toEqual(getAddressEncoder().encode(deployment.upgradeAuthority));
        expect(executableHash(account.data.subarray(45))).toBe(executableHash(read('target/deploy/laterite.so')));
    });

    it('holds the committed configuration, bound to this cluster', async () => {
        const genesisHash = await rpc.getGenesisHash().send();
        expect(genesisHash).toBe(deployment.genesisHash);
        const params = devnetConfigParams({ attestor: deployment.attestor, genesisHash, sponsor: deployment.sponsor });
        const stored = { ...config, settings: config };
        expect(getConfigParamsEncoder().encode(stored)).toEqual(getConfigParamsEncoder().encode(params));
        expect([config.admin, config.paused, config.pendingAdmin]).toEqual([
            deployment.admin,
            false,
            SYSTEM_PROGRAM_ADDRESS,
        ]);
        expect(deployment.upgradeAuthority).not.toBe(deployment.attestor);
        expect(deployment.upgradeAuthority).not.toBe(deployment.sponsor);
    });

    it('holds the NYSE calendar file, set by the recorded MarketCalendarSet', async () => {
        const calendar = await readMarketCalendar(MARKET_CALENDAR_FILE);
        expect(isMarketCalendarLoaded(config.marketCalendar, calendar)).toBe(true);
        if (!deployment.marketCalendarSet) throw new Error('No MarketCalendarSet recorded');
        const transaction = await rpc
            .getTransaction(deployment.marketCalendarSet, { encoding: 'json', maxSupportedTransactionVersion: 1 })
            .send();
        expect(transaction?.meta?.err).toBeNull();
        const [event] = getLateriteLogEvents(transaction?.meta?.logMessages ?? [])
            .filter(data => containsBytes(data, MARKET_CALENDAR_SET_EVENT_DISCRIMINATOR, 0))
            .map(parseMarketCalendarSetEvent);
        const from = config.marketCalendar.firstDay;
        expect(event?.holidays).toEqual(calendar.holidays.filter(day => day >= from));
        expect(event?.earlyCloses).toEqual(calendar.earlyCloses.filter(day => day >= from));
        expect(event?.validThrough).toBe(calendar.validThrough);
    });

    it('has the four plans, owned by the vault and paying only the swap authority', async () => {
        const [[vault], [swapAuthority]] = await Promise.all([findVaultPda(), findSwapAuthorityPda()]);
        for (const [paymentToken, token] of config.paymentTokens.entries()) {
            for (const [tier, amount] of TIERS.entries()) {
                const { data: plan } = await fetchPlan(rpc, await findPlanAddress(paymentToken, tier));
                expect(plan.owner).toBe(vault);
                expect(plan.data.mint).toBe(token.mint);
                expect(plan.data.terms.amount).toBe(amount);
                expect(plan.data.terms.periodHours).toBe(PLAN_PERIOD_HOURS);
                expect(plan.data.destinations[0]).toBe(swapAuthority);
                expect(plan.data.destinations).toHaveLength(4);
                expect(plan.data.destinations.slice(1).every(key => key === SYSTEM_PROGRAM_ADDRESS)).toBe(true);
            }
        }
    });

    it('gives the swap authority one empty account per payment token and the vault none', async () => {
        const [[vault], [swapAuthority]] = await Promise.all([findVaultPda(), findSwapAuthorityPda()]);
        const owned = async (owner: Address) =>
            (
                await Promise.all(
                    [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS].map(
                        async programId =>
                            (await rpc.getTokenAccountsByOwner(owner, { programId }, { encoding: 'base64' }).send())
                                .value,
                    ),
                )
            )
                .flat()
                .map(account => account.pubkey)
                .sort();
        expect(await owned(vault)).toEqual([]);
        expect(await owned(swapAuthority)).toEqual([deployment.swapAccounts.USDC, deployment.swapAccounts.USDT].sort());
        for (const [index, account] of [deployment.swapAccounts.USDC, deployment.swapAccounts.USDT].entries()) {
            const { data } = await fetchToken(rpc, account);
            expect([data.owner, data.mint, data.amount]).toEqual([
                swapAuthority,
                config.paymentTokens[index]!.mint,
                0n,
            ]);
        }
    });

    it('has the frozen onboarding lookup table', async () => {
        const table = await fetchAddressLookupTable(rpc, deployment.lookupTable);
        expect(table.data.addresses).toEqual(await getOnboardingLookupTableAddresses(config));
        expect(isNone(table.data.authority)).toBe(true);
    });
});

describe('Pyth Pro on this cluster', () => {
    const updates = [
        read('programs/laterite/tests/fixtures/pyth_spyx_qqqx.bin'),
        read('programs/laterite/tests/fixtures/pyth_usdt.bin'),
    ];

    it('trusts the mainnet signer and pays its own treasury', async () => {
        const storage = await fetchPythStorage(rpc);
        expect(storage.trustedSigners.map(signer => signer.pubkey)).toContain(PYTH_MAINNET_SIGNER);
        expect(storage.treasury).toBe(DEVNET_PYTH_TREASURY);
    });

    it('verifies both mainnet-signed updates, alone and as two entries of one ed25519 instruction', async () => {
        const { treasury } = await fetchPythStorage(rpc);
        const payer = deployment.upgradeAuthority;
        const fee = async (messages: ReadonlyUint8Array[]) => {
            const instructions = [
                getPythEd25519Instruction(
                    messages.map((message, index) => ({ instructionIndex: index + 1, message, offset: 12 })),
                ),
                ...messages.map((message, index) => verifyMessage(payer, treasury, message, index)),
            ];
            // Another transaction may pay the treasury meanwhile: measure only while its balance stands still.
            for (;;) {
                const before = (await rpc.getBalance(treasury).send()).value;
                const after = await simulate(instructions, treasury);
                if ((await rpc.getBalance(treasury).send()).value === before) return after - before;
            }
        };
        for (const update of updates) expect(await fee([update])).toBe(1n);
        expect(await fee(updates)).toBe(2n);
    });
});

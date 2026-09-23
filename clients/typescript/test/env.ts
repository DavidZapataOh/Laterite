import { addresses as devnet } from '@laterite/devnet/addresses';
import {
    type Address,
    type AddressesByLookupTableAddress,
    appendTransactionMessageInstructions,
    compressTransactionMessageUsingAddressLookupTables,
    createTransactionMessage,
    generateKeyPairSigner,
    getAddressEncoder,
    getCompiledTransactionMessageDecoder,
    getProgramDerivedAddress,
    getTransactionSize,
    type Instruction,
    type KeyPairSigner,
    lamports,
    pipe,
    type ReadonlyUint8Array,
    setTransactionMessageComputeUnitLimit,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    setTransactionMessageLoadedAccountsDataSizeLimit,
    signTransactionMessageWithSigners,
    type Transaction,
    type TransactionSigner,
} from '@solana/kit';
import { createRpcFromSvm } from '@solana/kit-plugin-litesvm';
import { SUBSCRIPTIONS_PROGRAM_ADDRESS } from '@solana/subscriptions';
import {
    findAddressLookupTablePda,
    getCreateLookupTableInstruction,
    getExtendLookupTableInstruction,
} from '@solana-program/address-lookup-table';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { FailedTransactionMetadata, LiteSVM, TransactionMetadata } from 'litesvm';

import {
    type Config,
    type ConfigParamsArgs,
    Engine,
    type EnrollParamsArgs,
    fetchConfig,
    fetchUserConfig,
    findConfigPda,
    findPlanAddress,
    findUserConfigPda,
    getCreatePlanInstruction,
    getInitializeInstructionAsync,
    getOnboardingInstructions,
    getOnboardingLookupTableAddresses,
    getSetMarketCalendarInstruction,
    LATERITE_PROGRAM_ADDRESS,
    type UserConfig,
} from '../src';
import { DEVNET_GENESIS_HASH, DOLLAR, NOW, attestorSigner, fixture, read, sponsorSigner } from './fixtures';

const tokens = devnet.tokens;

/** The program tests' `default_enroll_params()`: SPYx and $1 a day, both tokens on the $10 tier, $20 cushions. */
export function defaultParams(): EnrollParamsArgs {
    const goalLabel = new Uint8Array(32);
    goalLabel.set(new TextEncoder().encode('House'));
    return {
        asset: 0,
        changeMultiplier: 0,
        cushions: [20n * DOLLAR, 20n * DOLLAR],
        engine: Engine.Daily,
        engineAmount: DOLLAR,
        goalAmount: 1_000n * DOLLAR,
        goalLabel,
        incomeRule: false,
        paymentTokens: 0b11,
        tier: 0,
    };
}

/** The devnet configuration the program tests deploy: devnet stand-ins, our CPMM as router, devnet's genesis hash. */
export async function validParams(genesisHash: ReadonlyUint8Array = DEVNET_GENESIS_HASH): Promise<ConfigParamsArgs> {
    const asset = (symbol: 'QQQx' | 'SPYx') => ({
        decimals: 8,
        mint: tokens[symbol].mint,
        pythFeedId: tokens[symbol].pyth!.proId,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
    });
    const payment = (symbol: 'USDC' | 'USDT', usdFeedId: number) => ({
        decimals: 6,
        mint: tokens[symbol].mint,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        usdFeedId,
    });
    return {
        assets: [asset('SPYx'), asset('QQQx')],
        genesisHash,
        paymentTokens: [payment('USDC', 0), payment('USDT', 8)],
        router: devnet.cpmm.program,
        settings: {
            attestor: (await attestorSigner()).address,
            maxUsers: 100,
            sponsor: (await sponsorSigner()).address,
            userWeeklyCap: 25n * DOLLAR,
        },
    };
}

/** A transaction's outcome: its size, and the metadata LiteSVM returns. */
export type Outcome = {
    result: FailedTransactionMetadata | TransactionMetadata;
    size: number;
    transaction: Transaction;
};

export const isFailure = (result: Outcome['result']): result is FailedTransactionMetadata =>
    result instanceof FailedTransactionMetadata;

/** The custom error code a failed transaction returned, if any. */
export function customCode({ result }: Outcome): number | undefined {
    if (!isFailure(result)) return undefined;
    const error = result.err() as { err?: () => { code?: number } };
    return error.err?.().code;
}

/** Compute units of the program's first top-level instruction, CPIs included, from the runtime's log lines. */
export function programUnits(metadata: TransactionMetadata): bigint {
    let depth = 0;
    for (const line of metadata.logs()) {
        if (line.includes(' invoke [')) depth += 1;
        else if (line.endsWith(' success') || line.includes(' failed: ')) depth -= 1;
        else if (line.startsWith(`Program ${LATERITE_PROGRAM_ADDRESS} consumed `) && depth === 1) {
            return BigInt(line.split(' ')[3]!);
        }
    }
    throw new Error('The program did not run at the top level');
}

/** Units each invocation of `program` consumed, in the order they finished. */
export const unitsOf = (metadata: TransactionMetadata, program: Address) =>
    metadata
        .logs()
        .filter(line => line.startsWith(`Program ${program} consumed `))
        .map(line => BigInt(line.split(' ')[3]!));

/** The inner instructions of a transaction, with their program addresses resolved from the message. */
export function innerInstructions(outcome: Outcome) {
    const message = getCompiledTransactionMessageDecoder().decode(outcome.transaction.messageBytes);
    const keys = message.staticAccounts;
    return (outcome.result as TransactionMetadata).innerInstructions().flatMap(list =>
        list.map(inner => {
            const instruction = inner.instruction();
            return { data: instruction.data(), programAddress: keys[instruction.programIdIndex()]! };
        }),
    );
}

export class Env {
    readonly rpc;
    lookupTable?: AddressesByLookupTableAddress;
    config?: Config;

    constructor(
        readonly svm: LiteSVM,
        readonly authority: KeyPairSigner,
    ) {
        this.rpc = createRpcFromSvm(svm);
    }

    setNow(now: bigint) {
        const clock = this.svm.getClock();
        clock.unixTimestamp = now;
        this.svm.setClock(clock);
    }

    now() {
        return this.svm.getClock().unixTimestamp;
    }

    airdrop(address: Address, amount = 10_000_000_000n) {
        this.svm.airdrop(address, lamports(amount));
    }

    /** Writes an account's data and owner, rent-exempt. */
    write(address: Address, data: Uint8Array, owner: Address) {
        this.svm.setAccount({
            address,
            data,
            executable: false,
            lamports: lamports(this.svm.minimumBalanceForRentExemption(BigInt(data.length))),
            programAddress: owner,
            space: BigInt(data.length),
        });
    }

    data(address: Address): Uint8Array {
        const account = this.svm.getAccount(address);
        if (!account.exists) throw new Error(`${address} does not exist`);
        return new Uint8Array(account.data);
    }

    exists(address: Address) {
        return this.svm.getAccount(address).exists;
    }

    balance(address: Address) {
        return this.svm.getBalance(address) ?? 0n;
    }

    /** A token account's raw amount, at the same offset under Token and Token-2022. */
    tokenAmount(address: Address) {
        return new DataView(this.data(address).buffer).getBigUint64(64, true);
    }

    setTokenAmount(address: Address, amount: bigint) {
        const data = this.data(address);
        new DataView(data.buffer).setBigUint64(64, amount, true);
        const account = this.svm.getAccount(address);
        if (!account.exists) throw new Error(`${address} does not exist`);
        this.write(address, data, account.programAddress);
    }

    /** An initialized token account without extensions. */
    writeTokenAccount(address: Address, mint: Address, owner: Address, tokenProgram: Address, amount: bigint) {
        const data = new Uint8Array(165);
        data.set(getAddressEncoder().encode(mint), 0);
        data.set(getAddressEncoder().encode(owner), 32);
        new DataView(data.buffer).setBigUint64(64, amount, true);
        data[108] = 1;
        this.write(address, data, tokenProgram);
    }

    /** Sends `instructions` in one transaction: version 0 against the onboarding table, or version 1 with limits. */
    async send(
        feePayer: TransactionSigner,
        instructions: readonly Instruction[],
        options: { table?: boolean; version?: 0 | 1 } = {},
    ): Promise<Outcome> {
        const version = options.version ?? 0;
        const lifetime = { blockhash: this.svm.latestBlockhash(), lastValidBlockHeight: 0n };
        const base = pipe(
            createTransactionMessage({ version }),
            message => setTransactionMessageFeePayerSigner(feePayer, message),
            message => setTransactionMessageLifetimeUsingBlockhash(lifetime, message),
        );
        const withLimits =
            version === 1
                ? pipe(
                      base,
                      message => setTransactionMessageComputeUnitLimit(400_000, message),
                      message => setTransactionMessageLoadedAccountsDataSizeLimit(8 * 1024 * 1024, message),
                  )
                : base;
        const message = appendTransactionMessageInstructions(instructions, withLimits);
        const table = options.table ?? true;
        const compressed =
            version === 0 && table && this.lookupTable
                ? compressTransactionMessageUsingAddressLookupTables(message as never, this.lookupTable)
                : message;
        return this.sendMessage(compressed);
    }

    /** Signs and sends a prepared message. */
    async sendMessage(message: Parameters<typeof signTransactionMessageWithSigners>[0]): Promise<Outcome> {
        const transaction = await signTransactionMessageWithSigners(message);
        const result = this.svm.sendTransaction(transaction);
        this.svm.expireBlockhash();
        return { result, size: getTransactionSize(transaction), transaction };
    }

    async expectSuccess(outcome: Promise<Outcome> | Outcome): Promise<Outcome & { result: TransactionMetadata }> {
        const settled = await outcome;
        if (isFailure(settled.result)) throw new Error(`Transaction failed: ${settled.result.toString()}`);
        return settled as Outcome & { result: TransactionMetadata };
    }

    async fetchConfig() {
        return (this.config = (await fetchConfig(this.rpc, (await findConfigPda())[0])).data);
    }

    async userConfig(user: Address): Promise<UserConfig> {
        return (await fetchUserConfig(this.rpc, (await findUserConfigPda({ user }))[0])).data;
    }
}

/**
 * The program deployed as upgradeable with a random upgrade authority, the clock at {@link NOW}, and the tables'
 * mints as plain mints, as the program tests' `setup()` builds them.
 */
export async function setup(): Promise<Env> {
    const svm = new LiteSVM();
    const env = new Env(svm, await generateKeyPairSigner());
    svm.addProgram(SUBSCRIPTIONS_PROGRAM_ADDRESS, fixture('subscriptions.so'));
    env.setNow(NOW);
    env.airdrop(env.authority.address);
    env.airdrop((await sponsorSigner()).address);
    svm.addProgram(LATERITE_PROGRAM_ADDRESS, read('target/deploy/laterite.so'));
    const [programData] = await getProgramDerivedAddress({
        programAddress: 'BPFLoaderUpgradeab1e11111111111111111111111' as Address,
        seeds: [getAddressEncoder().encode(LATERITE_PROGRAM_ADDRESS)],
    });
    const data = env.data(programData);
    data[12] = 1;
    data.set(getAddressEncoder().encode(env.authority.address), 13);
    env.write(programData, data, 'BPFLoaderUpgradeab1e11111111111111111111111' as Address);
    for (const symbol of ['SPYx', 'QQQx', 'USDC', 'USDT'] as const) {
        const mint = new Uint8Array(82);
        mint[44] = tokens[symbol].decimals;
        mint[45] = 1;
        env.write(tokens[symbol].mint, mint, tokens[symbol].tokenProgram);
    }
    return env;
}

/** Initializes the config with `params` and loads the NYSE 2026–2028 calendar, as the program tests' `initialize`. */
export async function initialize(env: Env, params: ConfigParamsArgs) {
    const mints = [...params.assets, ...params.paymentTokens].map(entry => ({ address: entry.mint, role: 0 as const }));
    const initialize = await getInitializeInstructionAsync({ authority: env.authority, params });
    await env.expectSuccess(env.send(env.authority, [{ ...initialize, accounts: [...initialize.accounts, ...mints] }]));
    const calendar = JSON.parse(read('programs/laterite/data/nyse-calendar.json').toString()) as {
        earlyCloses: string[];
        holidays: string[];
        validThrough: string;
    };
    const day = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;
    const load = getSetMarketCalendarInstruction({
        admin: env.authority,
        earlyCloses: calendar.earlyCloses.map(day),
        holidays: calendar.holidays.map(day),
        validThrough: day(calendar.validThrough),
    });
    await env.expectSuccess(env.send(env.authority, [load]));
    await env.fetchConfig();
}

/** Creates the four plans and the onboarding lookup table, which the sponsor creates, as `add_plans`. */
export async function addPlans(env: Env) {
    const config = await env.fetchConfig();
    for (const paymentToken of [0, 1]) {
        for (const tier of [0, 1]) {
            const token = config.paymentTokens[paymentToken]!;
            const create = getCreatePlanInstruction({
                admin: env.authority,
                mint: token.mint,
                paymentToken,
                plan: await findPlanAddress(paymentToken, tier),
                tier,
                tokenProgram: token.tokenProgram,
            });
            await env.expectSuccess(env.send(env.authority, [create]));
        }
    }
    const sponsor = await sponsorSigner();
    const slot = env.svm.getClock().slot;
    const [table, bump] = await findAddressLookupTablePda({ authority: sponsor.address, recentSlot: slot });
    const addresses = await getOnboardingLookupTableAddresses(config);
    const create = getCreateLookupTableInstruction({
        address: [table, bump],
        authority: sponsor,
        payer: sponsor,
        recentSlot: slot,
    });
    await env.expectSuccess(env.send(sponsor, [create]));
    await env.expectSuccess(
        env.send(sponsor, [
            getExtendLookupTableInstruction({ address: table, addresses, authority: sponsor, payer: sponsor }),
        ]),
    );
    // Addresses added to a table become usable in the next slot.
    env.svm.warpToSlot(slot + 1n);
    env.lookupTable = { [table]: addresses };
}

/** `setup()`, `initialize()` with the devnet configuration (or another cluster's genesis hash) and `addPlans()`. */
export async function withPlans(genesisHash?: ReadonlyUint8Array) {
    const env = await setup();
    await initialize(env, await validParams(genesisHash));
    await addPlans(env);
    return env;
}

/** Gives `user` 100 USDC and 100 USDT in canonical accounts. */
export async function fundUser(env: Env, user: Address) {
    for (const symbol of ['USDC', 'USDT'] as const) {
        const { mint, tokenProgram } = tokens[symbol];
        const [account] = await findAssociatedTokenPda({ mint, owner: user, tokenProgram });
        env.writeTokenAccount(account, mint, user, tokenProgram, 100n * DOLLAR);
    }
}

/** `user`, funded and onboarded by the sponsor with the onboarding builder. */
export async function enrolled(env: Env, user: KeyPairSigner, params: EnrollParamsArgs) {
    await fundUser(env, user.address);
    const sponsor = await sponsorSigner();
    const { instructions } = await getOnboardingInstructions({
        config: env.config!,
        params,
        rpc: env.rpc,
        sponsor,
        user,
    });
    return env.expectSuccess(env.send(sponsor, instructions));
}

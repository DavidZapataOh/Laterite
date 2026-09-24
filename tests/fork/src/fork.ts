import { LATERITE_PROGRAM_ADDRESS } from '@laterite/client';
import type { Cluster } from '@laterite/deployment';
import { createRpc } from '@laterite/devnet';
import {
    type Address,
    address,
    appendTransactionMessageInstructions,
    compileTransactionMessage,
    createDefaultRpcTransport,
    createSolanaRpcFromTransport,
    createSolanaRpcSubscriptions,
    createTransactionMessage,
    decompileTransactionMessage,
    estimateResourceLimitsFactory,
    fetchEncodedAccounts,
    getAddressDecoder,
    getBase58Encoder,
    getBase64EncodedWireTransaction,
    getBase64Encoder,
    getCompiledTransactionMessageDecoder,
    getSignatureFromTransaction,
    getTransactionMessageLoadedAccountsDataSizeLimit,
    getTransactionDecoder,
    getTransactionSize,
    type Instruction,
    isSolanaError,
    lamports,
    pipe,
    type RpcTransport,
    sendAndConfirmTransactionFactory,
    setTransactionMessageComputeUnitLimit,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    setTransactionMessageLoadedAccountsDataSizeLimit,
    type Signature,
    signTransactionMessageWithSigners,
    SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
    type TransactionMessage,
    type TransactionMessageWithFeePayer,
    type TransactionSigner,
} from '@solana/kit';
import { createSurfnetCheatcodesRpc } from '@solana/surfpool/kit';
import { getSysvarClockDecoder, SYSVAR_CLOCK_ADDRESS } from '@solana/sysvars';

const RPC_URL = 'http://127.0.0.1:8899';

/** Waits out a mainnet endpoint's rate limit for up to about a minute, as a shared endpoint needs. */
function patient(transport: RpcTransport): RpcTransport {
    return (async (config: Parameters<RpcTransport>[0]) => {
        for (let attempt = 0; ; attempt++) {
            try {
                return await transport(config);
            } catch (error) {
                const limited =
                    isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) && error.context.statusCode === 429;
                if (!limited || attempt === 8) throw error;
                await new Promise(resolve => setTimeout(resolve, Math.min(1_000 * 2 ** attempt, 8_000)));
            }
        }
    }) as RpcTransport;
}

export const rpc = createRpc(RPC_URL);
export const rpcSubscriptions = createSolanaRpcSubscriptions('ws://127.0.0.1:8900');
export const cheatcodes = createSurfnetCheatcodesRpc(RPC_URL);
/** The fork's upstream, read directly for what the fork does not serve: Kamino Scope's recent posts. */
export const mainnetRpc = createSolanaRpcFromTransport(
    patient(
        createDefaultRpcTransport({
            url: process.env.SURFPOOL_DATASOURCE_RPC_URL || 'https://api.mainnet-beta.solana.com',
        }),
    ),
);

/** The relay between the fork and mainnet (`just`'s `relay_port`). */
export const DATASOURCE_RELAY_URL = 'http://127.0.0.1:8897';

export const DOLLAR = 1_000_000n;

const confirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

/**
 * Runs a request to the fork again when Surfpool could not fetch an account from mainnet: it then answers with an
 * error that carries no simulation, which Kit cannot read (a `TypeError`). Resending the same signed transaction is
 * safe: a cluster executes a signature at most once.
 */
async function whenMainnetAnswers<T>(request: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await request();
        } catch (error) {
            if (!(error instanceof TypeError) || attempt === 3) throw error;
            console.warn(`The fork could not read mainnet (attempt ${attempt}); asking again`);
            await new Promise(resolve => setTimeout(resolve, 2_000 * attempt));
        }
    }
}

const sendAndConfirm = (transaction: Parameters<typeof confirm>[0]) =>
    whenMainnetAnswers(() => confirm(transaction, { commitment: 'confirmed' }));

/** Sends `instructions` in a version 0 transaction paid by `feePayer`; the deployment's `Cluster`. */
export async function send(feePayer: TransactionSigner, instructions: Instruction[]): Promise<Signature> {
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const transaction = await signTransactionMessageWithSigners(
        pipe(
            createTransactionMessage({ version: 0 }),
            message => setTransactionMessageFeePayerSigner(feePayer, message),
            message => setTransactionMessageLifetimeUsingBlockhash(blockhash, message),
            message => appendTransactionMessageInstructions(instructions, message),
        ),
    );
    await sendAndConfirm(transaction as never);
    return getSignatureFromTransaction(transaction);
}

export const cluster: Cluster = { rpc, send };

export async function airdrop(recipient: Address, sol: bigint) {
    const signature = await rpc.requestAirdrop(recipient, lamports(sol * 1_000_000_000n)).send();
    for (;;) {
        const { value } = await rpc.getSignatureStatuses([signature]).send();
        if (value[0]?.confirmationStatus) return;
        await new Promise(resolve => setTimeout(resolve, 200));
    }
}

/** Sets `owner`'s associated account balance in `mint`: a wallet that was paid on mainnet. */
export async function fundToken(owner: Address, mint: Address, amount: bigint, tokenProgram: Address) {
    await cheatcodes.setTokenAccount(owner, mint, { amount }, tokenProgram).send();
}

/** The fork's clock, in seconds. */
export async function clock(): Promise<bigint> {
    const [account] = await fetchEncodedAccounts(rpc, [SYSVAR_CLOCK_ADDRESS]);
    if (!account?.exists) throw new Error('The fork returned no clock');
    return getSysvarClockDecoder().decode(account.data).unixTimestamp;
}

/** Seconds a fork's clock may trail wall time before a price-fresh sweep aligns it. */
export const MAX_CLOCK_DRIFT_SECONDS = 10n;

/**
 * Brings the fork's clock to wall time when it trails by more than {@link MAX_CLOCK_DRIFT_SECONDS}, with Surfpool's
 * time-travel cheatcode: price updates are signed at wall time, and the program accepts one for 60 s of its clock.
 * Returns the drift found and whether it traveled, which the suite reports as part of the environment.
 */
export async function alignClock(): Promise<{ drift: bigint; traveled: boolean }> {
    const drift = BigInt(Math.floor(Date.now() / 1000)) - (await clock());
    if (drift <= MAX_CLOCK_DRIFT_SECONDS) return { drift, traveled: false };
    await cheatcodes.timeTravel({ absoluteTimestamp: Date.now() }).send();
    return { drift, traveled: true };
}

const LOADER = address('BPFLoaderUpgradeab1e11111111111111111111111');

/**
 * The account data a message loads as SIMD-0186 counts it: each account's data and 64 bytes, and the program data of
 * each upgradeable program. Surfpool's simulations leave out the data of programs it already holds, so a version 1
 * limit is never set below this.
 */
export async function loadedAccountsDataSize(message: Parameters<typeof compileTransactionMessage>[0]) {
    const accounts = await fetchEncodedAccounts(rpc, compileTransactionMessage(message).staticAccounts);
    const programData = accounts.flatMap(account =>
        account.exists && account.executable && account.programAddress === LOADER
            ? [getAddressDecoder().decode(account.data, 4)]
            : [],
    );
    const loaded = [...accounts, ...(await fetchEncodedAccounts(rpc, programData))];
    return loaded.reduce((total, account) => total + (account.exists ? account.data.length + 64 : 0), 0);
}

type SendableMessage = TransactionMessage & TransactionMessageWithFeePayer;

const estimate = estimateResourceLimitsFactory({ rpc });

/** The largest compute limit a transaction may set; a simulation that may fail runs under it, as it cannot be estimated. */
const MAX_COMPUTE_UNIT_LIMIT = 1_400_000;

/**
 * Sets the limits a sender sets: the simulation's compute units with a 10% margin and, for version 1, the loaded
 * account data of {@link loadedAccountsDataSize} with the same margin.
 */
async function withLimits<TMessage extends SendableMessage>(message: TMessage) {
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const timed = setTransactionMessageLifetimeUsingBlockhash(blockhash, message);
    const limits = await whenMainnetAnswers(() => estimate(timed as Parameters<typeof estimate>[0]));
    const margin = (limit: number) => Math.ceil(limit * 1.1);
    const computeUnitLimit = Math.min(margin(limits.computeUnitLimit), MAX_COMPUTE_UNIT_LIMIT);
    const limited = setTransactionMessageComputeUnitLimit(computeUnitLimit, timed as never);
    if (message.version !== 1) return limited;
    const loaded = Math.max(limits.loadedAccountsDataSizeLimit ?? 0, await loadedAccountsDataSize(timed as never));
    return setTransactionMessageLoadedAccountsDataSizeLimit(margin(loaded), limited as never);
}

/** An executed instruction's program, accounts and data, as the transaction's inner instructions list them. */
export type Executed = { accounts: Address[]; data: Uint8Array; programAddress: Address };

/** A confirmed transaction, with what the suite measures. */
export type Landed = {
    accounts: Address[];
    blockTime: bigint | null;
    /** A version 1 transaction's declared loaded-accounts limit and SIMD-0186's count of what its accounts load. */
    declaredLoadedAccountsDataSize?: number;
    err: unknown;
    fee: bigint;
    inner: Executed[];
    loadedAccountsDataSize?: number;
    logs: readonly string[];
    postBalances: readonly bigint[];
    preBalances: readonly bigint[];
    signature: Signature;
    size: number;
    units: bigint;
};

/** Reads a confirmed transaction back, as it landed. */
async function readLanded(signature: Signature, size: number): Promise<Landed> {
    const confirmed = await rpc
        .getTransaction(signature, { commitment: 'confirmed', encoding: 'base64', maxSupportedTransactionVersion: 1 })
        .send();
    if (!confirmed?.meta) throw new Error(`${signature} was not found`);
    const wire = getTransactionDecoder().decode(getBase64Encoder().encode(confirmed.transaction[0]));
    const compiled = getCompiledTransactionMessageDecoder().decode(wire.messageBytes);
    // Only a version 1 message declares the limit in its own config, and carries every account inline.
    const message = compiled.version === 1 ? decompileTransactionMessage(compiled as never) : undefined;
    const accounts = compiled.staticAccounts as Address[];
    const inner = (confirmed.meta.innerInstructions ?? []).flatMap(({ instructions }) =>
        instructions.map(({ accounts: indexes, data, programIdIndex }) => ({
            accounts: indexes.map(index => accounts[index]!),
            data: new Uint8Array(getBase58Encoder().encode(data)),
            programAddress: accounts[programIdIndex]!,
        })),
    );
    return {
        accounts,
        blockTime: confirmed.blockTime,
        declaredLoadedAccountsDataSize: message && getTransactionMessageLoadedAccountsDataSizeLimit(message),
        err: confirmed.meta.err,
        fee: confirmed.meta.fee,
        inner,
        loadedAccountsDataSize: message && (await loadedAccountsDataSize(message as never)),
        logs: confirmed.meta.logMessages ?? [],
        postBalances: confirmed.meta.postBalances,
        preBalances: confirmed.meta.preBalances,
        signature,
        size,
        units: confirmed.meta.computeUnitsConsumed ?? 0n,
    };
}

/** Signs and sends a message with a sender's limits, and returns the confirmed transaction. */
export async function sendMessage(message: SendableMessage): Promise<Landed> {
    const transaction = await signTransactionMessageWithSigners((await withLimits(message)) as never);
    await sendAndConfirm(transaction as never);
    return await readLanded(getSignatureFromTransaction(transaction), getTransactionSize(transaction));
}

/**
 * Sends a message that is expected to fail, as a crank that skipped its simulation would: the largest compute limit,
 * no preflight. Returns the transaction once confirmed, failed or not, so its error and logs are on the fork's record.
 */
export async function sendUnchecked(message: SendableMessage): Promise<Landed> {
    const transaction = await signTransactionMessageWithSigners((await withMaximumLimits(message)) as never);
    const signature = await rpc
        .sendTransaction(getBase64EncodedWireTransaction(transaction), { encoding: 'base64', skipPreflight: true })
        .send();
    for (;;) {
        const { value } = await rpc.getSignatureStatuses([signature]).send();
        if (value[0]?.confirmationStatus) break;
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    return await readLanded(signature, getTransactionSize(transaction));
}

/** What a simulation of a signed message reports, without sending it. */
export type Simulated = {
    accounts: number;
    err: unknown;
    loaded: number;
    logs: readonly string[];
    size: number;
    units: bigint;
};

/** A message with the largest compute limit and, for version 1, the loaded account data its accounts need. */
async function withMaximumLimits(message: SendableMessage) {
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const limited = setTransactionMessageComputeUnitLimit(
        MAX_COMPUTE_UNIT_LIMIT,
        setTransactionMessageLifetimeUsingBlockhash(blockhash, message) as never,
    );
    if (message.version !== 1) return limited;
    const loaded = await loadedAccountsDataSize(limited as never);
    return setTransactionMessageLoadedAccountsDataSizeLimit(Math.ceil(loaded * 1.1), limited as never);
}

/** Simulates a message as it would land now, under the largest compute limit (a failing one cannot be estimated). */
export async function simulateMessage(message: SendableMessage): Promise<Simulated> {
    const limited = await withMaximumLimits(message);
    const transaction = await signTransactionMessageWithSigners(limited as never);
    const { value } = await whenMainnetAnswers(() =>
        rpc
            .simulateTransaction(getBase64EncodedWireTransaction(transaction), {
                encoding: 'base64',
                replaceRecentBlockhash: true,
                sigVerify: false,
            })
            .send(),
    );
    return {
        accounts: compileTransactionMessage(limited as Parameters<typeof compileTransactionMessage>[0]).staticAccounts
            .length,
        err: value.err,
        loaded: await loadedAccountsDataSize(limited as never),
        logs: value.logs ?? [],
        size: getTransactionSize(transaction),
        units: value.unitsConsumed ?? 0n,
    };
}

/** The custom error code of a failed instruction, as a simulation or a transaction's status reports it. */
function customError(err: unknown): number | undefined {
    const failure = (err as { InstructionError?: [number, { Custom?: number | bigint }] } | null)?.InstructionError;
    return failure?.[1]?.Custom === undefined ? undefined : Number(failure[1].Custom);
}

/** The program that failed first, the innermost one, and its error, from a failed transaction's logs. */
export function failure({ err, logs }: { err: unknown; logs: readonly string[] }) {
    const program = logs.map(line => /^Program (\w+) failed: /.exec(line)?.[1]).find(Boolean) as Address | undefined;
    return err ? { code: customError(err), program } : undefined;
}

/** Laterite's own error code when Laterite is the program that failed, not a program it called. */
export function lateriteError(result: { err: unknown; logs: readonly string[] }): number | undefined {
    const failed = failure(result);
    return failed?.program === LATERITE_PROGRAM_ADDRESS ? failed.code : undefined;
}

/** One program invocation read from a transaction's logs: its depth and the compute units it consumed. */
export type Invocation = { depth: number; program: Address; units: number };

/** Every program invocation in `logs`, in the order each one finished. */
export function invocations(logs: readonly string[]): Invocation[] {
    const stack: { depth: number; program: Address }[] = [];
    const done: Invocation[] = [];
    for (const line of logs) {
        const invoke = /^Program (\w+) invoke \[(\d+)\]$/.exec(line);
        if (invoke) stack.push({ depth: Number(invoke[2]), program: invoke[1] as Address });
        const consumed = /^Program (\w+) consumed (\d+) of \d+ compute units$/.exec(line);
        if (consumed) done.push({ ...stack.at(-1)!, units: Number(consumed[2]) });
        if (/^Program \w+ (success|failed)/.test(line)) stack.pop();
    }
    return done;
}

/** Bytes a transaction logged, as the runtime counts them against its 10,000-byte truncation limit. */
export const logBytes = (logs: readonly string[]) => logs.reduce((total, line) => total + line.length, 0);

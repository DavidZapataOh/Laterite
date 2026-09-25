import 'server-only';

import { createHash } from 'node:crypto';

import {
    type Address,
    type AddressesByLookupTableAddress,
    AccountRole,
    compileTransaction,
    createNoopSigner,
    createSolanaRpc,
    createSolanaRpcSubscriptions,
    decompileTransactionMessage,
    estimateResourceLimitsFactory,
    fetchAddressesForLookupTables,
    getBase64EncodedWireTransaction,
    getCompiledTransactionMessageDecoder,
    getPublicKeyFromAddress,
    getSignatureFromTransaction,
    getSolanaErrorFromTransactionError,
    getTransactionMessageComputeUnitLimit,
    getTransactionMessageComputeUnitPrice,
    type Instruction,
    isSolanaError,
    type KeyPairSigner,
    type MicroLamports,
    partiallySignTransaction,
    pipe,
    type Rpc,
    sendAndConfirmTransactionFactory,
    setTransactionMessageComputeUnitLimit,
    setTransactionMessageLifetimeUsingBlockhash,
    type Signature,
    type SignatureBytes,
    SOLANA_ERROR__TRANSACTION__FAILED_WHEN_SIMULATING_TO_ESTIMATE_RESOURCE_LIMITS,
    type SolanaRpcApi,
    type Transaction,
    verifySignature,
} from '@solana/kit';
import {
    identifySubscriptionsInstruction,
    parseInitSubscriptionAuthorityInstruction,
    parseResumeSubscriptionInstruction,
    parseRevokeAbandonedSubscriptionInstruction,
    parseRevokeDelegationInstruction,
    parseSubscribeInstruction,
    SUBSCRIPTIONS_PROGRAM_ADDRESS,
    SubscriptionsInstruction,
} from '@solana/subscriptions';
import {
    ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    AssociatedTokenInstruction,
    identifyAssociatedTokenInstruction,
    parseCreateAssociatedTokenIdempotentInstruction,
} from '@solana-program/token';
import {
    type Config,
    createSponsoredTransactionMessage,
    findPlanAddress,
    findVaultPda,
    getOnboardingInstructions,
    getOnboardingLookupTableAddresses,
    getReactivationInstructions,
    identifyLateriteInstruction,
    LATERITE_PROGRAM_ADDRESS,
    LateriteInstruction,
    parseEnrollInstruction,
    parseReactivateInstruction,
    type SponsoredInstructions,
} from '@laterite/client';
import { deployment } from '@laterite/devnet/deployment';

import type { OnboardingIntent } from './onboarding';
import { signerFromEnv } from './signer';

/** The compute-unit price the sponsor pays, in micro-lamports: a percentile of recent fees, within a floor and a ceiling. */
export const SPONSOR_PRIORITY_FEE = { ceiling: 100_000n, floor: 1_000n, percentile: 75 };

/** The most compute units the sponsor pays for in one transaction: onboarding uses about 70,000. */
export const SPONSOR_MAX_UNITS = 150_000;

/** The Compute Budget program, whose first byte of data names the instruction: 2 sets the limit, 3 the price. */
const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111' as Address;

/** The share of the simulated compute units added to the limit. */
const LIMIT_MARGIN = 1.1;

/** Reads `SPONSOR_KEYPAIR`, the key `Config.sponsor` names. */
export const sponsorSigner = (env: NodeJS.ProcessEnv = process.env) => signerFromEnv('SPONSOR_KEYPAIR', env);

/** The cluster the route sends through: `SOLANA_RPC_URL`, and `SOLANA_WS_URL` (the RPC URL on `wss://` by default). */
export function sponsorRpc(env: NodeJS.ProcessEnv = process.env) {
    const rpcUrl = env.SOLANA_RPC_URL;
    if (!rpcUrl) throw new Error('SOLANA_RPC_URL is not set');
    return {
        rpc: createSolanaRpc(rpcUrl),
        rpcSubscriptions: createSolanaRpcSubscriptions(env.SOLANA_WS_URL ?? rpcUrl.replace(/^http/, 'ws')),
    };
}

export type SponsorRpc = Rpc<SolanaRpcApi>;

let table: Promise<AddressesByLookupTableAddress> | undefined;

/**
 * The onboarding lookup table (ADR-003) at its devnet address, read once and required to hold exactly the addresses
 * the deployment puts in it, in order.
 */
export function onboardingLookupTable(rpc: SponsorRpc, config: Config): Promise<AddressesByLookupTableAddress> {
    table ??= (async () => {
        const [held, expected] = await Promise.all([
            fetchAddressesForLookupTables([deployment.lookupTable], rpc),
            getOnboardingLookupTableAddresses(config),
        ]);
        if (held[deployment.lookupTable]?.join() !== expected.join()) {
            throw new Error(`${deployment.lookupTable} is not the onboarding lookup table`);
        }
        return held;
    })().catch(error => {
        table = undefined;
        throw error;
    });
    return table;
}

/** The instructions of `intent` for `wallet`, from the same builders the app's other signers use. */
export function buildSponsored(input: {
    config: Config;
    intent: OnboardingIntent;
    rpc: SponsorRpc;
    sponsor: KeyPairSigner;
    wallet: Address;
}): Promise<SponsoredInstructions> {
    const join = { ...input, params: input.intent.params, user: createNoopSigner(input.wallet) };
    return input.intent.kind === 'enroll' ? getOnboardingInstructions(join) : getReactivationInstructions(join);
}

/** The compute-unit price for a transaction writing `accounts`: a percentile of the fees recently paid to write them. */
export async function sponsorPriorityFee(rpc: SponsorRpc, accounts: readonly Address[]): Promise<MicroLamports> {
    const { ceiling, floor, percentile } = SPONSOR_PRIORITY_FEE;
    const fees = (await rpc.getRecentPrioritizationFees(accounts).send())
        .map(({ prioritizationFee }) => BigInt(prioritizationFee))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const fee = fees[Math.min(fees.length - 1, Math.floor((fees.length * percentile) / 100))] ?? 0n;
    return (fee < floor ? floor : fee > ceiling ? ceiling : fee) as MicroLamports;
}

const writableAccounts = (instructions: readonly Instruction[]) => [
    ...new Set(
        instructions.flatMap(({ accounts = [] }) =>
            accounts
                .filter(({ role }) => role === AccountRole.WRITABLE || role === AccountRole.WRITABLE_SIGNER)
                .map(({ address }) => address),
        ),
    ),
];

/** Which program refused a simulated or sent transaction, and its error code when it has one. */
export type Failure = { code: number | null; program: 'associated-token' | 'laterite' | 'subscriptions' | 'other' };

/** A transaction the cluster refused in simulation, with what the refusal names. */
export class SponsorSimulationError extends Error {
    constructor(
        readonly failure: Failure,
        readonly logs: readonly string[],
    ) {
        super(`the transaction fails in simulation (${failure.program} ${failure.code ?? ''})`.trim());
        this.name = 'SponsorSimulationError';
    }
}

const PROGRAMS: Record<string, Failure['program']> = {
    [ASSOCIATED_TOKEN_PROGRAM_ADDRESS]: 'associated-token',
    [LATERITE_PROGRAM_ADDRESS]: 'laterite',
    [SUBSCRIPTIONS_PROGRAM_ADDRESS]: 'subscriptions',
};

/** The program and code a transaction error names, reading `programs` by the failed instruction's index. */
export function failureOf(error: unknown, programs: readonly Address[]): Failure {
    const context = (isSolanaError(error) ? error.context : {}) as { code?: number; index?: number };
    const program = context.index === undefined ? undefined : programs[context.index];
    return {
        code: typeof context.code === 'number' ? context.code : null,
        program: PROGRAMS[program ?? ''] ?? 'other',
    };
}

/** A transaction the route built and simulated, ready for the wallet's signature. */
export type PreparedTransaction = {
    computeUnitLimit: number;
    computeUnitPrice: MicroLamports;
    computeUnits: number;
    feeLamports: bigint;
    lastValidBlockHeight: bigint;
    /** The sha256 of the message, hex: what the route co-signs once the wallet has signed it. */
    messageHash: string;
    /** What the sponsor's balance loses: the fee and every rent it pays. */
    sponsorLamports: bigint;
    transaction: Transaction;
    /** What the wallet's balance loses: nothing, since the sponsor pays. */
    userLamports: bigint;
};

/** The hex sha256 of a message's bytes. */
export const messageHash = (messageBytes: Transaction['messageBytes']) =>
    createHash('sha256')
        .update(messageBytes as unknown as Uint8Array)
        .digest('hex');

/**
 * Builds the sponsored transaction ADR-003 shapes (version 0 against the onboarding lookup table) with the route's own
 * compute-unit price, sets its limit from a simulation plus 10%, and simulates the exact message the wallet will
 * sign: its compute units, its fee and what it costs each signer.
 */
export async function prepareSponsored(input: {
    instructions: readonly Instruction[];
    lookupTable: AddressesByLookupTableAddress;
    rpc: SponsorRpc;
    sponsor: KeyPairSigner;
}): Promise<PreparedTransaction> {
    const { instructions, lookupTable, rpc, sponsor } = input;
    const programs = instructions.map(instruction => instruction.programAddress);
    // the message's first two instructions are the compute budget's
    const failed = (error: unknown) => failureOf(error, ['' as Address, '' as Address, ...programs]);
    const [computeUnitPrice, { value: blockhash }] = await Promise.all([
        sponsorPriorityFee(rpc, writableAccounts(instructions)),
        rpc.getLatestBlockhash({ commitment: 'confirmed' }).send(),
    ]);
    const message = pipe(
        createSponsoredTransactionMessage({ computeUnitPrice, instructions, lookupTable, sponsor }),
        m => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    );
    let estimated: number;
    try {
        ({ computeUnitLimit: estimated } = await estimateResourceLimitsFactory({ rpc })(message));
    } catch (error) {
        if (!isSolanaError(error, SOLANA_ERROR__TRANSACTION__FAILED_WHEN_SIMULATING_TO_ESTIMATE_RESOURCE_LIMITS)) {
            throw error;
        }
        const { logs } = error.context as { logs?: readonly string[] | null };
        throw new SponsorSimulationError(failed(error.cause), logs ?? []);
    }
    const computeUnitLimit = Math.ceil(estimated * LIMIT_MARGIN);
    const transaction = compileTransaction(setTransactionMessageComputeUnitLimit(computeUnitLimit, message));
    const { value } = await rpc
        .simulateTransaction(getBase64EncodedWireTransaction(transaction), {
            commitment: 'confirmed',
            encoding: 'base64',
            replaceRecentBlockhash: false,
            sigVerify: false,
        })
        .send();
    if (value.err) {
        throw new SponsorSimulationError(failed(getSolanaErrorFromTransactionError(value.err)), value.logs ?? []);
    }
    const [pre, post] = [value.preBalances ?? [], value.postBalances ?? []];
    const spent = (index: number) => BigInt(pre[index] ?? 0n) - BigInt(post[index] ?? 0n);
    return {
        computeUnitLimit,
        computeUnitPrice,
        computeUnits: Number(value.unitsConsumed ?? 0n),
        feeLamports: BigInt(value.fee ?? 0n),
        lastValidBlockHeight: blockhash.lastValidBlockHeight,
        messageHash: messageHash(transaction.messageBytes),
        sponsorLamports: spent(0),
        transaction,
        userLamports: spent(1),
    };
}

/** Whether `wallet` signed `transaction`'s message. */
export async function signedBy(transaction: Transaction, wallet: Address): Promise<boolean> {
    const signature = transaction.signatures[wallet];
    if (!signature) return false;
    const key = await getPublicKeyFromAddress(wallet);
    return verifySignature(key, signature as SignatureBytes, transaction.messageBytes);
}

/** What a sponsored message may contain, and whom it must name. */
export type ShapeContext = {
    config: Config;
    kind: OnboardingIntent['kind'];
    lookupTable: AddressesByLookupTableAddress;
    sponsor: Address;
    user: Address;
};

/**
 * Why the sponsor would not co-sign `transaction`, or null when its message is an allowed shape: ADR-003's version 0
 * message against the onboarding lookup table, the sponsor paying the fee and the user signing, a compute-unit limit
 * and price first and within the sponsor's bounds, then only the onboarding (or reactivation) instructions the
 * builders make, for this user, ending in `enroll` (or `reactivate`). The sponsor's signature may authorize only its
 * payer's part in them: the fee, and the rent of the asset account, the Subscriptions authority and subscription,
 * and `UserConfig`, and closing a subscription it recorded paying for.
 */
export async function shapeProblem(transaction: Transaction, context: ShapeContext): Promise<string | null> {
    const { config, kind, lookupTable, sponsor, user } = context;
    let compiled;
    try {
        compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    } catch {
        return 'the message does not decode';
    }
    if (compiled.version !== 0) return 'the message is not version 0';
    const tables = (compiled.addressTableLookups ?? []).map(lookup => lookup.lookupTableAddress);
    if (tables.some(table => !(table in lookupTable))) return 'the message uses another lookup table';
    if (compiled.header.numSignerAccounts !== 2) return 'the message needs other signers';
    if (compiled.staticAccounts[0] !== sponsor) return 'the sponsor is not the fee payer';
    if (compiled.staticAccounts[1] !== user) return 'the user is not the second signer';
    const signers = Object.keys(transaction.signatures);
    if (signers.length !== 2 || !signers.includes(sponsor) || !signers.includes(user)) {
        return 'the transaction names other signers';
    }
    let message;
    try {
        message = decompileTransactionMessage(compiled as never, { addressesByLookupTableAddress: lookupTable });
    } catch {
        return 'the message does not decompile against the lookup table';
    }
    const [limit, price, ...body] = message.instructions;
    const budget = (instruction: Instruction | undefined, kind: number) =>
        instruction?.programAddress === COMPUTE_BUDGET && instruction.data?.[0] === kind;
    if (!budget(limit, 2)) return 'the compute-unit limit is not first';
    if (!budget(price, 3)) return 'the compute-unit price is not second';
    if (body.some(instruction => instruction.programAddress === COMPUTE_BUDGET))
        return 'the compute budget is set twice';
    if ((getTransactionMessageComputeUnitLimit(message) ?? Infinity) > SPONSOR_MAX_UNITS) {
        return 'the compute-unit limit is too high';
    }
    if ((getTransactionMessageComputeUnitPrice(message) ?? 0n) > SPONSOR_PRIORITY_FEE.ceiling) {
        return 'the compute-unit price is too high';
    }
    const [[vault], plans] = await Promise.all([
        findVaultPda(),
        Promise.all([0, 1].flatMap(token => [0, 1].map(tier => findPlanAddress(token, tier)))),
    ]);
    const assets = config.assets.map(asset => asset.mint);
    const last = body.length - 1;
    for (const [index, instruction] of body.entries()) {
        // the sponsor's signature authorizes an instruction only where it is its payer
        const sponsorSigns = (instruction.accounts ?? []).filter(
            meta =>
                meta.address === sponsor &&
                (meta.role === AccountRole.READONLY_SIGNER || meta.role === AccountRole.WRITABLE_SIGNER),
        ).length;
        const problem = instructionProblem(instruction as never, {
            assets,
            index,
            kind,
            last,
            plans,
            sponsor,
            sponsorSigns,
            user,
            vault,
        });
        if (problem) return `instruction ${index + 2}: ${problem}`;
    }
    return body.length === 0 ? 'the message has no instruction to sponsor' : null;
}

function instructionProblem(
    instruction: Instruction & { data: Uint8Array },
    shape: {
        assets: Address[];
        index: number;
        kind: OnboardingIntent['kind'];
        last: number;
        plans: Address[];
        sponsor: Address;
        sponsorSigns: number;
        user: Address;
        vault: Address;
    },
): string | null {
    const { assets, index, kind, last, plans, sponsor, sponsorSigns, user, vault } = shape;
    const paid = (payer: Address) =>
        payer === sponsor && sponsorSigns === 1 ? null : 'the sponsor signs it but not as its payer';
    const unpaid = () => (sponsorSigns === 0 ? null : 'the sponsor signs it');
    try {
        switch (instruction.programAddress) {
            case ASSOCIATED_TOKEN_PROGRAM_ADDRESS: {
                if (index === last) break;
                if (
                    identifyAssociatedTokenInstruction(instruction) !==
                    AssociatedTokenInstruction.CreateAssociatedTokenIdempotent
                )
                    break;
                const { accounts } = parseCreateAssociatedTokenIdempotentInstruction(instruction as never);
                if (accounts.owner.address !== user) return "the account is not the user's";
                if (!assets.includes(accounts.mint.address)) return 'the mint is not an asset';
                return paid(accounts.payer.address);
            }
            case SUBSCRIPTIONS_PROGRAM_ADDRESS: {
                if (index === last) break;
                switch (identifySubscriptionsInstruction(instruction)) {
                    case SubscriptionsInstruction.InitSubscriptionAuthority: {
                        const { accounts } = parseInitSubscriptionAuthorityInstruction(instruction as never);
                        if (accounts.owner.address !== user) return "the authority is not the user's";
                        const payer = instruction.accounts!.at(-1)!.address;
                        return paid(payer);
                    }
                    case SubscriptionsInstruction.Subscribe: {
                        const { accounts } = parseSubscribeInstruction(instruction as never);
                        if (accounts.subscriber.address !== user) return 'the subscriber is not the user';
                        if (accounts.merchant.address !== vault) return "the plan is not Laterite's";
                        if (!plans.includes(accounts.planPda.address)) return "the plan is not Laterite's";
                        return paid(instruction.accounts!.at(-1)!.address);
                    }
                    case SubscriptionsInstruction.ResumeSubscription: {
                        const { accounts } = parseResumeSubscriptionInstruction(instruction as never);
                        if (accounts.subscriber.address !== user) return 'the subscriber is not the user';
                        if (!plans.includes(accounts.planPda.address)) return "the plan is not Laterite's";
                        return unpaid();
                    }
                    case SubscriptionsInstruction.RevokeDelegation: {
                        const { accounts } = parseRevokeDelegationInstruction(instruction as never);
                        if (accounts.authority.address !== user) return 'the user does not close it';
                        return unpaid();
                    }
                    case SubscriptionsInstruction.RevokeAbandonedSubscription: {
                        const { accounts } = parseRevokeAbandonedSubscriptionInstruction(instruction as never);
                        if (!plans.includes(accounts.planPda.address)) return "the plan is not Laterite's";
                        return paid(accounts.payer.address);
                    }
                }
                break;
            }
            case LATERITE_PROGRAM_ADDRESS: {
                if (index !== last) break;
                const type = identifyLateriteInstruction(instruction);
                if (kind === 'enroll' && type === LateriteInstruction.Enroll) {
                    const { accounts } = parseEnrollInstruction(instruction as never);
                    if (accounts.user.address !== user) return 'the user does not enroll';
                    return paid(accounts.payer.address);
                }
                if (kind === 'reactivate' && type === LateriteInstruction.Reactivate) {
                    const { accounts } = parseReactivateInstruction(instruction as never);
                    if (accounts.user.address !== user) return 'the user does not return';
                    return paid(accounts.sponsor.address);
                }
                break;
            }
        }
    } catch {
        return 'it does not parse';
    }
    return `it is not part of ${kind === 'enroll' ? 'onboarding' : 'a reactivation'}`;
}

/** The sponsor's signature on a transaction the wallet signed: now it is complete. */
export async function cosign(transaction: Transaction, sponsor: KeyPairSigner) {
    return partiallySignTransaction([sponsor.keyPair], transaction);
}

/** Sends a complete transaction and waits for it at `confirmed`; a refusal in preflight names its program. */
export async function sendSponsored(
    input: {
        blockhash: string;
        lastValidBlockHeight: bigint;
        transaction: Transaction;
    } & ReturnType<typeof sponsorRpc>,
): Promise<Signature> {
    const { rpc, rpcSubscriptions, transaction } = input;
    const send = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
    await send(
        {
            ...transaction,
            lifetimeConstraint: { blockhash: input.blockhash, lastValidBlockHeight: input.lastValidBlockHeight },
        } as never,
        { commitment: 'confirmed' },
    );
    return getSignatureFromTransaction(transaction as never);
}

/** One JSON line in the function's log for each refusal and each sent transaction, so abuse is seen and counted. */
export function logSponsor(level: 'error' | 'info' | 'warn', message: string, fields: Record<string, unknown>) {
    console[level](
        JSON.stringify({ level, message, ...fields }, (_, value) =>
            typeof value === 'bigint' ? String(value) : value,
        ),
    );
}

import {
    AccountRole,
    address,
    type Address,
    type AddressesByLookupTableAddress,
    containsBytes,
    getBase64Encoder,
    fetchEncodedAccounts,
    type GetMultipleAccountsApi,
    type Instruction,
    isSignerRole,
    isWritableRole,
    type Rpc,
} from '@solana/kit';
import {
    ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    CREATE_ASSOCIATED_TOKEN_IDEMPOTENT_DISCRIMINATOR,
    findAssociatedTokenPda,
    TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';

import { SLIPPAGE_BPS } from '../constants';

/** Jupiter's aggregator program. */
export const JUPITER_PROGRAM_ADDRESS = address('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');

/** Jupiter's Swap API. */
export const JUPITER_API_URL = 'https://api.jup.ag/swap/v2';

/** `route_v2`'s discriminator, the instruction `/swap/v2/build` returns. */
const ROUTE_V2 = new Uint8Array([0xbb, 0x64, 0xfa, 0xcc, 0x31, 0xc4, 0xaf, 0x14]);

type ApiInstruction = {
    accounts: { isSigner: boolean; isWritable: boolean; pubkey: string }[];
    data: string;
    programId: string;
};

/** The parts of a `/swap/v2/build` response the builders read. */
export type JupiterBuildResponse = {
    addressesByLookupTableAddress: Record<string, string[]> | null;
    /** The blockhash Jupiter read with the route's state, and when (the response carries no `contextSlot`). */
    blockhashWithMetadata?: { fetchedAt: { secs_since_epoch: number } } | null;
    computeBudgetInstructions: ApiInstruction[];
    inAmount: string;
    otherAmountThreshold: string;
    outAmount: string;
    platformFee?: { amount: string } | null;
    /** Each hop's venue (`label`, its pool `ammKey`) and its input and output mint. */
    routePlan: { swapInfo: { ammKey?: string; inputMint: string; label?: string; outputMint: string } }[];
    setupInstructions: ApiInstruction[];
    swapInstruction: ApiInstruction;
};

/** A `/swap/v2/build` request; `wrapAndUnwrapSol` is always false, and without `payer` Jupiter names the taker. */
export type JupiterBuildParams = {
    amount: bigint;
    apiKey?: string;
    fetch?: typeof globalThis.fetch;
    destinationTokenAccount?: Address;
    dexes?: string[];
    excludeDexes?: string[];
    inputMint: Address;
    maxAccounts?: number;
    outputMint: Address;
    payer?: Address;
    slippageBps?: number;
    taker: Address;
};

/** A built swap: setup and swap instructions with the lookup tables they use, and the quote. */
export type JupiterSwap = {
    instructions: Instruction[];
    lookupTables: AddressesByLookupTableAddress;
    otherAmountThreshold: bigint;
    outAmount: bigint;
    response: JupiterBuildResponse;
    swap: Instruction;
};

const base64 = getBase64Encoder();

function toInstruction({ accounts, data, programId }: ApiInstruction): Instruction {
    return {
        accounts: accounts.map(({ isSigner, isWritable, pubkey }) => ({
            address: address(pubkey),
            role: isSigner
                ? isWritable
                    ? AccountRole.WRITABLE_SIGNER
                    : AccountRole.READONLY_SIGNER
                : isWritable
                  ? AccountRole.WRITABLE
                  : AccountRole.READONLY,
        })),
        data: base64.encode(data),
        programAddress: address(programId),
    };
}

/** Parses a `/swap/v2/build` response. */
export function toJupiterSwap(response: JupiterBuildResponse): JupiterSwap {
    const lookupTables = Object.fromEntries(
        Object.entries(response.addressesByLookupTableAddress ?? {}).map(([table, entries]) => [
            address(table),
            entries.map(entry => address(entry)),
        ]),
    ) as AddressesByLookupTableAddress;
    const swap = toInstruction(response.swapInstruction);
    return {
        instructions: [...response.setupInstructions.map(toInstruction), swap],
        lookupTables,
        otherAmountThreshold: BigInt(response.otherAmountThreshold),
        outAmount: BigInt(response.outAmount),
        response,
        swap,
    };
}

/** Requests a swap from Jupiter's `/swap/v2/build`. Keyless access allows 0.5 requests a second, a free key 1. */
export async function buildJupiterSwap(params: JupiterBuildParams): Promise<JupiterSwap> {
    const query = new URLSearchParams({
        amount: params.amount.toString(),
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        slippageBps: String(params.slippageBps ?? Number(SLIPPAGE_BPS)),
        taker: params.taker,
        wrapAndUnwrapSol: 'false',
    });
    if (params.maxAccounts) query.set('maxAccounts', String(params.maxAccounts));
    if (params.destinationTokenAccount) query.set('destinationTokenAccount', params.destinationTokenAccount);
    if (params.dexes) query.set('dexes', params.dexes.join(','));
    if (params.excludeDexes) query.set('excludeDexes', params.excludeDexes.join(','));
    if (params.payer) query.set('payer', params.payer);
    const headers: Record<string, string> = params.apiKey ? { 'x-api-key': params.apiKey } : {};
    const response = await (params.fetch ?? globalThis.fetch)(`${JUPITER_API_URL}/build?${query}`, { headers });
    if (!response.ok) throw new Error(`Jupiter build ${response.status}: ${await response.text()}`);
    return toJupiterSwap((await response.json()) as JupiterBuildResponse);
}

/**
 * Checks a Jupiter swap as a sweep's route and returns its `route_v2` instruction: it spends exactly `amount`,
 * charges no platform or positive-slippage fee, and is signed only by the swap authority. The setup, compute-budget
 * instructions and lookup tables are dropped: the sweep is a version 1 transaction with its own limits, and
 * {@link buildJupiterSweepRoute} checks on the cluster that the swap authority's accounts the route writes exist.
 */
export function getJupiterSweepRoute(
    swap: JupiterSwap,
    expected: { amount: bigint; swapAuthority: Address },
): Instruction {
    const { response, swap: route } = swap;
    const data = route.data ?? new Uint8Array();
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (route.programAddress !== JUPITER_PROGRAM_ADDRESS || data.length < 30 || !containsBytes(data, ROUTE_V2, 0)) {
        throw new Error('Not a Jupiter route_v2 instruction');
    }
    // route_v2: in amount, quoted out amount, slippage, platform fee and positive-slippage fee (bps), route plan.
    if (view.getBigUint64(8, true) !== expected.amount || BigInt(response.inAmount) !== expected.amount) {
        throw new Error('The route does not spend exactly the pull');
    }
    if (
        view.getUint16(26, true) !== 0 ||
        view.getUint16(28, true) !== 0 ||
        BigInt(response.platformFee?.amount ?? 0) !== 0n
    ) {
        throw new Error('The route charges a fee');
    }
    const signers = (route.accounts ?? []).filter(meta => isSignerRole(meta.role));
    if (signers.some(meta => meta.address !== expected.swapAuthority)) throw new Error('The route has another signer');
    return route;
}

/** Whether an instruction is the Associated Token program's idempotent creation, Jupiter's setup for a taker's account. */
const isAssociatedTokenAccountCreation = ({ data, programAddress }: Instruction) =>
    programAddress === ASSOCIATED_TOKEN_PROGRAM_ADDRESS &&
    data?.length === 1 &&
    data[0] === CREATE_ASSOCIATED_TOKEN_IDEMPOTENT_DISCRIMINATOR;

/** A swap-authority token account: its address, mint and token program. */
export type SwapAuthorityAccount = { address: Address; mint: Address; tokenProgram: Address };

/**
 * Thrown for a route that writes swap-authority accounts the cluster lacks, typically in an intermediate mint: anyone
 * may create them (the Associated Token program's idempotent creation, in a transaction of their own), and the route
 * then builds.
 */
export class SwapAuthorityAccountsRequiredError extends Error {
    constructor(readonly accounts: SwapAuthorityAccount[]) {
        super(
            `The route needs swap-authority accounts that do not exist: ${accounts.map(({ address }) => address).join(', ')}`,
        );
        this.name = 'SwapAuthorityAccountsRequiredError';
    }
}

/**
 * A sweep's route from Jupiter (ADR-001): `amount` of the payment token into the user's asset account, the swap
 * authority as taker and as the payer Jupiter names (so a venue that takes its payer as a signer gets the swap
 * authority, which the program signs for, never the crank), at most 40 accounts, Jupiter's own slippage bound no
 * tighter than the program's (which enforces `min_out`), optionally only through `dexes` or without `excludeDexes`
 * (a crank retrying without a venue that failed), checked by {@link getJupiterSweepRoute}.
 * Every swap-authority account the route writes, its associated account in a mint of the route plan, must exist on
 * the cluster (one `getMultipleAccounts`), else {@link SwapAuthorityAccountsRequiredError} names them; a venue's
 * account need not, since a venue may name one it has not created yet. A route that names the crank is refused, as a
 * defense in depth: the sweep never lends the crank's signature to a route. Jupiter reads mainnet,
 * so its setup, which only creates the taker's accounts, is dropped, and any other setup is refused. Also returns the
 * quote, so the crank can skip a route whose output would fall below the sweep's minimum, the route's venues (Jupiter's
 * labels, to exclude one that failed) and when Jupiter read the state it quoted (Unix seconds, `null` if not reported).
 */
export async function buildJupiterSweepRoute(input: {
    amount: bigint;
    apiKey?: string;
    assetMint: Address;
    crank: Address;
    dexes?: string[];
    excludeDexes?: string[];
    fetch?: typeof globalThis.fetch;
    paymentMint: Address;
    rpc: Rpc<GetMultipleAccountsApi>;
    swapAuthority: Address;
    userAssetAccount: Address;
}): Promise<{ outAmount: bigint; quotedAt: number | null; route: Instruction; venues: string[] }> {
    const swap = await buildJupiterSwap({
        amount: input.amount,
        apiKey: input.apiKey,
        destinationTokenAccount: input.userAssetAccount,
        dexes: input.dexes,
        excludeDexes: input.excludeDexes,
        fetch: input.fetch,
        inputMint: input.paymentMint,
        maxAccounts: 40,
        outputMint: input.assetMint,
        slippageBps: Number(SLIPPAGE_BPS),
        taker: input.swapAuthority,
    });
    const route = getJupiterSweepRoute(swap, { amount: input.amount, swapAuthority: input.swapAuthority });
    if ((route.accounts ?? []).some(meta => meta.address === input.crank)) {
        throw new Error('The route names the crank, whose signature it would need');
    }
    if (swap.instructions.slice(0, -1).some(setup => !isAssociatedTokenAccountCreation(setup))) {
        throw new Error('The route needs another setup than accounts');
    }
    const mints = new Set(swap.response.routePlan.flatMap(({ swapInfo }) => [swapInfo.inputMint, swapInfo.outputMint]));
    const swapAccounts = new Map<Address, SwapAuthorityAccount>();
    for (const mint of mints) {
        for (const tokenProgram of [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS]) {
            const owner = input.swapAuthority;
            const [account] = await findAssociatedTokenPda({ mint: address(mint), owner, tokenProgram });
            swapAccounts.set(account, { address: account, mint: address(mint), tokenProgram });
        }
    }
    const written = [
        ...new Set((route.accounts ?? []).filter(meta => isWritableRole(meta.role)).map(meta => meta.address)),
    ].flatMap(account => swapAccounts.get(account) ?? []);
    const existing = await fetchEncodedAccounts(
        input.rpc,
        written.map(({ address }) => address),
    );
    const missing = written.filter((_, index) => !existing[index]!.exists);
    if (missing.length > 0) throw new SwapAuthorityAccountsRequiredError(missing);
    const venues = [...new Set(swap.response.routePlan.flatMap(({ swapInfo }) => swapInfo.label ?? []))];
    const quotedAt = swap.response.blockhashWithMetadata?.fetchedAt.secs_since_epoch ?? null;
    return { outAmount: swap.outAmount, quotedAt, route, venues };
}

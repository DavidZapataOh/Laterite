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
    computeBudgetInstructions: ApiInstruction[];
    inAmount: string;
    otherAmountThreshold: string;
    outAmount: string;
    platformFee?: { amount: string } | null;
    setupInstructions: ApiInstruction[];
    swapInstruction: ApiInstruction;
};

/** A `/swap/v2/build` request; `wrapAndUnwrapSol` is always false. */
export type JupiterBuildParams = {
    amount: bigint;
    apiKey?: string;
    fetch?: typeof globalThis.fetch;
    destinationTokenAccount?: Address;
    dexes?: string[];
    inputMint: Address;
    maxAccounts?: number;
    outputMint: Address;
    payer: Address;
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
        payer: params.payer,
        slippageBps: String(params.slippageBps ?? Number(SLIPPAGE_BPS)),
        taker: params.taker,
        wrapAndUnwrapSol: 'false',
    });
    if (params.maxAccounts) query.set('maxAccounts', String(params.maxAccounts));
    if (params.destinationTokenAccount) query.set('destinationTokenAccount', params.destinationTokenAccount);
    if (params.dexes) query.set('dexes', params.dexes.join(','));
    const headers: Record<string, string> = params.apiKey ? { 'x-api-key': params.apiKey } : {};
    const response = await (params.fetch ?? globalThis.fetch)(`${JUPITER_API_URL}/build?${query}`, { headers });
    if (!response.ok) throw new Error(`Jupiter build ${response.status}: ${await response.text()}`);
    return toJupiterSwap((await response.json()) as JupiterBuildResponse);
}

/**
 * Checks a Jupiter swap as a sweep's route and returns its `route_v2` instruction: it spends exactly `amount`, needs
 * no setup (every account it names, the swap authority's intermediate accounts included, already exists), charges
 * no platform or positive-slippage fee, and is signed only by the swap authority. The compute-budget instructions
 * and lookup tables are dropped: the sweep is a version 1 transaction with its own limits.
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
    if (response.setupInstructions.length > 0) throw new Error('The route needs accounts the swap authority lacks');
    const signers = (route.accounts ?? []).filter(meta => isSignerRole(meta.role));
    if (signers.some(meta => meta.address !== expected.swapAuthority)) throw new Error('The route has another signer');
    return route;
}

/**
 * A sweep's route from Jupiter (ADR-001): `amount` of the payment token into the user's asset account, the swap
 * authority as taker, the crank as payer, at most 40 accounts, Jupiter's own slippage bound no tighter than the
 * program's (which enforces `min_out`), checked by {@link getJupiterSweepRoute}, and every account it writes
 * existing on the cluster (one `getMultipleAccounts`). Also returns the quote, so the crank can skip a route whose
 * output would fall below the sweep's minimum.
 */
export async function buildJupiterSweepRoute(input: {
    amount: bigint;
    apiKey?: string;
    assetMint: Address;
    crank: Address;
    fetch?: typeof globalThis.fetch;
    paymentMint: Address;
    rpc: Rpc<GetMultipleAccountsApi>;
    swapAuthority: Address;
    userAssetAccount: Address;
}): Promise<{ outAmount: bigint; route: Instruction }> {
    const swap = await buildJupiterSwap({
        amount: input.amount,
        apiKey: input.apiKey,
        destinationTokenAccount: input.userAssetAccount,
        fetch: input.fetch,
        inputMint: input.paymentMint,
        maxAccounts: 40,
        outputMint: input.assetMint,
        payer: input.crank,
        slippageBps: Number(SLIPPAGE_BPS),
        taker: input.swapAuthority,
    });
    const route = getJupiterSweepRoute(swap, { amount: input.amount, swapAuthority: input.swapAuthority });
    const written = [
        ...new Set((route.accounts ?? []).filter(meta => isWritableRole(meta.role)).map(meta => meta.address)),
    ];
    const missing = (await fetchEncodedAccounts(input.rpc, written)).filter(account => !account.exists);
    if (missing.length > 0) {
        throw new Error(
            `The route writes accounts that do not exist: ${missing.map(({ address }) => address).join(', ')}`,
        );
    }
    return { outAmount: swap.outAmount, route };
}

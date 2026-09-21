import {
    AccountRole,
    address,
    type Address,
    type AddressesByLookupTableAddress,
    getBase64Encoder,
    type Instruction,
} from '@solana/kit';

type ApiInstruction = {
    accounts: { isSigner: boolean; isWritable: boolean; pubkey: string }[];
    data: string;
    programId: string;
};

type BuildResponse = {
    addressesByLookupTableAddress: Record<string, string[]> | null;
    computeBudgetInstructions: ApiInstruction[];
    otherAmountThreshold: string;
    outAmount: string;
    setupInstructions: ApiInstruction[];
    swapInstruction: ApiInstruction;
};

export type BuildParams = {
    amount: bigint;
    destinationTokenAccount?: Address;
    dexes?: string[];
    inputMint: Address;
    maxAccounts?: number;
    outputMint: Address;
    payer: Address;
    slippageBps?: number;
    taker: Address;
};

export type BuiltSwap = {
    instructions: Instruction[];
    lookupTables: AddressesByLookupTableAddress;
    otherAmountThreshold: bigint;
    outAmount: bigint;
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

export async function buildSwap(params: BuildParams): Promise<BuiltSwap> {
    const query = new URLSearchParams({
        amount: params.amount.toString(),
        inputMint: params.inputMint,
        outputMint: params.outputMint,
        payer: params.payer,
        slippageBps: String(params.slippageBps ?? 200),
        taker: params.taker,
        wrapAndUnwrapSol: 'false',
    });
    if (params.maxAccounts) query.set('maxAccounts', String(params.maxAccounts));
    if (params.destinationTokenAccount) query.set('destinationTokenAccount', params.destinationTokenAccount);
    if (params.dexes) query.set('dexes', params.dexes.join(','));
    const headers: Record<string, string> = process.env.JUPITER_API_KEY
        ? { 'x-api-key': process.env.JUPITER_API_KEY }
        : {};
    const response = await fetch(`https://api.jup.ag/swap/v2/build?${query}`, { headers });
    if (!response.ok) throw new Error(`Jupiter build ${response.status}: ${await response.text()}`);
    const body = (await response.json()) as BuildResponse;
    const lookupTables = Object.fromEntries(
        Object.entries(body.addressesByLookupTableAddress ?? {}).map(([table, entries]) => [
            address(table),
            entries.map(entry => address(entry)),
        ]),
    ) as AddressesByLookupTableAddress;
    const swap = toInstruction(body.swapInstruction);
    return {
        instructions: [...body.setupInstructions.map(toInstruction), swap],
        lookupTables,
        otherAmountThreshold: BigInt(body.otherAmountThreshold),
        outAmount: BigInt(body.outAmount),
        swap,
    };
}

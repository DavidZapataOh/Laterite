import {
    address,
    type Address,
    type GetMinimumBalanceForRentExemptionApi,
    type GetTokenAccountBalanceApi,
    type Instruction,
    isSome,
    type Rpc,
    type TransactionSigner,
} from '@solana/kit';
import { getCreateAccountInstruction } from '@solana-program/system';
import {
    getInitializeMintInstruction as getInitializeStableMintInstruction,
    getMintSize as getStableMintSize,
    TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';
import {
    AccountState,
    type Extension,
    extension,
    findAssociatedTokenPda,
    getCreateAssociatedTokenIdempotentInstructionAsync,
    getInitializeConfidentialTransferMintInstruction,
    getInitializeDefaultAccountStateInstruction,
    getInitializeMetadataPointerInstruction,
    getInitializeMint2Instruction,
    getInitializePausableConfigInstruction,
    getInitializePermanentDelegateInstruction,
    getInitializeScaledUiAmountMintInstruction,
    getInitializeTokenMetadataInstruction,
    getInitializeTransferHookInstruction,
    getMintSize,
    getMintToCheckedInstruction,
    getUpdateMultiplierScaledUiMintInstruction,
    type Mint,
    TOKEN_2022_PROGRAM_ADDRESS,
} from '@solana-program/token-2022';

type MintExtension<K extends Extension['__kind']> = Extract<Extension, { __kind: K }>;

/** The extension of `kind` on a decoded Token-2022 mint. */
export function mintExtension<K extends Extension['__kind']>(mint: Mint, kind: K): MintExtension<K> {
    const found = isSome(mint.extensions)
        ? mint.extensions.value.find((e): e is MintExtension<K> => e.__kind === kind)
        : undefined;
    if (!found) throw new Error(`Mint has no ${kind} extension`);
    return found;
}

/** Instructions that create a devnet replica of an xStock mint; the issuer holds every authority. */
export async function createXStockMintInstructions(
    rpc: Rpc<GetMinimumBalanceForRentExemptionApi>,
    source: Mint,
    roles: { payer: TransactionSigner; mint: TransactionSigner; issuer: TransactionSigner },
): Promise<Instruction[]> {
    const scaled = mintExtension(source, 'ScaledUiAmountConfig');
    const confidential = mintExtension(source, 'ConfidentialTransferMint');
    const metadata = mintExtension(source, 'TokenMetadata');
    if (metadata.additionalMetadata.size > 0) throw new Error('Additional metadata is not replicated');

    const mint = roles.mint.address;
    const authority = roles.issuer.address;
    const fixed = [
        extension('MetadataPointer', { authority, metadataAddress: mint }),
        extension('PermanentDelegate', { delegate: authority }),
        extension('DefaultAccountState', { state: AccountState.Initialized }),
        extension('ScaledUiAmountConfig', {
            authority,
            multiplier: scaled.multiplier,
            newMultiplier: scaled.multiplier,
            newMultiplierEffectiveTimestamp: 0n,
        }),
        extension('PausableConfig', { authority, paused: false }),
        extension('ConfidentialTransferMint', {
            auditorElgamalPubkey: null,
            authority,
            autoApproveNewAccounts: confidential.autoApproveNewAccounts,
        }),
        extension('TransferHook', { authority, programId: address('11111111111111111111111111111111') }),
    ];
    const tokenMetadata = extension('TokenMetadata', {
        additionalMetadata: new Map(),
        mint,
        name: metadata.name,
        symbol: metadata.symbol,
        updateAuthority: authority,
        uri: metadata.uri,
    });
    const space = getMintSize(fixed);
    const lamports = await rpc.getMinimumBalanceForRentExemption(BigInt(getMintSize([...fixed, tokenMetadata]))).send();

    return [
        getCreateAccountInstruction({
            lamports,
            newAccount: roles.mint,
            payer: roles.payer,
            programAddress: TOKEN_2022_PROGRAM_ADDRESS,
            space,
        }),
        getInitializeMetadataPointerInstruction({ authority, metadataAddress: mint, mint }),
        getInitializePermanentDelegateInstruction({ delegate: authority, mint }),
        getInitializeDefaultAccountStateInstruction({ mint, state: AccountState.Initialized }),
        getInitializeScaledUiAmountMintInstruction({ authority, mint, multiplier: scaled.multiplier }),
        getInitializePausableConfigInstruction({ authority, mint }),
        getInitializeConfidentialTransferMintInstruction({
            auditorElgamalPubkey: null,
            authority,
            autoApproveNewAccounts: confidential.autoApproveNewAccounts,
            mint,
        }),
        getInitializeTransferHookInstruction({ authority, mint, programId: null }),
        getInitializeMint2Instruction({
            decimals: source.decimals,
            freezeAuthority: authority,
            mint,
            mintAuthority: authority,
        }),
        getInitializeTokenMetadataInstruction({
            metadata: mint,
            mint,
            mintAuthority: roles.issuer,
            name: metadata.name,
            symbol: metadata.symbol,
            updateAuthority: authority,
            uri: metadata.uri,
        }),
        syncMultiplier(mint, roles.issuer, scaled),
    ];
}

function syncMultiplier(mint: Address, issuer: TransactionSigner, scaled: MintExtension<'ScaledUiAmountConfig'>) {
    return getUpdateMultiplierScaledUiMintInstruction({
        authority: issuer,
        effectiveTimestamp: scaled.newMultiplierEffectiveTimestamp,
        mint,
        multiplier: scaled.newMultiplier,
    });
}

/** Updates the replica when mainnet has scheduled a different multiplier; null when they agree. */
export function syncMultiplierInstruction(
    source: Mint,
    devnet: Mint,
    mint: Address,
    issuer: TransactionSigner,
): Instruction | null {
    const want = mintExtension(source, 'ScaledUiAmountConfig');
    const have = mintExtension(devnet, 'ScaledUiAmountConfig');
    const agree =
        want.newMultiplier === have.newMultiplier &&
        want.newMultiplierEffectiveTimestamp === have.newMultiplierEffectiveTimestamp;
    return agree ? null : syncMultiplier(mint, issuer, want);
}

/** Instructions that create a 6-decimal SPL Token stand-in for a stablecoin. */
export async function createStableMintInstructions(
    rpc: Rpc<GetMinimumBalanceForRentExemptionApi>,
    roles: { payer: TransactionSigner; mint: TransactionSigner; faucet: Address; freezeAuthority: Address },
): Promise<Instruction[]> {
    const space = getStableMintSize();
    return [
        getCreateAccountInstruction({
            lamports: await rpc.getMinimumBalanceForRentExemption(BigInt(space)).send(),
            newAccount: roles.mint,
            payer: roles.payer,
            programAddress: TOKEN_PROGRAM_ADDRESS,
            space,
        }),
        getInitializeStableMintInstruction({
            decimals: 6,
            freezeAuthority: roles.freezeAuthority,
            mint: roles.mint.address,
            mintAuthority: roles.faucet,
        }),
    ];
}

/** Creates the owner's associated token account if needed and mints `amount` into it. */
export async function mintToInstructions(p: {
    payer: TransactionSigner;
    authority: TransactionSigner;
    mint: Address;
    owner: Address;
    amount: bigint;
    decimals: number;
    tokenProgram: Address;
}): Promise<Instruction[]> {
    const [token] = await findAssociatedTokenPda({ mint: p.mint, owner: p.owner, tokenProgram: p.tokenProgram });
    return [
        await getCreateAssociatedTokenIdempotentInstructionAsync({
            mint: p.mint,
            owner: p.owner,
            payer: p.payer,
            tokenProgram: p.tokenProgram,
        }),
        getMintToCheckedInstruction(
            { amount: p.amount, decimals: p.decimals, mint: p.mint, mintAuthority: p.authority, token },
            { programAddress: p.tokenProgram },
        ),
    ];
}

/** Balance of the owner's associated token account, zero when it does not exist. */
export async function tokenBalance(
    rpc: Rpc<GetTokenAccountBalanceApi>,
    owner: Address,
    mint: Address,
    tokenProgram: Address,
): Promise<bigint> {
    const [token] = await findAssociatedTokenPda({ mint, owner, tokenProgram });
    try {
        const { value } = await rpc.getTokenAccountBalance(token, { commitment: 'confirmed' }).send();
        return BigInt(value.amount);
    } catch {
        return 0n;
    }
}

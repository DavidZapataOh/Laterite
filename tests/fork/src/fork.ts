import {
    address,
    airdropFactory,
    appendTransactionMessageInstructions,
    assertIsTransactionWithBlockhashLifetime,
    type Address,
    type AddressesByLookupTableAddress,
    compressTransactionMessageUsingAddressLookupTables,
    createSolanaRpc,
    createSolanaRpcSubscriptions,
    createTransactionMessage,
    generateKeyPairSigner,
    getBase64EncodedWireTransaction,
    getCompiledTransactionMessageDecoder,
    getSignatureFromTransaction,
    getTransactionSize,
    getTransactionSizeLimit,
    type Instruction,
    type KeyPairSigner,
    lamports,
    pipe,
    sendAndConfirmTransactionFactory,
    setTransactionMessageComputeUnitLimit,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    setTransactionMessageLoadedAccountsDataSizeLimit,
    type Signature,
    signTransactionMessageWithSigners,
    type Transaction,
} from '@solana/kit';
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync } from '@solana-program/token';
import { createSurfnetCheatcodesRpc } from '@solana/surfpool/kit';

const RPC_URL = 'http://127.0.0.1:8899';

export const rpc = createSolanaRpc(RPC_URL);
export const rpcSubscriptions = createSolanaRpcSubscriptions('ws://127.0.0.1:8900');
export const cheatcodes = createSurfnetCheatcodesRpc(RPC_URL);

export const USDC = address('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const USDT = address('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB');
export const SPYX = address('XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W');

const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

export async function fundedSigner(): Promise<KeyPairSigner> {
    const signer = await generateKeyPairSigner();
    await airdropFactory({ rpc, rpcSubscriptions })({
        commitment: 'confirmed',
        lamports: lamports(10_000_000_000n),
        recipientAddress: signer.address,
    });
    return signer;
}

/** Sets the owner's associated token balance; create the account first to keep Token-2022 extensions. */
export async function fundToken(owner: Address, mint: Address, amount: bigint, tokenProgram?: Address) {
    await cheatcodes.setTokenAccount(owner, mint, { amount }, tokenProgram).send();
}

export async function createAta(payer: KeyPairSigner, owner: Address, mint: Address, tokenProgram: Address) {
    const [ata] = await findAssociatedTokenPda({ mint, owner, tokenProgram });
    await send(payer, [await getCreateAssociatedTokenIdempotentInstructionAsync({ mint, owner, payer, tokenProgram })]);
    return ata;
}

export async function tokenBalance(account: Address): Promise<bigint> {
    const { value } = await rpc.getTokenAccountBalance(account, { commitment: 'confirmed' }).send();
    return BigInt(value.amount);
}

export type SendOptions = {
    computeUnitLimit?: number;
    lookupTables?: AddressesByLookupTableAddress;
    version?: 0 | 1;
};

// Loading Jupiter alone takes about 2.9 MB of program data; v1 budgets zero unless set.
const LOADED_ACCOUNTS_DATA_LIMIT = 64 * 1024 * 1024;

export async function buildTransaction(payer: KeyPairSigner, instructions: Instruction[], options: SendOptions = {}) {
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const computeUnitLimit = options.computeUnitLimit ?? 400_000;
    if (options.version === 1) {
        return await signTransactionMessageWithSigners(
            pipe(
                createTransactionMessage({ version: 1 }),
                m => setTransactionMessageFeePayerSigner(payer, m),
                m => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
                m => setTransactionMessageComputeUnitLimit(computeUnitLimit, m),
                m => setTransactionMessageLoadedAccountsDataSizeLimit(LOADED_ACCOUNTS_DATA_LIMIT, m),
                m => appendTransactionMessageInstructions(instructions, m),
            ),
        );
    }
    const message = pipe(
        createTransactionMessage({ version: 0 }),
        m => setTransactionMessageFeePayerSigner(payer, m),
        m => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
        m => setTransactionMessageComputeUnitLimit(computeUnitLimit, m),
        m => setTransactionMessageLoadedAccountsDataSizeLimit(LOADED_ACCOUNTS_DATA_LIMIT, m),
        m => appendTransactionMessageInstructions(instructions, m),
    );
    return await signTransactionMessageWithSigners(
        options.lookupTables
            ? compressTransactionMessageUsingAddressLookupTables(message, options.lookupTables)
            : message,
    );
}

export async function send(payer: KeyPairSigner, instructions: Instruction[], options: SendOptions = {}) {
    for (let attempt = 0; ; attempt++) {
        const transaction = await buildTransaction(payer, instructions, options);
        assertIsTransactionWithBlockhashLifetime(transaction);
        try {
            await sendAndConfirm(transaction, { commitment: 'confirmed', skipPreflight: true });
            return getSignatureFromTransaction(transaction) as Signature;
        } catch (error) {
            if (attempt > 0) throw error;
        }
    }
}

/** A fork's clock drifts behind wall time; pools such as Whirlpool reject stale timestamps. */
export async function syncClock() {
    const blockTime = await rpc.getBlockTime(await rpc.getSlot().send()).send();
    if (blockTime !== null && Number(blockTime) * 1000 >= Date.now() - 1_000) return;
    await cheatcodes.timeTravel({ absoluteTimestamp: Date.now() }).send();
}

export type TxMetrics = {
    accounts: number;
    error: unknown;
    logs: readonly string[];
    lookupAccounts: number;
    size: number;
    sizeLimit: number;
    staticAccounts: number;
    unitsConsumed: bigint | undefined;
    version: number | 'legacy';
};

/** Size, accounts and a simulation; a transaction over its size limit is not sent to the validator. */
export async function metrics(transaction: Transaction): Promise<TxMetrics> {
    const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    const lookups = 'addressTableLookups' in message ? (message.addressTableLookups ?? []) : [];
    const lookupAccounts = lookups.reduce((n, l) => n + l.writableIndexes.length + l.readonlyIndexes.length, 0);
    const base = {
        accounts: message.staticAccounts.length + lookupAccounts,
        lookupAccounts,
        size: getTransactionSize(transaction),
        sizeLimit: getTransactionSizeLimit(transaction),
        staticAccounts: message.staticAccounts.length,
        version: message.version,
    };
    if (base.size > base.sizeLimit) return { ...base, error: 'too large', logs: [], unitsConsumed: undefined };
    const { value } = await rpc
        .simulateTransaction(getBase64EncodedWireTransaction(transaction), {
            encoding: 'base64',
            replaceRecentBlockhash: true,
            sigVerify: false,
        })
        .send();
    return { ...base, error: value.err, logs: value.logs ?? [], unitsConsumed: value.unitsConsumed };
}

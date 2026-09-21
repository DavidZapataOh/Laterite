import {
    appendTransactionMessageInstructions,
    assertIsTransactionWithBlockhashLifetime,
    createSolanaRpc,
    createSolanaRpcSubscriptions,
    createTransactionMessage,
    getSignatureFromTransaction,
    type Instruction,
    pipe,
    sendAndConfirmTransactionFactory,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    type Signature,
    signTransactionMessageWithSigners,
    type TransactionSigner,
} from '@solana/kit';

export type Client = ReturnType<typeof createClient>;

/** RPC clients for the devnet target plus a confirmed `send` that counts what it sends. */
export function createClient(
    rpcUrl = process.env.DEVNET_RPC_URL ?? 'https://api.devnet.solana.com',
    wsUrl = process.env.DEVNET_WS_URL ?? 'wss://api.devnet.solana.com',
) {
    const rpc = createSolanaRpc(rpcUrl);
    const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
    const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
    let sent = 0;

    async function send(feePayer: TransactionSigner, instructions: Instruction[]): Promise<Signature> {
        for (let attempt = 0; ; attempt++) {
            const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
            const transaction = await signTransactionMessageWithSigners(
                pipe(
                    createTransactionMessage({ version: 0 }),
                    m => setTransactionMessageFeePayerSigner(feePayer, m),
                    m => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
                    m => appendTransactionMessageInstructions(instructions, m),
                ),
            );
            assertIsTransactionWithBlockhashLifetime(transaction);
            try {
                await sendAndConfirm(transaction, { commitment: 'confirmed' });
                sent += 1;
                return getSignatureFromTransaction(transaction);
            } catch (error) {
                if (attempt > 0) throw error;
            }
        }
    }

    return { rpc, rpcSubscriptions, send, sentCount: () => sent };
}

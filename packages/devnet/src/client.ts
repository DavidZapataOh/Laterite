import {
    appendTransactionMessageInstructions,
    assertIsTransactionWithBlockhashLifetime,
    createDefaultRpcTransport,
    createSolanaRpcFromTransport,
    createSolanaRpcSubscriptions,
    createTransactionMessage,
    getSignatureFromTransaction,
    type Instruction,
    isSolanaError,
    pipe,
    type RpcTransport,
    sendAndConfirmTransactionFactory,
    setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash,
    type Signature,
    signTransactionMessageWithSigners,
    SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
    type TransactionSigner,
} from '@solana/kit';

export type Client = ReturnType<typeof createClient>;

/** Retries requests the node rejects with 429, as public RPC endpoints do under bursts. */
function withRateLimitRetry(transport: RpcTransport): RpcTransport {
    return async function retrying<TResponse>(config: Parameters<RpcTransport>[0]): Promise<TResponse> {
        for (let attempt = 0; ; attempt++) {
            try {
                return await transport<TResponse>(config);
            } catch (error) {
                const rateLimited =
                    isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) && error.context.statusCode === 429;
                if (!rateLimited || attempt >= 6) throw error;
                await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
            }
        }
    } as RpcTransport;
}

/** RPC clients for the devnet target plus a confirmed `send` that counts what it sends. */
export function createClient(
    rpcUrl = process.env.DEVNET_RPC_URL ?? 'https://api.devnet.solana.com',
    wsUrl = process.env.DEVNET_WS_URL ?? 'wss://api.devnet.solana.com',
) {
    const rpc = createSolanaRpcFromTransport(withRateLimitRetry(createDefaultRpcTransport({ url: rpcUrl })));
    const rpcSubscriptions = createSolanaRpcSubscriptions(wsUrl);
    const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });
    let sent = 0;

    async function send(feePayer: TransactionSigner, instructions: Instruction[]): Promise<Signature> {
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
        // Resending the same signed transaction is idempotent: the network executes a signature once.
        for (let attempt = 0; ; attempt++) {
            try {
                // Load-balanced public nodes can simulate against state older than the last confirmation.
                await sendAndConfirm(transaction, { commitment: 'confirmed', skipPreflight: true });
                sent += 1;
                return getSignatureFromTransaction(transaction);
            } catch (error) {
                if (attempt > 0) throw error;
            }
        }
    }

    return { rpc, rpcSubscriptions, send, sentCount: () => sent };
}

import { createSolanaRpc } from '@solana/kit';

import { createClient } from '../../src/client';
import { loadSigner } from '../../src/keys';

export const client = createClient();
export const mainnetRpc = createSolanaRpc(
    process.env.SURFPOOL_DATASOURCE_RPC_URL ?? 'https://api.mainnet-beta.solana.com',
);

export const keys = {
    faucet: await loadSigner('devnet-faucet'),
    issuer: await loadSigner('devnet-issuer'),
    mints: {
        QQQx: await loadSigner('devnet-qqqx'),
        SPYx: await loadSigner('devnet-spyx'),
        USDC: await loadSigner('devnet-usdc'),
        USDT: await loadSigner('devnet-usdt'),
    },
    treasury: await loadSigner('devnet-treasury'),
};

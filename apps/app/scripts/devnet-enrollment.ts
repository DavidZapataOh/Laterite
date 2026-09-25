// One real enrollment through the running app's own routes, as a new wallet with no SOL: it declares, takes the
// faucet's test dollars, has the sponsor route build and test its onboarding, signs once and hands it back, then
// reads the chain. APP_URL is the app; SOLANA_RPC_URL the cluster it sends to.
import {
    createKeyPairSignerFromPrivateKeyBytes,
    createSolanaRpc,
    getBase58Decoder,
    getBase64EncodedWireTransaction,
    getBase64Encoder,
    getTransactionDecoder,
    partiallySignTransaction,
} from '@solana/kit';
import { Engine, fetchMaybeUserConfig, findUserConfigPda, UserStatus } from '@laterite/client';
import en from '@laterite/i18n/messages/en.json' with { type: 'json' };
import { createTranslator } from 'next-intl';

import { declarationMessage, type DeclarationTranslator } from '../lib/declaration';
import { intentBody } from '../lib/onboarding';

const app = new URL(process.env.APP_URL ?? 'http://127.0.0.1:3402');
const rpcUrl = process.env.SOLANA_RPC_URL;
if (!rpcUrl) throw new Error('SOLANA_RPC_URL is required');
const rpc = createSolanaRpc(rpcUrl);
const cluster = /devnet/.test(rpcUrl) ? '?cluster=devnet' : `?cluster=custom&customUrl=${encodeURIComponent(rpcUrl)}`;
const explorer = (signature: string) => `https://explorer.solana.com/tx/${signature}${cluster}`;

async function post(path: string, body: unknown) {
    const response = await fetch(new URL(path, app), {
        body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
    });
    const answer = await response.json();
    if (!response.ok) throw new Error(`${path} answered ${response.status}: ${JSON.stringify(answer)}`);
    return answer;
}

const user = await createKeyPairSignerFromPrivateKeyBytes(crypto.getRandomValues(new Uint8Array(32)));
console.log(`wallet ${user.address} (a new key, kept only in memory)`);

const t = createTranslator({ locale: 'en', messages: en, namespace: 'declaration' }) as DeclarationTranslator;
const issuedAt = new Date().toISOString();
const text = declarationMessage(t, { domain: app.host, issuedAt, wallet: user.address });
const [signed] = await user.signMessages([{ content: new TextEncoder().encode(text), signatures: {} }]);
await post('/api/eligibility', {
    issuedAt,
    locale: 'en',
    signature: getBase58Decoder().decode(signed![user.address]!),
    wallet: user.address,
});
console.log('declared');

const grant = await post('/api/faucet', { wallet: user.address });
console.log(`faucet: $100 of test USDC and USDT, ${explorer(grant.signature)}`);

const intent = {
    kind: 'enroll' as const,
    params: {
        asset: 0,
        changeMultiplier: 0,
        cushions: [20_000_000n, 20_000_000n] as [bigint, bigint],
        engine: Engine.Daily,
        engineAmount: 0n,
        goalAmount: 0n,
        goalLabel: new Uint8Array(32),
        incomeRule: true,
        paymentTokens: 0b11,
        tier: 0,
    },
};
const { simulation, transaction } = await post('/api/sponsor/prepare', {
    intent: intentBody(intent),
    wallet: user.address,
});
console.log(
    `tested: ${simulation.computeUnits} CU, ${Buffer.from(transaction, 'base64').length} B, ` +
        `the wallet pays ${simulation.userLamports} lamports, the sponsor ${simulation.sponsorLamports}`,
);
const unsigned = getTransactionDecoder().decode(getBase64Encoder().encode(transaction));
const wallet = await partiallySignTransaction([user.keyPair], unsigned);
const { signature } = await post('/api/sponsor/submit', { transaction: getBase64EncodedWireTransaction(wallet) });
console.log(`enrolled: ${explorer(signature)}`);

const [address] = await findUserConfigPda({ user: user.address });
const account = await fetchMaybeUserConfig(rpc, address, { commitment: 'confirmed' });
const { value: lamports } = await rpc.getBalance(user.address, { commitment: 'confirmed' }).send();
if (!account.exists || account.data.status !== UserStatus.Active) throw new Error(`${address} is not active`);
if (lamports !== 0n) throw new Error(`the wallet holds ${lamports} lamports`);
console.log(`UserConfig ${address} active; the wallet holds 0 SOL`);

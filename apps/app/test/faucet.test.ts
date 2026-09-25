import { eligibilityDeclarations, faucetGrants } from '@laterite/db';
import { createTestDatabase } from '@laterite/db/testing';
import { addresses } from '@laterite/devnet/addresses';
import { type Address, createSolanaRpc, generateKeyPairSigner } from '@solana/kit';
import { fetchToken, findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { genesis } from '../e2e/support/chain';
import { faucet, keypairJson, testKey } from '../e2e/support/keys';
import { RPC_PORT, startValidator } from '../e2e/support/validator';

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let route: typeof import('@/app/api/faucet/route');
let lib: typeof import('@/lib/faucet');
let stop: () => Promise<void>;
const rpc = createSolanaRpc(`http://127.0.0.1:${RPC_PORT}`);

beforeAll(async () => {
    [db, stop] = await Promise.all([createTestDatabase(), genesis().then(accounts => startValidator(accounts))]);
    Object.assign(process.env, {
        DATABASE_URL: db.url,
        FAUCET_KEYPAIR: keypairJson(faucet),
        SOLANA_RPC_URL: `http://127.0.0.1:${RPC_PORT}`,
        SOLANA_WS_URL: `ws://127.0.0.1:${RPC_PORT + 1}`,
    });
    route = await import('@/app/api/faucet/route');
    lib = await import('@/lib/faucet');
}, 120_000);
afterAll(async () => {
    await (await import('@/lib/db')).database().$client.end();
    await Promise.all([db.drop(), stop()]);
});

/** A new wallet that declared its eligibility, as the declaration route records it. */
async function declared(): Promise<Address> {
    const { address } = await generateKeyPairSigner();
    await db.db.insert(eligibilityDeclarations).values({
        country: 'AR',
        declarationVersion: '1',
        message: 'declared',
        signature: 'signature',
        wallet: address,
    });
    return address;
}

const ask = (wallet: unknown, headers: Record<string, string> = { 'x-real-ip': '203.0.113.7' }) =>
    route.POST(
        new NextRequest('https://app.laterite.cash/api/faucet', {
            body: typeof wallet === 'string' && wallet.startsWith('{') ? wallet : JSON.stringify({ wallet }),
            headers,
            method: 'POST',
        }),
    );

async function balance(owner: Address, symbol: 'USDC' | 'USDT') {
    const [account] = await findAssociatedTokenPda({
        mint: addresses.tokens[symbol].mint,
        owner,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    return (await fetchToken(rpc, account, { commitment: 'confirmed' })).data.amount;
}

describe('/api/faucet', () => {
    it('mints $100 of test USDC and USDT to a declared wallet, creating its accounts', async () => {
        const wallet = await declared();
        const response = await ask(wallet);
        expect(response.status).toBe(201);
        expect(response.headers.get('cache-control')).toBe('no-store');
        const { amount, signature } = await response.json();
        expect(amount).toBe('100000000');
        expect([await balance(wallet, 'USDC'), await balance(wallet, 'USDT')]).toEqual([100_000_000n, 100_000_000n]);
        const [grant] = await db.db.select().from(faucetGrants).where(eq(faucetGrants.wallet, wallet));
        expect(grant).toMatchObject({ ip: '203.0.113.7', signature });
        // the faucet pays one signature's fee and the two accounts' rent, nothing else
        const landed = await rpc
            .getTransaction(signature, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 0 })
            .send();
        const rent = await rpc.getMinimumBalanceForRentExemption(165n).send();
        const { fee, postBalances, preBalances } = landed!.meta!;
        expect(fee).toBe(5_000n);
        expect(preBalances[0]! - postBalances[0]!).toBe(fee + 2n * rent);
    }, 60_000);

    it('funds a wallet once a day and an address three times', async () => {
        const [first, second, third, fourth] = await Promise.all([declared(), declared(), declared(), declared()]);
        const ip = { 'x-real-ip': '198.51.100.4' };
        expect((await ask(first, ip)).status).toBe(201);
        const again = await ask(first, { 'x-real-ip': '198.51.100.99' });
        expect(again.status).toBe(429);
        expect(Number(again.headers.get('retry-after'))).toBeGreaterThan(86_000);
        expect((await ask(second, ip)).status).toBe(201);
        expect((await ask(third, ip)).status).toBe(201);
        expect((await ask(fourth, ip)).status).toBe(429);
        expect(await balance(first, 'USDC')).toBe(100_000_000n);
    }, 60_000);

    it('lets one grant through when two requests race', async () => {
        const wallet = await declared();
        const reservations = await Promise.all([
            lib.reserveGrant(db.db, wallet, null),
            lib.reserveGrant(db.db, wallet, null),
        ]);
        expect(reservations.filter(reservation => 'id' in reservation)).toHaveLength(1);
        expect(reservations.filter(reservation => 'retryAfterSeconds' in reservation)).toHaveLength(1);
    });

    it('releases the grant when the mint fails', async () => {
        const wallet = await declared();
        process.env.FAUCET_KEYPAIR = keypairJson(testKey('not-the-mint-authority'));
        expect((await ask(wallet)).status).toBe(502);
        expect(await db.db.select().from(faucetGrants).where(eq(faucetGrants.wallet, wallet))).toEqual([]);
        process.env.FAUCET_KEYPAIR = keypairJson(faucet);
        expect((await ask(wallet, { 'x-real-ip': '192.0.2.1' })).status).toBe(201);
    }, 60_000);

    it('refuses an undeclared wallet, a blocked country and a malformed request', async () => {
        const { address } = await generateKeyPairSigner();
        expect((await ask(address)).status).toBe(403);
        expect((await ask(await declared(), { 'x-vercel-ip-country': 'US' })).status).toBe(451);
        expect((await ask('not-an-address')).status).toBe(400);
        expect((await ask('{')).status).toBe(400);
        expect((await ask(`{"wallet":"${'x'.repeat(300)}"}`)).status).toBe(413);
        expect(await db.db.select().from(faucetGrants).where(eq(faucetGrants.wallet, address))).toEqual([]);
    });
});

import {
    type Config,
    createSponsoredTransactionMessage,
    Engine,
    type EnrollParamsArgs,
    fetchMaybeUserConfig,
    findUserConfigPda,
    LATERITE_ERROR__USER_NOT_EXITED,
    UserStatus,
} from '@laterite/client';
import { eligibilityDeclarations, sponsorships } from '@laterite/db';
import { createTestDatabase } from '@laterite/db/testing';
import { addresses } from '@laterite/devnet/addresses';
import {
    AccountRole,
    type Address,
    compileTransaction,
    createKeyPairSignerFromPrivateKeyBytes,
    createNoopSigner,
    decompileTransactionMessage,
    type Instruction,
    type MicroLamports,
    pipe,
    setTransactionMessageComputeUnitLimit,
    setTransactionMessageLifetimeUsingBlockhash,
    createSolanaRpc,
    generateKeyPairSigner,
    getBase64EncodedWireTransaction,
    getBase64Encoder,
    getCompiledTransactionMessageDecoder,
    getCompiledTransactionMessageEncoder,
    getTransactionDecoder,
    type KeyPairSigner,
    partiallySignTransaction,
    signBytes,
    type Transaction,
    type V0CompiledTransactionMessage,
} from '@solana/kit';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { genesis } from '../e2e/support/chain';
import { testConfig } from '../e2e/support/config';
import { faucet, keypairJson, sponsor, users } from '../e2e/support/keys';
import { CLOSED_RPC_PORT, RPC_PORT, startValidator } from '../e2e/support/validator';
import { intentBody, type OnboardingIntent } from '@/lib/onboarding';

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let prepareRoute: typeof import('@/app/api/sponsor/prepare/route');
let submitRoute: typeof import('@/app/api/sponsor/submit/route');
let ledger: typeof import('@/lib/sponsorships');
let stops: (() => Promise<void>)[];
// clear of the faucet tests' chain, which runs beside this file
const [OPEN_PORT, CLOSED_PORT] = [RPC_PORT + 100, CLOSED_RPC_PORT + 100];
const rpc = createSolanaRpc(`http://127.0.0.1:${OPEN_PORT}`);
const open = { SOLANA_RPC_URL: `http://127.0.0.1:${OPEN_PORT}`, SOLANA_WS_URL: `ws://127.0.0.1:${OPEN_PORT + 1}` };
const closed = {
    SOLANA_RPC_URL: `http://127.0.0.1:${CLOSED_PORT}`,
    SOLANA_WS_URL: `ws://127.0.0.1:${CLOSED_PORT + 1}`,
};

beforeAll(async () => {
    const [created, ...started] = await Promise.all([
        createTestDatabase(),
        genesis().then(accounts => startValidator(accounts, OPEN_PORT)),
        genesis({ paused: true }).then(accounts => startValidator(accounts, CLOSED_PORT)),
    ]);
    [db, stops] = [created, started];
    Object.assign(process.env, {
        DATABASE_URL: db.url,
        FAUCET_KEYPAIR: keypairJson(faucet),
        SPONSOR_KEYPAIR: keypairJson(sponsor),
        ...open,
    });
    prepareRoute = await import('@/app/api/sponsor/prepare/route');
    submitRoute = await import('@/app/api/sponsor/submit/route');
    ledger = await import('@/lib/sponsorships');
}, 120_000);
afterAll(async () => {
    await (await import('@/lib/db')).database().$client.end();
    await Promise.all([db.drop(), ...stops.map(stop => stop())]);
});

const ip = { 'x-real-ip': '203.0.113.9' };

/** Records `wallet`'s declaration, as the eligibility route does. */
async function declare(wallet: Address) {
    await db.db.insert(eligibilityDeclarations).values({
        country: 'AR',
        declarationVersion: '1',
        message: 'declared',
        signature: 'signature',
        wallet,
    });
}

/** A new wallet with no SOL that declared and holds $100 of test USDC and USDT, from the faucet. */
async function funded(): Promise<KeyPairSigner> {
    const signer = await generateKeyPairSigner();
    await declare(signer.address);
    const { faucetSigner, sendFaucet } = await import('@/lib/faucet');
    await sendFaucet(await faucetSigner(), signer.address);
    return signer;
}

const params = (changes: Partial<EnrollParamsArgs> = {}): EnrollParamsArgs => ({
    asset: 0,
    changeMultiplier: 0,
    cushions: [20_000_000n, 20_000_000n],
    engine: Engine.Daily,
    engineAmount: 0n,
    goalAmount: 0n,
    goalLabel: new Uint8Array(32),
    incomeRule: true,
    paymentTokens: 0b11,
    tier: 0,
    ...changes,
});

const post = (path: string, body: unknown, headers: Record<string, string> = ip) =>
    new NextRequest(`https://app.laterite.cash/api/sponsor/${path}`, {
        body: typeof body === 'string' ? body : JSON.stringify(body),
        headers,
        method: 'POST',
    });

const prepare = (wallet: Address, intent: OnboardingIntent, headers?: Record<string, string>) =>
    prepareRoute.POST(post('prepare', { intent: intentBody(intent), wallet }, headers));

const decode = (wire: string): Transaction => getTransactionDecoder().decode(getBase64Encoder().encode(wire));

/** A sponsored transaction's compiled message: version 0. */
const compiledOf = (transaction: Transaction) =>
    getCompiledTransactionMessageDecoder().decode(transaction.messageBytes) as V0CompiledTransactionMessage & {
        lifetimeToken: string;
    };

/** The wallet's signature on a prepared transaction, then the submit route's answer. */
async function signAndSubmit(wire: string, signer: KeyPairSigner, headers?: Record<string, string>) {
    const signed = await partiallySignTransaction([signer.keyPair], decode(wire));
    return submitRoute.POST(post('submit', { transaction: getBase64EncodedWireTransaction(signed) }, headers));
}

async function userConfig(user: Address) {
    const [address] = await findUserConfigPda({ user });
    return fetchMaybeUserConfig(rpc, address, { commitment: 'confirmed' });
}

describe('/api/sponsor', () => {
    it('enrolls a wallet with no SOL: the route builds and simulates, the wallet signs once, the sponsor co-signs', async () => {
        const user = await funded();
        const prepared = await prepare(user.address, { kind: 'enroll', params: params() });
        expect(prepared.status).toBe(200);
        expect(prepared.headers.get('cache-control')).toBe('no-store');
        const { simulation, transaction } = await prepared.json();
        // the route set the compute-unit price and a limit 10% above the simulation, and nobody signed yet
        const unsigned = decode(transaction);
        expect(Object.values(unsigned.signatures)).toEqual([null, null]);
        const message = compiledOf(unsigned);
        expect(message.staticAccounts.slice(0, 2)).toEqual([sponsor.address, user.address]);
        const [limit, price] = message.instructions;
        const units = new DataView(limit!.data!.buffer, limit!.data!.byteOffset).getUint32(1, true);
        expect(units).toBe(Math.ceil(simulation.computeUnits * 1.1));
        expect(new DataView(price!.data!.buffer, price!.data!.byteOffset).getBigUint64(1, true)).toBe(1_000n);
        expect(simulation.userLamports).toBe('0');
        console.log(
            `onboarding of both tokens: ${Buffer.from(transaction, 'base64').length} B, ` +
                `${simulation.computeUnits} CU, limit ${units}, the sponsor pays ${simulation.sponsorLamports} lamports`,
        );
        expect(Buffer.from(transaction, 'base64').length).toBe(973);

        const submitted = await signAndSubmit(transaction, user);
        expect(submitted.status).toBe(200);
        const { signature } = await submitted.json();
        const account = await userConfig(user.address);
        expect(account.exists && account.data.status).toBe(UserStatus.Active);
        expect((await rpc.getBalance(user.address, { commitment: 'confirmed' }).send()).value).toBe(0n);
        const [row] = await db.db.select().from(sponsorships).where(eq(sponsorships.wallet, user.address));
        expect(row).toMatchObject({
            assetAccount: addresses.tokens.SPYx.mint,
            ip: '203.0.113.9',
            kind: 'enroll',
            outcome: 'landed',
            signature,
        });
        const landed = await rpc
            .getTransaction(signature, { commitment: 'confirmed', encoding: 'json', maxSupportedTransactionVersion: 0 })
            .send();
        const { fee, postBalances, preBalances } = landed!.meta!;
        expect(String(preBalances[0]! - postBalances[0]!)).toBe(simulation.sponsorLamports);
        expect(fee).toBe(BigInt(simulation.feeLamports));

        // once per wallet is the program's: a second onboarding is refused before anything is built
        expect(await (await prepare(user.address, { kind: 'enroll', params: params() })).json()).toEqual({
            error: 'enrolled',
        });
        // and the landed message cannot be sent again
        expect((await signAndSubmit(transaction, user)).status).toBe(400);
    }, 120_000);

    it('brings an exited wallet back with the reactivation shape, and refuses the wrong shape for a wallet', async () => {
        const returning = await createKeyPairSignerFromPrivateKeyBytes(
            Buffer.from(users.returning.jwk.d!, 'base64url'),
        );
        await declare(returning.address);
        const back = { kind: 'reactivate' as const, params: params({ paymentTokens: 0b01, tier: 1 }) };
        expect(await (await prepare(returning.address, { ...back, kind: 'enroll' })).json()).toEqual({
            error: 'enrolled',
        });
        const prepared = await prepare(returning.address, back);
        expect(prepared.status).toBe(200);
        const { transaction } = await prepared.json();
        expect((await signAndSubmit(transaction, returning)).status).toBe(200);
        const account = await userConfig(returning.address);
        expect(account.exists && [account.data.status, account.data.tier]).toEqual([UserStatus.Active, 1]);
        const fresh = await funded();
        expect(await (await prepare(fresh.address, { kind: 'reactivate', params: params() })).json()).toEqual({
            code: LATERITE_ERROR__USER_NOT_EXITED,
            error: 'check',
        });
    }, 120_000);

    it('co-signs only the exact message it prepared, signed by its wallet', async () => {
        const user = await funded();
        const { transaction } = await (await prepare(user.address, { kind: 'enroll', params: params() })).json();
        const unsigned = decode(transaction);
        // the compute-unit price one micro-lamport higher: no longer the message the route prepared
        const compiled = compiledOf(unsigned);
        const [limit, price, ...rest] = compiled.instructions;
        const data = new Uint8Array(price!.data!);
        data[1]! ^= 1;
        const tampered = {
            ...unsigned,
            messageBytes: getCompiledTransactionMessageEncoder().encode({
                ...compiled,
                instructions: [limit!, { ...price!, data }, ...rest],
            } as never) as Transaction['messageBytes'],
        };
        const other = await generateKeyPairSigner();
        const cases: [Transaction, KeyPairSigner | null, number, string][] = [
            [tampered, user, 400, 'unknown'],
            [unsigned, null, 400, 'signature'],
            [unsigned, other, 400, 'signature'],
        ];
        for (const [candidate, signer, status, error] of cases) {
            const signed = signer
                ? {
                      ...candidate,
                      signatures: {
                          ...candidate.signatures,
                          [user.address]: await signBytes(signer.keyPair.privateKey, candidate.messageBytes),
                      },
                  }
                : candidate;
            const response = await submitRoute.POST(
                post('submit', { transaction: getBase64EncodedWireTransaction(signed) }),
            );
            expect([response.status, (await response.json()).error]).toEqual([status, error]);
        }
        expect((await signAndSubmit(transaction, user)).status).toBe(200);
    }, 120_000);

    it('refuses to prepare or co-sign while the program is paused', async () => {
        const user = await funded();
        const { transaction } = await (await prepare(user.address, { kind: 'enroll', params: params() })).json();
        Object.assign(process.env, closed);
        try {
            expect(await (await prepare(user.address, { kind: 'enroll', params: params() })).json()).toEqual({
                error: 'paused',
            });
            const response = await signAndSubmit(transaction, user);
            expect([response.status, await response.json()]).toEqual([409, { error: 'paused' }]);
        } finally {
            Object.assign(process.env, open);
        }
    }, 120_000);

    it('pays for an asset account at most once per wallet and asset', async () => {
        const user = await funded();
        const paid = {
            assetAccount: addresses.tokens.SPYx.mint,
            computeUnitLimit: 1,
            computeUnitPrice: 1_000n,
            computeUnits: 1,
            kind: 'enroll' as const,
            lastValidBlockHeight: 0n,
            message: `paid-${user.address}`,
            outcome: 'landed' as const,
            sentAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
            sponsorLamports: 1n,
            wallet: user.address,
        };
        await db.db.insert(sponsorships).values(paid);
        expect(await (await prepare(user.address, { kind: 'enroll', params: params() })).json()).toEqual({
            asset: addresses.tokens.SPYx.mint,
            error: 'asset-account',
        });
        // QQQx's account was never paid for
        expect((await prepare(user.address, { kind: 'enroll', params: params({ asset: 1 }) })).status).toBe(200);
    }, 120_000);

    it('limits sends per wallet, per address and returns per wallet, and builds per hour', async () => {
        const now = Date.now();
        const row = (wallet: string, index: number, changes: Partial<typeof sponsorships.$inferInsert> = {}) => ({
            computeUnitLimit: 1,
            computeUnitPrice: 1_000n,
            computeUnits: 1,
            kind: 'enroll' as const,
            lastValidBlockHeight: 0n,
            message: `limit-${wallet}-${index}-${now}`,
            outcome: 'landed' as const,
            sentAt: new Date(now - (index + 1) * 60_000),
            sponsorLamports: 1n,
            wallet,
            ...changes,
        });
        const busy = await funded();
        await db.db.insert(sponsorships).values([0, 1, 2].map(index => row(busy.address, index)));
        const limited = await prepare(busy.address, { kind: 'enroll', params: params() });
        expect([limited.status, await limited.json()]).toEqual([429, { error: 'limited', limit: 'wallet' }]);
        expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(86_000);

        const crowded = { 'x-real-ip': '198.51.100.23' };
        const others = await Promise.all(Array.from({ length: 10 }, () => generateKeyPairSigner()));
        await db.db
            .insert(sponsorships)
            .values(others.map(({ address }, index) => row(address, index, { ip: crowded['x-real-ip'] })));
        const user = await funded();
        expect(await (await prepare(user.address, { kind: 'enroll', params: params() }, crowded)).json()).toEqual({
            error: 'limited',
            limit: 'ip',
        });

        const churn = await funded();
        await db.db
            .insert(sponsorships)
            .values([
                row(churn.address, 0, { kind: 'reactivate', sentAt: new Date(now - 3 * 86_400_000) }),
                row(churn.address, 1, { kind: 'reactivate', sentAt: new Date(now - 20 * 86_400_000) }),
            ]);
        expect(await (await prepare(churn.address, { kind: 'reactivate', params: params() })).json()).toEqual({
            error: 'limited',
            limit: 'returns',
        });

        const eager = await funded();
        await db.db.insert(sponsorships).values(
            Array.from({ length: 20 }, (_, index) =>
                row(eager.address, index, {
                    outcome: 'prepared',
                    preparedAt: new Date(now - 60_000),
                    sentAt: null,
                }),
            ),
        );
        expect(await (await prepare(eager.address, { kind: 'enroll', params: params() })).json()).toEqual({
            error: 'limited',
            limit: 'prepare',
        });
    }, 120_000);

    it('co-signs the onboarding and reactivation shapes only', async () => {
        const { onboardingLookupTable, shapeProblem } = await import('@/lib/sponsor');
        type ShapeContext = Parameters<typeof shapeProblem>[1];
        const config: Config = testConfig({ sponsor: sponsor.address });
        const lookupTable = await onboardingLookupTable(rpc, config);
        const user = await funded();
        const { transaction } = await (await prepare(user.address, { kind: 'enroll', params: params() })).json();
        const prepared = decode(transaction);
        const context: ShapeContext = {
            config,
            kind: 'enroll',
            lookupTable,
            sponsor: sponsor.address,
            user: user.address,
        };
        expect(await shapeProblem(prepared, context)).toBeNull();

        const compiled = compiledOf(prepared);
        const original = decompileTransactionMessage(compiled as never, { addressesByLookupTableAddress: lookupTable });
        const [, , ...body] = original.instructions;
        const lifetime = { blockhash: compiled.lifetimeToken as never, lastValidBlockHeight: 0n };
        /** The same transaction with other instructions, fee payer or budget, compiled as the route compiles one. */
        const variant = (
            instructions: readonly Instruction[],
            { limit = 80_000, payer = sponsor.address, price = 1_000n } = {},
        ) =>
            compileTransaction(
                pipe(
                    createSponsoredTransactionMessage({
                        computeUnitPrice: price as MicroLamports,
                        instructions,
                        lookupTable,
                        sponsor: createNoopSigner(payer),
                    }),
                    m => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
                    m => setTransactionMessageComputeUnitLimit(limit, m),
                ),
            );
        const thief = (await generateKeyPairSigner()).address;
        const drain: Instruction = {
            accounts: [
                { address: sponsor.address, role: AccountRole.WRITABLE_SIGNER },
                { address: thief, role: AccountRole.WRITABLE },
            ],
            // System Program Transfer of 1 SOL
            data: new Uint8Array([2, 0, 0, 0, 0, 202, 154, 59, 0, 0, 0, 0]),
            programAddress: '11111111111111111111111111111111' as Address,
        };
        const [asset] = body;
        // an account in USDC instead of SPYx; the metas lose their lookup indexes, so the address is the one compiled
        const usdcAccount = {
            ...asset!,
            accounts: asset!.accounts!.map(({ address, role }) => ({
                address: address === addresses.tokens.SPYx.mint ? addresses.tokens.USDC.mint : address,
                role,
            })),
        };
        const enroll = body.at(-1)!;
        const refusals: [string, Transaction, ShapeContext][] = [
            ['a transfer from the sponsor', variant([drain, ...body]), context],
            ['a transfer after enrolling', variant([...body, drain]), context],
            ['an account in a payment token', variant([usdcAccount, ...body.slice(1)]), context],
            ['enroll before the subscriptions', variant([enroll, ...body.slice(0, -1)]), context],
            ['the wrong kind', variant(body), { ...context, kind: 'reactivate' }],
            ['a limit above the bound', variant(body, { limit: 1_400_000 }), context],
            ['a price above the bound', variant(body, { price: 1_000_000n }), context],
            ['another fee payer', variant(body, { payer: user.address }), context],
            ['another user', variant(body), { ...context, user: thief }],
        ];
        expect(await shapeProblem(variant(body), context)).toBeNull();
        const problems = await Promise.all(refusals.map(([, candidate, shape]) => shapeProblem(candidate, shape)));
        expect(Object.fromEntries(refusals.map(([name], index) => [name, problems[index]]))).toEqual({
            'a limit above the bound': 'the compute-unit limit is too high',
            'a price above the bound': 'the compute-unit price is too high',
            'a transfer after enrolling': 'instruction 7: it is not part of onboarding',
            'a transfer from the sponsor': 'instruction 2: it is not part of onboarding',
            'an account in a payment token': 'instruction 2: the mint is not an asset',
            'another fee payer': 'the sponsor is not the fee payer',
            'another user': 'the user is not the second signer',
            'enroll before the subscriptions': 'instruction 2: it is not part of onboarding',
            'the wrong kind': 'instruction 7: it is not part of a reactivation',
        });
    }, 120_000);

    it('lets one of two racing submissions of a message through', async () => {
        const user = await funded();
        const { transaction } = await (await prepare(user.address, { kind: 'enroll', params: params() })).json();
        const message = (await import('@/lib/sponsor')).messageHash(decode(transaction).messageBytes);
        const claims = await Promise.all([
            ledger.claimSend(db.db, { ip: null, message, wallet: user.address }),
            ledger.claimSend(db.db, { ip: null, message, wallet: user.address }),
        ]);
        expect(claims.map(claim => claim.ok).sort()).toEqual([false, true]);

        // ten messages claimed at once: the lock lets exactly the wallet's three a day through
        const wallet = (await generateKeyPairSigner()).address;
        const messages = Array.from({ length: 10 }, (_, index) => `race-${wallet}-${index}`);
        await db.db.insert(sponsorships).values(
            messages.map(hash => ({
                computeUnitLimit: 1,
                computeUnitPrice: 1_000n,
                computeUnits: 1,
                kind: 'enroll' as const,
                lastValidBlockHeight: 0n,
                message: hash,
                sponsorLamports: 1n,
                wallet,
            })),
        );
        const burst = await Promise.all(
            messages.map(hash => ledger.claimSend(db.db, { ip: null, message: hash, wallet })),
        );
        expect(burst.filter(claim => claim.ok)).toHaveLength(3);
    }, 120_000);

    it('refuses an undeclared wallet, a blocked country and a malformed request', async () => {
        const { address } = await generateKeyPairSigner();
        const intent = { kind: 'enroll' as const, params: params() };
        expect((await prepare(address, intent)).status).toBe(403);
        await declare(address);
        expect((await prepare(address, intent, { 'x-vercel-ip-country': 'US' })).status).toBe(451);
        expect((await prepareRoute.POST(post('prepare', '{'))).status).toBe(400);
        expect(
            (await prepareRoute.POST(post('prepare', { intent: { kind: 'enroll', params: 'AAAA' }, wallet: address })))
                .status,
        ).toBe(400);
        expect((await prepareRoute.POST(post('prepare', 'x'.repeat(3000)))).status).toBe(413);
        expect((await submitRoute.POST(post('submit', { transaction: 'not a transaction' }))).status).toBe(400);
        expect(await db.db.select().from(sponsorships).where(eq(sponsorships.wallet, address))).toEqual([]);
    });
});

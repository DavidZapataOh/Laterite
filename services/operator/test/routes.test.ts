import { readFileSync } from 'node:fs';

import { findSwapAuthorityPda } from '@laterite/client';
import type { JupiterBuildResponse } from '@laterite/client/node';
import { type Database, swapAccountCreations } from '@laterite/db';
import { createTestDatabase } from '@laterite/db/testing';
import {
    type Address,
    type GetMultipleAccountsApi,
    generateKeyPairSigner,
    type Instruction,
    type KeyPairSigner,
    type Rpc,
} from '@solana/kit';
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { jupiterRoutes, NoRouteError, SwapAccountBoundError } from '../src/crank/routes';
import { createLogger } from '../src/log';
import type { Sender } from '../src/send';

// USDT into SPYx through USDC (Raydium CLMM, then Whirlpool), the swap authority as taker, as Jupiter answered it.
const recorded = JSON.parse(
    readFileSync(new URL('../../../clients/typescript/test/recorded/jupiter-build.json', import.meta.url), 'utf8'),
) as JupiterBuildResponse;
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address;
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB' as Address;
const SPYX = 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W' as Address;
const USER_SPYX = '9YcwsVTffFnAXUQAvPiNQNhYGi5AwsDt8hrTngtD2YsD' as Address;

describe("the crank's Jupiter routes", () => {
    let db: Database;
    let drop: () => Promise<void>;
    let crank: KeyPairSigner;
    let swapAuthority: Address;
    let swapUsdc: Address;
    const missing = new Set<Address>();
    /** Mints the test hands to another program. */
    const wrongOwner = new Set<Address>();
    const sent: Instruction[][] = [];
    const urls: URL[] = [];
    let answers: JupiterBuildResponse[] = [];

    /** A cluster where every account exists but those in `missing`, the mints owned by their token programs. */
    const rpc = {
        getMultipleAccounts: (addresses: Address[]) => ({
            send: async () => ({
                context: { slot: 0n },
                value: addresses.map(address =>
                    missing.has(address)
                        ? null
                        : {
                              data: ['', 'base64'],
                              executable: false,
                              lamports: 1n,
                              owner: wrongOwner.has(address)
                                  ? address
                                  : address === SPYX
                                    ? TOKEN_2022_PROGRAM_ADDRESS
                                    : [USDC, USDT].includes(address)
                                      ? TOKEN_PROGRAM_ADDRESS
                                      : address,
                              space: 0n,
                          },
                ),
            }),
        }),
    } as unknown as Rpc<GetMultipleAccountsApi>;
    /** The crank's sender: records what it would send, and the account it creates then exists. */
    const sender = () =>
        ({
            build: async (instructions: Instruction[]) => instructions,
            payer: crank,
            send: async (instructions: Instruction[]) => {
                sent.push(instructions);
                for (const { accounts = [] } of instructions) missing.delete(accounts[1]!.address);
                return 'signature';
            },
        }) as unknown as Sender;
    const fetch = (async (url: string) => {
        urls.push(new URL(url));
        return new Response(JSON.stringify(answers.shift() ?? recorded));
    }) as typeof globalThis.fetch;
    const request = () => ({
        amount: BigInt(recorded.inAmount),
        asset: { mint: SPYX, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS },
        excludeVenues: [],
        payment: { mint: USDT, tokenProgram: TOKEN_PROGRAM_ADDRESS },
        swapAuthority,
        userAssetAccount: USER_SPYX,
    });
    const routes = () => jupiterRoutes({ db, fetch, log: createLogger('silent'), rpc, sender: sender() });

    beforeAll(async () => {
        ({ db, drop } = await createTestDatabase());
        crank = await generateKeyPairSigner();
        [swapAuthority] = await findSwapAuthorityPda();
        [swapUsdc] = await findAssociatedTokenPda({
            mint: USDC,
            owner: swapAuthority,
            tokenProgram: TOKEN_PROGRAM_ADDRESS,
        });
    });
    afterAll(() => drop());
    beforeEach(async () => {
        await db.delete(swapAccountCreations);
        missing.clear();
        wrongOwner.clear();
        sent.length = 0;
        urls.length = 0;
        answers = [];
    });

    it("creates the swap authority's account a route needs, records it, and builds the route again", async () => {
        missing.add(swapUsdc);
        const route = await routes()(request());
        expect(route).toMatchObject({ quoted: BigInt(recorded.outAmount), venues: ['Raydium CLMM', 'Whirlpool'] });
        expect(sent).toHaveLength(1);
        expect(sent[0]!.map(({ accounts }) => accounts![1]!.address)).toEqual([swapUsdc]);
        expect(await db.select().from(swapAccountCreations)).toMatchObject([
            { address: swapUsdc, mint: USDC, signature: 'signature', tokenProgram: TOKEN_PROGRAM_ADDRESS },
        ]);
        expect(urls).toHaveLength(2);
        expect(Object.fromEntries(urls[0]!.searchParams)).toMatchObject({ maxAccounts: '40', slippageBps: '55' });
    });

    it('creates no account past five in 24 hours: the route waits for an operator', async () => {
        await db.insert(swapAccountCreations).values(
            [1, 2, 3, 4, 5].map(index => ({
                address: `account-${index}`,
                mint: `mint-${index}`,
                signature: `creation-${index}`,
                tokenProgram: TOKEN_PROGRAM_ADDRESS,
            })),
        );
        missing.add(swapUsdc);
        await expect(routes()(request())).rejects.toBeInstanceOf(SwapAccountBoundError);
        expect(sent).toHaveLength(0);
    });

    it('creates no account in a mint its token program does not own', async () => {
        missing.add(swapUsdc);
        wrongOwner.add(USDC);
        await expect(routes()(request())).rejects.toThrow(`${USDC} is not a mint of ${TOKEN_PROGRAM_ADDRESS}`);
        expect(sent).toHaveLength(0);
    });

    it('asks for classic pools only after the builder refuses a route that names the crank', async () => {
        const withCrank = structuredClone(recorded);
        withCrank.swapInstruction.accounts.push({ isSigner: false, isWritable: true, pubkey: crank.address });
        answers = [withCrank];
        await routes()({ ...request(), excludeVenues: ['Whirlpool'] });
        expect(urls.map(url => url.searchParams.get('dexes'))).toEqual([null, 'Raydium CLMM']);
        expect(urls[0]!.searchParams.get('excludeDexes')).toBe('Whirlpool');
    });

    it('builds a route again when Jupiter read its state more than 10 s ago, and gives up after four', async () => {
        const stale = {
            ...recorded,
            blockhashWithMetadata: { fetchedAt: { secs_since_epoch: Date.now() / 1_000 - 11 } },
        };
        answers = [stale];
        await expect(routes()(request())).resolves.toMatchObject({ venues: ['Raydium CLMM', 'Whirlpool'] });
        expect(urls).toHaveLength(2);
        answers = [stale, stale, stale, stale];
        await expect(routes()(request())).rejects.toBeInstanceOf(NoRouteError);
    });
});

import { readFileSync } from 'node:fs';

import {
    type Address,
    getBase64Encoder,
    type GetMultipleAccountsApi,
    type GetSignaturesForAddressApi,
    type GetTransactionApi,
    isWritableRole,
    lamports,
    type Rpc,
} from '@solana/kit';
import { createRpcFromSvm } from '@solana/kit-plugin-litesvm';
import { LiteSVM } from 'litesvm';
import { describe, expect, it } from 'vitest';

import {
    decodePythStorage,
    fetchPythStorage,
    findSwapAuthorityPda,
    PYTH_PRO_PROGRAM_ADDRESS,
    PYTH_STORAGE_ADDRESS,
    verifyPythUpdate,
} from '../src';
import {
    buildJupiterSweepRoute,
    fetchLatestKaminoUpdate,
    fetchPythProUpdate,
    getJupiterSweepRoute,
    getPythUpdateFromTransaction,
    type JupiterBuildResponse,
    KAMINO_SCOPE_PROGRAM_ADDRESS,
    PYTH_USDT_FEED_ID,
    toJupiterSwap,
} from '../src/node';
import { fixture, PYTH, PYTH_SPYX_QQQX, PYTH_UPDATES_AT, PYTH_USDT } from './fixtures';

const local = (name: string) => JSON.parse(readFileSync(new URL(`recorded/${name}`, import.meta.url), 'utf8'));
const kamino = local('kamino-transaction.json') as { blockTime: number; transaction: [string, 'base64'] };
const PYTH_SIGNER = '9gKEEcFzSd1PDYBKWAKZi4Sq4ZCUaVX5oTr8kEjdwsfR' as Address;

describe('the Kamino Scope relay', () => {
    it("slices the update out of its source transaction at the ed25519 instruction's offsets", () => {
        const update = getPythUpdateFromTransaction(getBase64Encoder().encode(kamino.transaction[0]));
        expect(update).toEqual(PYTH_SPYX_QQQX);
        expect(BigInt(kamino.blockTime)).toBe(PYTH_UPDATES_AT);
    });

    it("reads Scope's latest post carrying the asset's feed: a transaction both Scope's and Pyth Pro's lists name", async () => {
        const calls: string[] = [];
        const rpc = {
            getSignaturesForAddress: (address: Address) => ({
                send: async () => {
                    calls.push(`signatures ${address}`);
                    const scope = address === KAMINO_SCOPE_PROGRAM_ADDRESS;
                    return scope
                        ? [
                              { err: null, signature: 'refresh' },
                              { err: null, signature: 'd5LT' },
                          ]
                        : [
                              { err: null, signature: 'other' },
                              { err: null, signature: 'd5LT' },
                          ];
                },
            }),
            getTransaction: (signature: string, config: { maxSupportedTransactionVersion: number }) => ({
                send: async () => {
                    calls.push(`transaction ${signature} v${config.maxSupportedTransactionVersion}`);
                    return kamino;
                },
            }),
        } as unknown as Rpc<GetSignaturesForAddressApi & GetTransactionApi>;
        const latest = await fetchLatestKaminoUpdate(rpc, 1843);
        expect(latest.message).toEqual(PYTH_SPYX_QQQX);
        expect(calls).toEqual([
            `signatures ${KAMINO_SCOPE_PROGRAM_ADDRESS}`,
            `signatures ${PYTH_STORAGE_ADDRESS}`,
            'transaction d5LT v1',
        ]);
        await expect(fetchLatestKaminoUpdate(rpc, 9_999)).rejects.toThrow('feed 9999');
    });
});

describe('Pyth Pro updates checked as Pyth Pro will check them', () => {
    for (const cluster of ['mainnet', 'devnet']) {
        it(`trusts the production signer on ${cluster}`, async () => {
            const storage = decodePythStorage(new Uint8Array(fixture(`pyth_storage_${cluster}.bin`)));
            expect(storage.trustedSigners.map(signer => signer.pubkey)).toContain(PYTH_SIGNER);
            expect(storage.treasury).toBe(
                cluster === 'mainnet'
                    ? 'Gx4MBPb1vqZLJajZmsKLg8fGw9ErhoKsR8LeKcCKFyak'
                    : 'opsLibxVY7Vz5eYMmSfX8cLFCFVYTtH6fr6MiifMpA7',
            );
            for (const update of [PYTH_SPYX_QQQX, PYTH_USDT]) {
                expect((await verifyPythUpdate(update, storage, PYTH_UPDATES_AT)).publicKey).toBe(PYTH_SIGNER);
            }
            const tampered = PYTH_SPYX_QQQX.slice();
            tampered[200]! ^= 1;
            await expect(verifyPythUpdate(tampered, storage, PYTH_UPDATES_AT)).rejects.toThrow('does not verify');
            const untrusted = {
                ...storage,
                trustedSigners: storage.trustedSigners.filter(signer => signer.pubkey !== PYTH_SIGNER),
            };
            await expect(verifyPythUpdate(PYTH_SPYX_QQQX, untrusted, PYTH_UPDATES_AT)).rejects.toThrow(
                'does not trust',
            );
        });
    }

    it('reads the storage only from an account Pyth Pro owns', async () => {
        const svm = new LiteSVM();
        const rpc = createRpcFromSvm(svm);
        const data = new Uint8Array(fixture('pyth_storage_devnet.bin'));
        const write = (programAddress: Address) =>
            svm.setAccount({
                address: PYTH_STORAGE_ADDRESS,
                data,
                executable: false,
                lamports: lamports(svm.minimumBalanceForRentExemption(BigInt(data.length))),
                programAddress,
                space: BigInt(data.length),
            });
        write(PYTH_PRO_PROGRAM_ADDRESS);
        expect((await fetchPythStorage(rpc)).treasury).toBe(PYTH.devnet.treasury);
        write(PYTH_SIGNER);
        await expect(fetchPythStorage(rpc)).rejects.toThrow("not Pyth Pro's account");
    });

    it('fetches the latest USDT/USD update from the price service with the access token', async () => {
        const requests: { body: unknown; headers: HeadersInit | undefined; url: string }[] = [];
        const fetch = (async (url: string, init?: RequestInit) => {
            requests.push({ body: JSON.parse(String(init?.body)), headers: init?.headers, url });
            return new Response(
                JSON.stringify({ solana: { data: Buffer.from(PYTH_USDT).toString('hex'), encoding: 'hex' } }),
            );
        }) as typeof globalThis.fetch;
        const update = await fetchPythProUpdate({ accessToken: 'token', fetch, priceFeedIds: [PYTH_USDT_FEED_ID] });
        expect(update).toEqual(PYTH_USDT);
        expect(requests).toEqual([
            {
                body: {
                    channel: 'fixed_rate@200ms',
                    formats: ['solana'],
                    jsonBinaryEncoding: 'hex',
                    priceFeedIds: [8],
                    properties: ['price', 'exponent', 'confidence', 'feedUpdateTimestamp'],
                },
                headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
                url: 'https://pyth-lazer.dourolabs.app/v1/latest_price',
            },
        ]);
        const refused = (async () =>
            new Response('Not entitled', { status: 403 })) as unknown as typeof globalThis.fetch;
        await expect(
            fetchPythProUpdate({ accessToken: 'token', fetch: refused, priceFeedIds: [1843] }),
        ).rejects.toThrow('403');
    });
});

describe('Jupiter routes for the sweep', () => {
    const recorded = local('jupiter-build.json') as JupiterBuildResponse;

    it('takes route_v2 with the swap authority as its only signer, when every account it names exists', async () => {
        const [swapAuthority] = await findSwapAuthorityPda();
        const amount = BigInt(recorded.inAmount);
        // The recorded route still creates the swap authority's SPYx account; the deployment creates it once.
        expect(() => getJupiterSweepRoute(toJupiterSwap(recorded), { amount, swapAuthority })).toThrow('lacks');
        const ready = toJupiterSwap({ ...recorded, setupInstructions: [] });
        const route = getJupiterSweepRoute(ready, { amount, swapAuthority });
        expect(route.accounts!.filter(meta => meta.role >= 2).map(meta => meta.address)).toEqual([swapAuthority]);
        expect(() => getJupiterSweepRoute(ready, { amount: amount + 1n, swapAuthority })).toThrow('exactly');
        const data = new Uint8Array(ready.swap.data!);
        data[26] = 1;
        expect(() =>
            getJupiterSweepRoute({ ...ready, swap: { ...ready.swap, data } }, { amount, swapAuthority }),
        ).toThrow('fee');
    });

    it("requests the sweep's route with ADR-001's parameters", async () => {
        const [swapAuthority] = await findSwapAuthorityPda();
        const urls: URL[] = [];
        const fetch = (async (url: string) => {
            urls.push(new URL(url));
            return new Response(JSON.stringify({ ...recorded, setupInstructions: [] }));
        }) as typeof globalThis.fetch;
        // A cluster where every account exists but, when named, one.
        let missing: Address | undefined;
        const rpc = {
            getMultipleAccounts: (addresses: Address[]) => ({
                send: async () => ({
                    context: { slot: 0n },
                    value: addresses.map(address =>
                        address === missing
                            ? null
                            : { data: ['', 'base64'], executable: false, lamports: 1n, owner: address, space: 0n },
                    ),
                }),
            }),
        } as unknown as Rpc<GetMultipleAccountsApi>;
        const input = {
            amount: BigInt(recorded.inAmount),
            assetMint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W' as Address,
            crank: '9gKEEcFzSd1PDYBKWAKZi4Sq4ZCUaVX5oTr8kEjdwsfR' as Address,
            fetch,
            paymentMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' as Address,
            rpc,
            swapAuthority,
            userAssetAccount: 'A3TC96dqXjDdjbMJLsXvDBReye2G5tLVBmUdqTyewgHU' as Address,
        };
        const { outAmount, route } = await buildJupiterSweepRoute(input);
        expect(outAmount).toBe(BigInt(recorded.outAmount));
        expect(route.programAddress).toBe('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
        expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({
            amount: recorded.inAmount,
            destinationTokenAccount: input.userAssetAccount,
            inputMint: input.paymentMint,
            maxAccounts: '40',
            outputMint: input.assetMint,
            payer: input.crank,
            slippageBps: '100',
            taker: swapAuthority,
            wrapAndUnwrapSol: 'false',
        });
        missing = route.accounts!.find(meta => isWritableRole(meta.role))!.address;
        await expect(buildJupiterSweepRoute(input)).rejects.toThrow(`do not exist: ${missing}`);
    });
});

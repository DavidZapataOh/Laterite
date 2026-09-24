import {
    createSponsoredTransactionMessage,
    createSweepTransactionMessage,
    Engine,
    type EnrollParamsArgs,
    fetchConfig,
    fetchPythStorage,
    fetchSweepState,
    findSwapAuthorityPda,
    findSweptEvent,
    getOnboardingInstructions,
    getSweepInstructions,
    getSweepPull,
    pullTotal,
    verifyPythUpdate,
} from '@laterite/client';
import { fetchLatestKaminoUpdate, fetchPythProUpdate, PYTH_USDT_FEED_ID } from '@laterite/client/node';
import { createRpc, loadSigner, mintToInstructions, routeInstruction } from '@laterite/devnet';
import { addresses as devnet } from '@laterite/devnet/addresses';
import {
    type Address,
    address,
    compileTransactionMessage,
    estimateAndSetResourceLimitsFactory,
    estimateResourceLimitsFactory,
    fetchEncodedAccounts,
    generateKeyPairSigner,
    getAddressDecoder,
    getBase58Encoder,
    getBase64Encoder,
    getCompiledTransactionMessageDecoder,
    getSignatureFromTransaction,
    getTransactionDecoder,
    getTransactionSize,
    type KeyPairSigner,
    type MicroLamports,
    type ReadonlyUint8Array,
    sendAndConfirmTransactionFactory,
    setTransactionMessageLifetimeUsingBlockhash,
    signTransactionMessageWithSigners,
} from '@solana/kit';
import { fetchAddressLookupTable } from '@solana-program/address-lookup-table';
import { findAssociatedTokenPda } from '@solana-program/token';
import { beforeAll, describe, expect, it } from 'vitest';

import { client, deployment } from './context';

const { rpc, rpcSubscriptions } = client;
const DOLLAR = 1_000_000n;
const mainnetRpc = createRpc(process.env.SURFPOOL_DATASOURCE_RPC_URL || 'https://api.mainnet-beta.solana.com');
const accessToken = process.env.PYTH_PRO_ACCESS_TOKEN;
const LOADER = address('BPFLoaderUpgradeab1e11111111111111111111111');

/**
 * The account data a message loads as SIMD-0186 counts it: each account's data and 64 bytes, and the program data of
 * each upgradeable program.
 */
async function loadedAccountsDataSize(message: Parameters<typeof compileTransactionMessage>[0]) {
    const size = (account: { data: ReadonlyUint8Array }) => account.data.length + 64;
    const accounts = await fetchEncodedAccounts(rpc, compileTransactionMessage(message).staticAccounts);
    const programData = accounts.flatMap(account =>
        account.exists && account.executable && account.programAddress === LOADER
            ? [getAddressDecoder().decode(account.data, 4)]
            : [],
    );
    const loaded = [...accounts, ...(await fetchEncodedAccounts(rpc, programData))];
    return loaded.reduce((total, account) => total + (account.exists ? size(account) : 0), 0);
}

const estimate = estimateResourceLimitsFactory({ rpc });
// Limits from simulation with a sender's margin, as the services send. Surfpool 1.6 simulations leave out the data
// of programs it already holds, so a version 1 limit is never below what the message's accounts load.
const estimateAndSetLimits = estimateAndSetResourceLimitsFactory((async (message, config) => {
    const limits = await estimate(message, config);
    const margin = (limit: number) => Math.ceil(limit * 1.1);
    return {
        computeUnitLimit: margin(limits.computeUnitLimit),
        ...(limits.loadedAccountsDataSizeLimit !== undefined && {
            loadedAccountsDataSizeLimit: margin(
                Math.max(limits.loadedAccountsDataSizeLimit, await loadedAccountsDataSize(message)),
            ),
        }),
    };
}) as typeof estimate);
const sendAndConfirm = sendAndConfirmTransactionFactory({ rpc, rpcSubscriptions });

/** SPYx and $1 a day on the $10 tier from `paymentTokens`, as a new user picks in the app. */
const params = (paymentTokens: number): EnrollParamsArgs => ({
    asset: 0,
    changeMultiplier: 0,
    cushions: [20n * DOLLAR, 20n * DOLLAR],
    engine: Engine.Daily,
    engineAmount: DOLLAR,
    goalAmount: 1_000n * DOLLAR,
    goalLabel: new Uint8Array(32),
    incomeRule: false,
    paymentTokens,
    tier: 0,
});

/** Estimates the limits, signs and sends `message`, then returns the confirmed transaction with its size. */
async function send(message: Parameters<typeof estimateAndSetLimits>[0]) {
    const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();
    const transaction = await signTransactionMessageWithSigners(
        await estimateAndSetLimits(setTransactionMessageLifetimeUsingBlockhash(blockhash, message as never)),
    );
    await sendAndConfirm(transaction as never, { commitment: 'confirmed' });
    const signature = getSignatureFromTransaction(transaction);
    const confirmed = await rpc
        .getTransaction(signature, { commitment: 'confirmed', encoding: 'base64', maxSupportedTransactionVersion: 1 })
        .send();
    if (!confirmed?.meta) throw new Error(`${signature} was not found`);
    return { confirmed, signature, size: getTransactionSize(transaction) };
}

// The daily engine buys once a day across both tokens, so each token's sweep gets a wallet of its own.
describe('devnet smoke', () => {
    let authority: KeyPairSigner;
    let faucet: KeyPairSigner;
    let sponsor: KeyPairSigner;

    beforeAll(async () => {
        if (!accessToken) throw new Error('PYTH_PRO_ACCESS_TOKEN is required for the USDT update');
        [authority, faucet, sponsor] = await Promise.all([
            loadSigner('devnet-authority'),
            loadSigner('devnet-faucet'),
            loadSigner('devnet-sponsor'),
        ]);
    });

    for (const [paymentToken, symbol] of [
        [0, 'USDC'],
        [1, 'USDT'],
    ] as const) {
        it(`funds a fresh wallet with ${symbol} through the faucet, enrolls it sponsored and sweeps it`, async () => {
            const user = await generateKeyPairSigner();
            const token = devnet.tokens[symbol];
            await client.send(
                authority,
                await mintToInstructions({
                    amount: 100n * DOLLAR,
                    authority: faucet,
                    decimals: token.decimals,
                    mint: token.mint,
                    owner: user.address,
                    payer: authority,
                    tokenProgram: token.tokenProgram,
                }),
            );

            const { data: config } = await fetchConfig(rpc, deployment.config);
            const { data: table } = await fetchAddressLookupTable(rpc, deployment.lookupTable);
            const onboarding = await getOnboardingInstructions({
                config,
                params: params(1 << paymentToken),
                rpc,
                sponsor,
                user,
            });
            const enrolled = await send(
                createSponsoredTransactionMessage({
                    computeUnitPrice: 1_000n as MicroLamports,
                    instructions: onboarding.instructions,
                    lookupTable: { [deployment.lookupTable]: table.addresses },
                    sponsor,
                }),
            );
            console.log(
                `${symbol} onboarding ${enrolled.signature}: ${enrolled.size} B, ` +
                    `${enrolled.confirmed.meta!.computeUnitsConsumed} CU`,
            );

            const state = await fetchSweepState(rpc, { config, paymentToken, user: user.address });
            const pull = getSweepPull(state);
            const asset = config.assets[0]!;
            const storage = await fetchPythStorage(rpc);
            const { message: assetUpdate } = await fetchLatestKaminoUpdate(mainnetRpc, asset.pythFeedId);
            await verifyPythUpdate(assetUpdate, storage, state.now);
            let paymentUpdate: ReadonlyUint8Array | undefined;
            // USDC is worth one dollar by the table (feed 0); USDT is priced by its own update.
            if (config.paymentTokens[paymentToken]!.usdFeedId !== 0) {
                paymentUpdate = await fetchPythProUpdate({
                    accessToken: accessToken!,
                    priceFeedIds: [PYTH_USDT_FEED_ID],
                });
                await verifyPythUpdate(paymentUpdate, storage, state.now);
            }
            const [[swapAuthority], [destination]] = await Promise.all([
                findSwapAuthorityPda(),
                findAssociatedTokenPda({ mint: asset.mint, owner: user.address, tokenProgram: asset.tokenProgram }),
            ]);
            const route = await routeInstruction({
                amountIn: pullTotal(pull),
                ammConfig: devnet.cpmm.ammConfig,
                authority: swapAuthority,
                destination,
                pool: devnet.pools[`SPYx-${symbol}`],
                tokens: devnet.tokens,
            });
            const sweep = await getSweepInstructions({
                assetUpdate,
                crank: authority,
                paymentUpdate,
                pythTreasury: storage.treasury,
                route,
                state,
            });
            const { confirmed, signature, size } = await send(
                createSweepTransactionMessage({ crank: authority, instructions: sweep.instructions }),
            );
            const wire = getTransactionDecoder().decode(getBase64Encoder().encode(confirmed.transaction[0]));
            const keys = getCompiledTransactionMessageDecoder().decode(wire.messageBytes).staticAccounts;
            const executed = confirmed.meta!.innerInstructions!.flatMap(({ instructions }) =>
                instructions.map(({ data, programIdIndex }) => ({
                    data: getBase58Encoder().encode(data),
                    programAddress: keys[programIdIndex] as Address,
                })),
            );
            const swept = findSweptEvent(executed);
            // The program derives the same minimum as the client's mirror, which carries this build's SLIPPAGE_BPS.
            expect(swept?.minOut).toBe(sweep.minOut);
            expect(swept?.received).toBeGreaterThanOrEqual(sweep.minOut);
            const headroom = (Number(swept!.received - sweep.minOut) * 10_000) / Number(sweep.minOut);
            const treasury = keys.indexOf(storage.treasury);
            const fee = confirmed.meta!.postBalances[treasury]! - confirmed.meta!.preBalances[treasury]!;
            expect(fee).toBe(paymentUpdate ? 2n : 1n);
            console.log(
                `${symbol} sweep ${signature}: ${size} B (built ${sweep.size}), ` +
                    `${confirmed.meta!.computeUnitsConsumed} CU, fee ${confirmed.meta!.fee} lamports, ` +
                    `pulled ${pullTotal(pull)}, received ${swept!.received} (min ${sweep.minOut}, ` +
                    `headroom ${headroom.toFixed(1)} bps), treasury +${fee}`,
            );
        });
    }
});

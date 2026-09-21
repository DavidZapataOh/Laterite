import { TOKEN_PROGRAM_ADDRESS } from '@solana-program/token';
import { fetchMint, TOKEN_2022_PROGRAM_ADDRESS } from '@solana-program/token-2022';
import {
    fetchPlan,
    findPlanPda,
    findSubscriptionDelegationPda,
    getCreatePlanOverlayInstructionAsync,
    getInitSubscriptionAuthorityOverlayInstructionAsync,
    getSubscribeOverlayInstructionAsync,
    getTransferSubscriptionOverlayInstructionAsync,
    UNKNOWN_INIT_ID,
} from '@solana/subscriptions';
import { describe, expect, it } from 'vitest';

import { createAta, fundedSigner, fundToken, rpc, send, SPYX, syncClock, tokenBalance, USDC } from './src/fork';
import { buildSwap } from './src/jupiter';

const WEEKLY_CAP = 25_000_000n;

describe('mainnet fork', () => {
    it('keeps the SPYx extension set the product depends on', async () => {
        const mint = await fetchMint(rpc, SPYX);
        expect(mint.programAddress).toBe(TOKEN_2022_PROGRAM_ADDRESS);
        const kinds = mint.data.extensions.__option === 'Some' ? mint.data.extensions.value.map(e => e.__kind) : [];
        expect(kinds).toEqual(
            expect.arrayContaining([
                'DefaultAccountState',
                'PausableConfig',
                'PermanentDelegate',
                'ScaledUiAmountConfig',
                'TransferHook',
            ]),
        );
        console.table(kinds);
    });

    it('pulls a subscription and swaps it into SPYx', async () => {
        const merchant = await fundedSigner();
        const subscriber = await fundedSigner();
        const planId = 1n;

        const subscriberUsdc = await createAta(subscriber, subscriber.address, USDC, TOKEN_PROGRAM_ADDRESS);
        await fundToken(subscriber.address, USDC, 100_000_000n);
        const merchantUsdc = await createAta(merchant, merchant.address, USDC, TOKEN_PROGRAM_ADDRESS);
        const merchantSpyx = await createAta(merchant, merchant.address, SPYX, TOKEN_2022_PROGRAM_ADDRESS);

        await send(merchant, [
            await getCreatePlanOverlayInstructionAsync({
                amount: WEEKLY_CAP,
                destinations: [merchant.address],
                endTs: 0n,
                metadataUri: '',
                mint: USDC,
                owner: merchant,
                periodHours: 168n,
                planId,
                pullers: [],
            }),
        ]);
        const [planPda] = await findPlanPda({ owner: merchant.address, planId });
        const plan = await fetchPlan(rpc, planPda);

        await send(subscriber, [
            await getInitSubscriptionAuthorityOverlayInstructionAsync({
                owner: subscriber,
                tokenMint: USDC,
                tokenProgram: TOKEN_PROGRAM_ADDRESS,
                userAta: subscriberUsdc,
            }),
            await getSubscribeOverlayInstructionAsync({
                expectedAmount: WEEKLY_CAP,
                expectedCreatedAt: plan.data.data.terms.createdAt,
                expectedPeriodHours: 168n,
                expectedSubscriptionAuthorityInitId: UNKNOWN_INIT_ID,
                merchant: merchant.address,
                planId,
                subscriber,
                tokenMint: USDC,
            }),
        ]);

        const [subscriptionPda] = await findSubscriptionDelegationPda({ planPda, subscriber: subscriber.address });
        await send(merchant, [
            await getTransferSubscriptionOverlayInstructionAsync({
                amount: WEEKLY_CAP,
                caller: merchant,
                delegator: subscriber.address,
                planPda,
                receiverAta: merchantUsdc,
                subscriptionPda,
                tokenMint: USDC,
                tokenProgram: TOKEN_PROGRAM_ADDRESS,
            }),
        ]);
        expect(await tokenBalance(merchantUsdc)).toBe(WEEKLY_CAP);
        expect(await tokenBalance(subscriberUsdc)).toBe(100_000_000n - WEEKLY_CAP);

        await syncClock();
        const route = await buildSwap({
            amount: WEEKLY_CAP,
            dexes: ['Raydium CLMM', 'Whirlpool'],
            inputMint: USDC,
            maxAccounts: 30,
            outputMint: SPYX,
            payer: merchant.address,
            taker: merchant.address,
        });
        await send(merchant, route.instructions, { lookupTables: route.lookupTables });
        expect(await tokenBalance(merchantSpyx)).toBeGreaterThanOrEqual(route.otherAmountThreshold);
    });
});

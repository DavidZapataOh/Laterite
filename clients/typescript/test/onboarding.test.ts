import {
    getCompiledTransactionMessageDecoder,
    type MicroLamports,
    pipe,
    setTransactionMessageComputeUnitLimit,
    setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit';
import {
    getInitSubscriptionAuthorityOverlayInstructionAsync,
    SUBSCRIPTIONS_PROGRAM_ADDRESS,
    UNKNOWN_INIT_ID,
} from '@solana/subscriptions';
import {
    findAssociatedTokenPda,
    getCreateAssociatedTokenIdempotentInstructionAsync,
    getRevokeInstruction,
} from '@solana-program/token';
import { describe, expect, it } from 'vitest';

import {
    createSponsoredTransactionMessage,
    fetchUserState,
    getOnboardingInstructions,
    getOnboardingLookupTableAddresses,
    getSetPausedInstruction,
    LATERITE_ERROR__NOT_SPONSOR,
    LATERITE_ERROR__PROGRAM_PAUSED,
    LateriteCheckError,
} from '../src';
import { defaultParams, enrolled, fundUser, programUnits, withPlans } from './env';
import { seeded, sponsorSigner } from './fixtures';

const V0_SIZE_LIMIT = 1_232;

describe('onboarding builder', () => {
    it("lands both tokens at ADR-003's size and the CU baseline, and stays within version 0's limit", async () => {
        const env = await withPlans();
        const user = await seeded(9);
        const outcome = await enrolled(env, user, { ...defaultParams(), changeMultiplier: 1, incomeRule: true });
        expect([outcome.size, outcome.result.computeUnitsConsumed(), programUnits(outcome.result)]).toEqual([
            921,
            67_078n,
            15_651n,
        ]);
        expect(env.balance(user.address)).toBe(0n);
        const message = getCompiledTransactionMessageDecoder().decode(outcome.transaction.messageBytes);
        const lookups = 'addressTableLookups' in message ? (message.addressTableLookups ?? []) : [];
        const loaded = lookups.reduce((n, l) => n + l.readonlyIndexes.length + l.writableIndexes.length, 0);
        expect(loaded).toBe(11);
        expect((await getOnboardingLookupTableAddresses(env.config!)).length).toBe(17);
    });

    it("builds ADR-003's sponsored message: a compute-unit limit and price, 973 bytes with both tokens", async () => {
        for (const [paymentTokens, size] of [
            [0b11, 973],
            [0b01, 777],
        ] as const) {
            const env = await withPlans();
            const user = await seeded(9);
            await fundUser(env, user.address);
            const sponsor = await sponsorSigner();
            const { createsAssetAccount, instructions } = await getOnboardingInstructions({
                config: env.config!,
                params: { ...defaultParams(), paymentTokens },
                rpc: env.rpc,
                sponsor,
                user,
            });
            const message = pipe(
                createSponsoredTransactionMessage({
                    computeUnitPrice: 1_000n as MicroLamports,
                    instructions,
                    lookupTable: env.lookupTable!,
                    sponsor,
                }),
                m =>
                    setTransactionMessageLifetimeUsingBlockhash(
                        { blockhash: env.svm.latestBlockhash(), lastValidBlockHeight: 0n },
                        m,
                    ),
                m => setTransactionMessageComputeUnitLimit(100_000, m),
            );
            const outcome = await env.expectSuccess(env.sendMessage(message));
            console.log(
                `onboarding ${paymentTokens}:`,
                outcome.size,
                'bytes',
                outcome.result.computeUnitsConsumed(),
                'CU',
            );
            expect(createsAssetAccount).toBe(true);
            expect(outcome.size).toBe(size);
            expect(outcome.size).toBeLessThanOrEqual(V0_SIZE_LIMIT);
        }
    });

    it('passes the stored init id of an authority the user already holds', async () => {
        const env = await withPlans();
        const user = await seeded(9);
        await fundUser(env, user.address);
        const sponsor = await sponsorSigner();
        const { mint, tokenProgram } = env.config!.paymentTokens[1]!;
        const [userAta] = await findAssociatedTokenPda({ mint, owner: user.address, tokenProgram });
        // An authority for USDT from another merchant, created in an earlier slot.
        const init = await getInitSubscriptionAuthorityOverlayInstructionAsync({
            owner: user,
            payer: sponsor,
            tokenMint: mint,
            tokenProgram,
            userAta,
        });
        await env.expectSuccess(env.send(sponsor, [init]));
        env.svm.warpToSlot(env.svm.getClock().slot + 10n);
        const state = await fetchUserState(env.rpc, env.config!, user.address);
        expect(state.tokens[1]!.authorityState!.initId).not.toBe(UNKNOWN_INIT_ID);

        const { instructions } = await getOnboardingInstructions({
            config: env.config!,
            params: defaultParams(),
            rpc: env.rpc,
            sponsor,
            user,
        });
        const initializations = instructions.filter(
            ({ data, programAddress }) => programAddress === SUBSCRIPTIONS_PROGRAM_ADDRESS && data?.[0] === 0,
        );
        expect(initializations).toHaveLength(1);
        await env.expectSuccess(env.send(sponsor, instructions));
    });

    it("renews an existing authority's approval the user revoked, and skips an asset account that exists", async () => {
        const env = await withPlans();
        const user = await seeded(9);
        await fundUser(env, user.address);
        const sponsor = await sponsorSigner();
        const { mint, tokenProgram } = env.config!.paymentTokens[1]!;
        const [userAta] = await findAssociatedTokenPda({ mint, owner: user.address, tokenProgram });
        const init = await getInitSubscriptionAuthorityOverlayInstructionAsync({
            owner: user,
            payer: sponsor,
            tokenMint: mint,
            tokenProgram,
            userAta,
        });
        const asset = env.config!.assets[0]!;
        const createAsset = await getCreateAssociatedTokenIdempotentInstructionAsync({
            mint: asset.mint,
            owner: user.address,
            payer: sponsor,
            tokenProgram: asset.tokenProgram,
        });
        await env.expectSuccess(env.send(sponsor, [init, createAsset]));
        env.svm.warpToSlot(env.svm.getClock().slot + 10n);
        // The user revokes the authority's approval of their USDT account with the token program.
        await env.expectSuccess(env.send(sponsor, [getRevokeInstruction({ owner: user, source: userAta })]));
        expect((await fetchUserState(env.rpc, env.config!, user.address)).tokens[1]!.accountState!.delegate).toBeNull();

        const { createsAssetAccount, instructions } = await getOnboardingInstructions({
            config: env.config!,
            params: defaultParams(),
            rpc: env.rpc,
            sponsor,
            user,
        });
        expect(createsAssetAccount).toBe(false);
        const initializations = instructions.filter(
            ({ data, programAddress }) => programAddress === SUBSCRIPTIONS_PROGRAM_ADDRESS && data?.[0] === 0,
        );
        expect(initializations).toHaveLength(2);
        await env.expectSuccess(env.send(sponsor, instructions));
        const state = await fetchUserState(env.rpc, env.config!, user.address);
        expect(state.tokens.map(token => token.accountState!.delegate)).toEqual(
            state.tokens.map(token => token.authority),
        );
    });

    it('offers only tokens the user holds an account in, and checks what enroll checks', async () => {
        const env = await withPlans();
        const user = await seeded(9);
        const sponsor = await sponsorSigner();
        const input = { config: env.config!, params: defaultParams(), rpc: env.rpc, sponsor, user };
        await expect(getOnboardingInstructions(input)).rejects.toThrow('has no account');
        await fundUser(env, user.address);
        const code = (promise: Promise<unknown>) => promise.catch((error: LateriteCheckError) => error.code);
        expect(await code(getOnboardingInstructions({ ...input, sponsor: await seeded(1) }))).toBe(
            LATERITE_ERROR__NOT_SPONSOR,
        );
        await env.expectSuccess(
            env.send(env.authority, [getSetPausedInstruction({ admin: env.authority, paused: true })]),
        );
        expect(await code(getOnboardingInstructions({ ...input, config: await env.fetchConfig() }))).toBe(
            LATERITE_ERROR__PROGRAM_PAUSED,
        );
    });

    it('sends a returning user to reactivation', async () => {
        const env = await withPlans();
        const user = await seeded(9);
        await enrolled(env, user, defaultParams());
        const sponsor = await sponsorSigner();
        await expect(
            getOnboardingInstructions({ config: env.config!, params: defaultParams(), rpc: env.rpc, sponsor, user }),
        ).rejects.toThrow('reactivation');
    });
});

import { routeInstruction } from '@laterite/devnet';
import { addresses as devnet } from '@laterite/devnet/addresses';
import {
    type Instruction,
    type MicroLamports,
    pipe,
    setTransactionMessageComputeUnitLimit,
    setTransactionMessageLifetimeUsingBlockhash,
    type TransactionSigner,
} from '@solana/kit';
import {
    getCancelSubscriptionOverlayInstructionAsync,
    getCreateFixedDelegationOverlayInstructionAsync,
    getCreatePlanOverlayInstructionAsync,
    getCreateRecurringDelegationOverlayInstructionAsync,
    getRevokeSubscriptionAuthorityOverlayInstructionAsync,
    getRevokeSubscriptionOverlayInstruction,
    getSubscribeOverlayInstructionAsync,
    UNKNOWN_INIT_ID,
} from '@solana/subscriptions';
import { findAssociatedTokenPda, getApproveInstruction, getRevokeInstruction } from '@solana-program/token';
import { describe, expect, it } from 'vitest';

import {
    createSponsoredTransactionMessage,
    fetchSweepState,
    fetchUserState,
    findSubscriptionAuthorityAddress,
    findSwapAuthorityPda,
    getChangePaymentTokensInstructions,
    getChangeTierInstructions,
    getExitInstructions,
    getLowerPendingInstructions,
    getReactivationInstructions,
    getRestoreInstructions,
    getSetUserPausedInstructions,
    getSweepInstructions,
    getSweepPull,
    getUpdateConfigInstruction,
    getUpdateSettingsInstructions,
    LATERITE_ERROR__PENDING_INCREASE,
    LATERITE_ERROR__PLAN_CHANGE_REQUIRED,
    LATERITE_ERROR__UNKNOWN_PAYMENT_TOKEN,
    LATERITE_ERROR__USER_NOT_ACTIVE,
    LATERITE_ERROR__USER_NOT_PAUSED,
    LateriteCheckError,
    pullTotal,
    RestoreRequiredError,
    UserStatus,
} from '../src';
import { defaultParams, type Env, programUnits } from './env';
import { DOLLAR, PYTH, PYTH_SPYX_QQQX, PYTH_SPYX_QUOTE, seeded, sponsorSigner } from './fixtures';
import { pythTestSigner, pythUpdate, sweepEnv, trust } from './sweep-env';

type Swept = Awaited<ReturnType<typeof sweepEnv>>;

const code = (promise: Promise<unknown>) =>
    promise.then(
        () => undefined,
        (error: unknown) => (error instanceof LateriteCheckError ? error.code : Promise.reject(error)),
    );

/** The reason a build was refused for a restore. */
const restoreReason = (promise: Promise<unknown>) =>
    promise.then(
        () => undefined,
        (error: unknown) => (error instanceof RestoreRequiredError ? error.reason : Promise.reject(error)),
    );

/** A builder's instructions, whether it returns them alone or with what they create. */
const list = (built: Instruction[] | { instructions: Instruction[] }) =>
    Array.isArray(built) ? built : built.instructions;

const input = async ({ env, user }: Swept) => ({
    config: env.config!,
    rpc: env.rpc,
    sponsor: await sponsorSigner(),
    user,
});

/** Sends `instructions` sponsored, and returns the refreshed config. */
async function sponsored(env: Env, instructions: Instruction[]) {
    const outcome = await env.expectSuccess(env.send(await sponsorSigner(), instructions));
    await env.fetchConfig();
    return outcome;
}

/** Sweeps the user's USDC through the CPMM, as the crank would. */
async function sweepUsdc({ crank, env, user }: Swept, assetUpdate: Uint8Array = PYTH_SPYX_QQQX) {
    const state = await fetchSweepState(env.rpc, { config: env.config!, paymentToken: 0, user: user.address });
    const [swapAuthority] = await findSwapAuthorityPda();
    const [destination] = await findAssociatedTokenPda({
        mint: devnet.tokens.SPYx.mint,
        owner: user.address,
        tokenProgram: devnet.tokens.SPYx.tokenProgram,
    });
    const route = await routeInstruction({
        amountIn: pullTotal(getSweepPull(state)),
        ammConfig: devnet.cpmm.ammConfig,
        authority: swapAuthority,
        destination,
        pool: devnet.pools['SPYx-USDC'],
        tokens: devnet.tokens,
    });
    const { instructions } = await getSweepInstructions({
        assetUpdate,
        crank,
        pythTreasury: PYTH.devnet.treasury,
        route,
        state,
    });
    return env.send(crank, instructions, { version: 1 });
}

describe('user-control builders', () => {
    it('land at the CU Benchmark baseline for a user holding no SOL', async () => {
        const cases = [
            [
                'tier change',
                0b11,
                false,
                774,
                38_233n,
                23_981n,
                (i: any) => getChangeTierInstructions({ ...i, tier: 1 }),
            ],
            [
                'drop USDT',
                0b11,
                false,
                500,
                20_709n,
                12_170n,
                (i: any) => getChangePaymentTokensInstructions({ ...i, paymentTokens: 0b01 }),
            ],
            [
                'add USDT',
                0b01,
                false,
                579,
                26_892n,
                7_853n,
                (i: any) => getChangePaymentTokensInstructions({ ...i, paymentTokens: 0b11 }),
            ],
            ['exit', 0b11, false, 619, 37_269n, 21_691n, (i: any) => getExitInstructions(i)],
            [
                'reactivation',
                0b11,
                true,
                844,
                49_355n,
                12_777n,
                (i: any) => getReactivationInstructions({ ...i, params: defaultParams() }),
            ],
        ] as const;
        for (const [name, paymentTokens, exited, size, units, own, build] of cases) {
            const swept = await sweepEnv({ ...defaultParams(), paymentTokens });
            if (exited) await sponsored(swept.env, await getExitInstructions(await input(swept)));
            const instructions = list(await build(await input(swept)));
            const outcome = await sponsored(swept.env, instructions);
            expect([name, outcome.size, outcome.result.computeUnitsConsumed(), programUnits(outcome.result)]).toEqual([
                name,
                size,
                units,
                own,
            ]);
            expect(swept.env.balance(swept.user.address)).toBe(0n);

            // The same instructions as ADR-003's sponsored message: a compute-unit limit and price, 52 bytes more.
            const again = await sweepEnv({ ...defaultParams(), paymentTokens });
            if (exited) await sponsored(again.env, await getExitInstructions(await input(again)));
            const message = pipe(
                createSponsoredTransactionMessage({
                    computeUnitPrice: 1_000n as MicroLamports,
                    instructions: list(await build(await input(again))),
                    lookupTable: again.env.lookupTable!,
                    sponsor: await sponsorSigner(),
                }),
                m =>
                    setTransactionMessageLifetimeUsingBlockhash(
                        { blockhash: again.env.svm.latestBlockhash(), lastValidBlockHeight: 0n },
                        m,
                    ),
                m => setTransactionMessageComputeUnitLimit(100_000, m),
            );
            expect((await again.env.expectSuccess(again.env.sendMessage(message))).size).toBe(size + 52);
        }
    });

    it('update the settings, creating a new asset account first', async () => {
        const swept = await sweepEnv();
        const { env, user } = swept;
        const sponsor = await sponsorSigner();
        const qqqx = { ...defaultParams(), asset: 1, changeMultiplier: 2 };
        const settings = (params: typeof qqqx) =>
            getUpdateSettingsInstructions({ config: env.config!, params, rpc: env.rpc, sponsor, user });
        const first = await settings(qqqx);
        expect([first.createsAssetAccount, first.instructions.length]).toEqual([true, 2]);
        await sponsored(env, first.instructions);
        expect((await env.userConfig(user.address)).asset).toBe(1);
        const again = await settings({ ...defaultParams(), changeMultiplier: 3 });
        expect([again.createsAssetAccount, again.instructions.length]).toEqual([false, 1]);
        expect(await code(settings({ ...qqqx, tier: 1 }))).toBe(LATERITE_ERROR__PLAN_CHANGE_REQUIRED);
    });

    it('pause, resume and lower pending under the program state guards', async () => {
        const { env, user } = await sweepEnv();
        const userConfig = () => env.userConfig(user.address);
        expect(await code(getSetUserPausedInstructions({ paused: false, user, userConfig: await userConfig() }))).toBe(
            LATERITE_ERROR__USER_NOT_PAUSED,
        );
        await sponsored(
            env,
            await getSetUserPausedInstructions({ paused: true, user, userConfig: await userConfig() }),
        );
        expect((await userConfig()).status).toBe(UserStatus.Paused);
        expect(await code(getSetUserPausedInstructions({ paused: true, user, userConfig: await userConfig() }))).toBe(
            LATERITE_ERROR__USER_NOT_ACTIVE,
        );
        await sponsored(
            env,
            await getSetUserPausedInstructions({ paused: false, user, userConfig: await userConfig() }),
        );
        expect(await code(getLowerPendingInstructions({ pending: 1n, user, userConfig: await userConfig() }))).toBe(
            LATERITE_ERROR__PENDING_INCREASE,
        );
        await sponsored(env, await getLowerPendingInstructions({ pending: 0n, user, userConfig: await userConfig() }));
    });

    it('refund every rent to the payer it recorded after the sponsor rotates, and keep the account after exit', async () => {
        const swept = await sweepEnv();
        const { env, user } = swept;
        const [oldSponsor, newSponsor] = [await sponsorSigner(), await seeded(12)];
        env.airdrop(newSponsor.address);
        const settings = { ...env.config!, attestor: env.config!.attestor, sponsor: newSponsor.address };
        const rotate = getUpdateConfigInstruction({
            admin: env.authority,
            settings: {
                attestor: settings.attestor,
                maxUsers: settings.maxUsers,
                sponsor: newSponsor.address,
                userWeeklyCap: settings.userWeeklyCap,
            },
        });
        await env.expectSuccess(env.send(env.authority, [rotate]));
        await env.fetchConfig();
        const state = await fetchUserState(env.rpc, env.config!, user.address);
        const rents = [...state.plans.filter(plan => plan.tier === 0), ...state.tokens].map(entry =>
            env.balance('subscription' in entry ? entry.subscription : entry.authority),
        );
        const before = env.balance(oldSponsor.address);
        const exit = await getExitInstructions({ config: env.config!, rpc: env.rpc, user });
        await env.expectSuccess(env.send(newSponsor, exit));
        expect(env.balance(oldSponsor.address)).toBe(rents.reduce((sum: bigint, rent) => sum + rent, before));
        const exited = await env.userConfig(user.address);
        expect([exited.status, exited.pending, exited.enrolledAt]).toEqual([
            UserStatus.Exited,
            0n,
            state.userConfig!.enrolledAt,
        ]);
    });

    it('exit after the user cancelled or closed a subscription or revoked an authority through Subscriptions', async () => {
        for (const outside of ['cancel', 'close', 'revoke'] as const) {
            const swept = await sweepEnv();
            const { env, user } = swept;
            const state = await fetchUserState(env.rpc, env.config!, user.address);
            const usdc = state.plans.find(plan => plan.paymentToken === 0 && plan.tier === 0)!;
            const cancel = await getCancelSubscriptionOverlayInstructionAsync({ planPda: usdc.plan, subscriber: user });
            if (outside === 'revoke') {
                const token = state.tokens[0]!;
                const revoke = await getRevokeSubscriptionAuthorityOverlayInstructionAsync({
                    receiver: token.authorityState!.payer,
                    tokenMint: token.mint,
                    tokenProgram: token.tokenProgram,
                    user,
                });
                await sponsored(env, [revoke]);
            } else {
                await sponsored(env, [cancel]);
            }
            if (outside === 'close') {
                // A cancelled subscription closes once its period has run out.
                env.setNow(
                    (await fetchUserState(env.rpc, env.config!, user.address)).plans[0]!.subscriptionState!.expiresAtTs,
                );
                const close = getRevokeSubscriptionOverlayInstruction({
                    authority: user,
                    planPda: usdc.plan,
                    receiver: usdc.subscriptionState!.header.payer,
                    subscriptionPda: usdc.subscription,
                });
                await sponsored(env, [close]);
                expect(env.exists(usdc.subscription)).toBe(false);
            }
            await sponsored(env, await getExitInstructions({ config: env.config!, rpc: env.rpc, user }));
            expect((await env.userConfig(user.address)).status, outside).toBe(UserStatus.Exited);
        }
    });

    it('change back to a tier, and re-add a token, left with an ended subscription', async () => {
        const swept = await sweepEnv();
        const { env, user } = swept;
        // A client that ends subscriptions without closing them: the tier change and the drop without their closes.
        const up = await getChangeTierInstructions({ ...(await input(swept)), tier: 1 });
        await sponsored(env, up.slice(0, -2));
        await sponsored(
            env,
            await getChangeTierInstructions({ ...(await input(swept)), config: env.config!, tier: 0 }),
        );
        expect((await env.userConfig(user.address)).tier).toBe(0);

        const drop = await getChangePaymentTokensInstructions({
            ...(await input(swept)),
            config: env.config!,
            paymentTokens: 0b01,
        });
        await sponsored(env, drop.slice(0, 1));
        const add = await getChangePaymentTokensInstructions({
            ...(await input(swept)),
            config: env.config!,
            paymentTokens: 0b11,
        });
        await sponsored(env, add);
        expect((await env.userConfig(user.address)).paymentTokens).toBe(0b11);
    });

    it('reactivate with the authorities revoked, kept, or after an exit sent outside the app', async () => {
        for (const exit of ['kept', 'outside'] as const) {
            const swept = await sweepEnv();
            const { env, user } = swept;
            const sponsor = await sponsorSigner();
            if (exit === 'kept') {
                // Another merchant's USDC plan keeps the user's USDC approval alive through the exit.
                const merchant = await seeded(13);
                env.airdrop(merchant.address);
                const mint = devnet.tokens.USDC.mint;
                const plan = await getCreatePlanOverlayInstructionAsync({
                    amount: DOLLAR,
                    destinations: [merchant.address],
                    endTs: 0n,
                    metadataUri: '',
                    mint,
                    owner: merchant,
                    periodHours: 24n,
                    planId: 9n,
                    pullers: [],
                });
                await env.expectSuccess(env.send(merchant, [plan]));
                const authority = await fetchUserState(env.rpc, env.config!, user.address);
                const subscribe = await getSubscribeOverlayInstructionAsync({
                    expectedAmount: DOLLAR,
                    expectedCreatedAt: env.now(),
                    expectedPeriodHours: 24n,
                    expectedSubscriptionAuthorityInitId: authority.tokens[0]!.authorityState!.initId,
                    merchant: merchant.address,
                    payer: sponsor,
                    planId: 9n,
                    subscriber: user,
                    tokenMint: mint,
                });
                await sponsored(env, [subscribe]);
                await sponsored(env, await getExitInstructions({ config: env.config!, rpc: env.rpc, user }));
                expect(env.exists(await findSubscriptionAuthorityAddress(user.address, mint))).toBe(true);
                expect(env.exists(await findSubscriptionAuthorityAddress(user.address, devnet.tokens.USDT.mint))).toBe(
                    false,
                );
            } else {
                const [exitOnly] = await getExitInstructions({ config: env.config!, rpc: env.rpc, user });
                await sponsored(env, [exitOnly!]);
            }
            const back = await getReactivationInstructions({
                ...(await input(swept)),
                config: env.config!,
                params: { ...defaultParams(), tier: 1 },
            });
            expect(back.createsAssetAccount).toBe(false);
            await sponsored(env, back.instructions);
            const userConfig = await env.userConfig(user.address);
            expect([exit, userConfig.status, userConfig.tier]).toEqual([exit, UserStatus.Active, 1]);
        }
    });

    it('restore a token whose authority was revoked outside Laterite, so the sweep pulls again', async () => {
        const swept = await sweepEnv();
        const { env, user } = swept;
        const state = await fetchUserState(env.rpc, env.config!, user.address);
        const token = state.tokens[0]!;
        const revoke = await getRevokeSubscriptionAuthorityOverlayInstructionAsync({
            receiver: token.authorityState!.payer,
            tokenMint: token.mint,
            tokenProgram: token.tokenProgram,
            user,
        });
        await sponsored(env, [revoke]);
        // Subscriptions counts a closed authority as gone only after the slot it was created in.
        env.svm.warpToSlot(env.svm.getClock().slot + 1n);
        expect(await restoreReason(sweepUsdc(swept))).toBe('authority');
        const restore = await getRestoreInstructions({ ...(await input(swept)), paymentToken: 0 });
        expect([restore.instructions.length, restore.restorableAt]).toEqual([3, null]);
        await sponsored(env, restore.instructions);
        const restored = await fetchUserState(env.rpc, env.config!, user.address);
        expect(restored.tokens[0]!.authorityState!.initId).not.toBe(UNKNOWN_INIT_ID);
        await env.expectSuccess(sweepUsdc(swept));
        expect((await getRestoreInstructions({ ...(await input(swept)), paymentToken: 0 })).instructions).toHaveLength(
            0,
        );

        // A subscription the user cancelled through Subscriptions still runs until its period ends: it is resumed.
        const plan = restored.plans.find(entry => entry.paymentToken === 0 && entry.tier === 0)!;
        await sponsored(env, [
            await getCancelSubscriptionOverlayInstructionAsync({ planPda: plan.plan, subscriber: user }),
        ]);
        const resume = await getRestoreInstructions({ ...(await input(swept)), paymentToken: 0 });
        expect(resume.instructions).toHaveLength(1);
        await sponsored(env, resume.instructions);
        const resumed = await fetchUserState(env.rpc, env.config!, user.address);
        expect(
            resumed.plans.find(entry => entry.paymentToken === 0 && entry.tier === 0)!.subscriptionState!.expiresAtTs,
        ).toBe(0n);
    });

    it("restore an account's approval removed or replaced with the token program, so the sweep pulls again", async () => {
        for (const outside of ['revoke', 'approve'] as const) {
            const swept = await sweepEnv();
            const { env, user } = swept;
            const account = (await fetchUserState(env.rpc, env.config!, user.address)).tokens[0]!.account;
            const other = await seeded(14);
            const change =
                outside === 'revoke'
                    ? getRevokeInstruction({ owner: user, source: account })
                    : getApproveInstruction({ amount: DOLLAR, delegate: other.address, owner: user, source: account });
            await sponsored(env, [change]);
            expect(await restoreReason(sweepUsdc(swept)), outside).toBe('delegate');
            const restore = await getRestoreInstructions({ ...(await input(swept)), paymentToken: 0 });
            // `init_subscription_authority` alone: it approves the existing authority again.
            expect(restore.instructions.map(instruction => instruction.data?.[0])).toEqual([0]);
            await sponsored(env, restore.instructions);
            await env.expectSuccess(sweepUsdc(swept));
        }
    });

    it('restore after a sponsor rotation through a retired sponsor key, or the keyless path', async () => {
        for (const path of ['retired key', 'keyless'] as const) {
            const swept = await sweepEnv();
            const { env, user } = swept;
            const [retired, current] = [await sponsorSigner(), await seeded(12)];
            env.airdrop(current.address);
            const token = (await fetchUserState(env.rpc, env.config!, user.address)).tokens[0]!;
            const revoke = await getRevokeSubscriptionAuthorityOverlayInstructionAsync({
                receiver: token.authorityState!.payer,
                tokenMint: token.mint,
                tokenProgram: token.tokenProgram,
                user,
            });
            await sponsored(env, [revoke]);
            env.svm.warpToSlot(env.svm.getClock().slot + 1n);
            const { attestor, maxUsers, userWeeklyCap } = env.config!;
            const rotate = getUpdateConfigInstruction({
                admin: env.authority,
                settings: { attestor, maxUsers, sponsor: current.address, userWeeklyCap },
            });
            await env.expectSuccess(env.send(env.authority, [rotate]));
            const config = await env.fetchConfig();
            const restore = (payers: TransactionSigner[]) =>
                getRestoreInstructions({ config, paymentToken: 0, payers, rpc: env.rpc, sponsor: current, user });
            if (path === 'retired key') {
                const { instructions, restorableAt } = await restore([retired]);
                expect(restorableAt).toBeNull();
                const before = env.balance(retired.address);
                // The retired key signs only the close, the rent returning to it; the current sponsor pays the fee.
                await env.expectSuccess(env.send(current, instructions));
                expect(env.balance(retired.address)).toBeGreaterThan(before);
                await env.expectSuccess(sweepUsdc(swept));
                continue;
            }
            const cancel = await restore([]);
            expect(cancel.instructions).toHaveLength(1);
            await env.expectSuccess(env.send(current, cancel.instructions));
            const cancelled = (await fetchUserState(env.rpc, config, user.address)).plans[0]!.subscriptionState!;
            expect(cancelled.expiresAtTs).toBe(cancel.restorableAt);
            expect((await restore([])).instructions).toHaveLength(0);
            // Once it has run out, the user closes it (the rent to the retired payer) and subscribes again.
            env.setNow(cancel.restorableAt!);
            const { instructions, restorableAt } = await restore([]);
            expect([instructions.length, restorableAt]).toEqual([3, null]);
            const before = env.balance(retired.address);
            await env.expectSuccess(env.send(current, instructions));
            expect(env.balance(retired.address)).toBeGreaterThan(before);
            trust(env, (await pythTestSigner()).address);
            const asset = await pythUpdate(env.now(), [
                [1843, PYTH_SPYX_QUOTE],
                [1837, PYTH_SPYX_QUOTE],
            ]);
            await env.expectSuccess(sweepUsdc(swept, asset));
        }
    });

    it('refuse to restore for a user who exited, or a token the user has not enabled', async () => {
        const swept = await sweepEnv({ ...defaultParams(), paymentTokens: 0b01 });
        const { env } = swept;
        expect(await code(getRestoreInstructions({ ...(await input(swept)), paymentToken: 1 }))).toBe(
            LATERITE_ERROR__UNKNOWN_PAYMENT_TOKEN,
        );
        await sponsored(env, await getExitInstructions(await input(swept)));
        expect(await code(getRestoreInstructions({ ...(await input(swept)), paymentToken: 0 }))).toBe(
            LATERITE_ERROR__USER_NOT_ACTIVE,
        );
    });

    it('exit keeps an authority a fixed or recurring delegation to another party still uses', async () => {
        for (const kind of ['fixed', 'recurring'] as const) {
            const swept = await sweepEnv();
            const { env, user } = swept;
            const sponsor = await sponsorSigner();
            const other = await seeded(15);
            const initId = (await fetchUserState(env.rpc, env.config!, user.address)).tokens[0]!.authorityState!.initId;
            const common = {
                delegatee: other.address,
                delegator: user,
                expectedSubscriptionAuthorityInitId: initId,
                nonce: 1n,
                payer: sponsor,
                tokenMint: devnet.tokens.USDC.mint,
            };
            const delegation =
                kind === 'fixed'
                    ? await getCreateFixedDelegationOverlayInstructionAsync({
                          ...common,
                          amount: DOLLAR,
                          expiryTs: env.now() + 86_400n,
                      })
                    : await getCreateRecurringDelegationOverlayInstructionAsync({
                          ...common,
                          amountPerPeriod: DOLLAR,
                          expiryTs: 0n,
                          periodLengthS: 86_400n,
                          startTs: env.now(),
                      });
            await sponsored(env, [delegation]);
            await sponsored(env, await getExitInstructions({ config: env.config!, rpc: env.rpc, user }));
            expect(
                env.exists(await findSubscriptionAuthorityAddress(user.address, devnet.tokens.USDC.mint)),
                kind,
            ).toBe(true);
            expect(
                env.exists(await findSubscriptionAuthorityAddress(user.address, devnet.tokens.USDT.mint)),
                kind,
            ).toBe(false);
        }
    });
});

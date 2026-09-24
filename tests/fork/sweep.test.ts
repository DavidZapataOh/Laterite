import { findSwapAuthorityPda, findVaultPda, pullTotal } from '@laterite/client';
import { getJupiterSweepRoute, JUPITER_API_URL, JUPITER_PROGRAM_ADDRESS, toJupiterSwap } from '@laterite/client/node';
import { MAINNET_MINTS } from '@laterite/devnet';
import { findAssociatedTokenPda } from '@solana-program/token';
import { afterAll, describe, expect, it } from 'vitest';

import { forkContext } from './src/deployment';
import { cheatcodes, DOLLAR, failure, invocations, rpc, sendMessage, simulateMessage } from './src/fork';
import { CLASSIC_DEXES, jupiter } from './src/jupiter';
import { report } from './src/report';
import { measureSweep, prepareSweep, swapAuthorityTokenAccounts, sweptEvent } from './src/sweep';
import { enroll, enrollParams, fetchForkConfig } from './src/users';

const MAX_LOG_BYTES = 10_000;
/** Pyth Pro's mainnet treasury, which the fork's cloned storage names. */
const PYTH_TREASURY = 'Gx4MBPb1vqZLJajZmsKLg8fGw9ErhoKsR8LeKcCKFyak';
const rows: Record<string, unknown>[] = [];
const trace: Record<string, unknown>[] = [];

afterAll(() => {
    report('sweeps', rows);
    report('trace', trace);
});

const tokenBalance = async (account: Parameters<typeof rpc.getTokenAccountBalance>[0]) =>
    BigInt((await rpc.getTokenAccountBalance(account, { commitment: 'confirmed' }).send()).value.amount);

describe('sweeps on real Jupiter routes', () => {
    // The QQQx sweep first loses the swap authority's QQQx account, as a route through a mint the deployment did not
    // cover finds it: the builder names it, the crank creates it, and the sweep lands.
    for (const [name, paymentToken, asset, removeSwapAssetAccount] of [
        ['USDC into SPYx', 0, 0, false],
        ['USDT into SPYx', 1, 0, false],
        ['USDC into QQQx', 0, 1, true],
    ] as const) {
        it(`sweeps ${name}, leaving every swap-authority token account as it was`, async () => {
            const fork = await forkContext();
            const { landed: onboarding, user } = await enroll(
                fork,
                enrollParams({ asset, paymentTokens: 1 << paymentToken }),
            );
            const config = await fetchForkConfig();
            const { mint, tokenProgram } = config.assets[asset]!;
            const [swapAuthority] = await findSwapAuthorityPda();
            const [swapAssetAccount] = await findAssociatedTokenPda({ mint, owner: swapAuthority, tokenProgram });
            if (removeSwapAssetAccount) await cheatcodes.resetAccount(swapAssetAccount).send();
            const prepared = await prepareSweep(fork.keys, user.address, paymentToken);
            // A route may also pass through an intermediate mint of its own, whose account is created the same way.
            if (removeSwapAssetAccount) {
                expect(prepared.created).toContainEqual({ address: swapAssetAccount, mint, tokenProgram });
            }
            const before = await swapAuthorityTokenAccounts();
            expect(pullTotal(prepared.pull)).toBe(5n * DOLLAR);
            // The crank skips a route whose quote would not clear the program's minimum.
            expect(prepared.outAmount).toBeGreaterThanOrEqual(prepared.minOut);

            const balance = await tokenBalance(prepared.userAssetAccount).catch(() => 0n);
            // Simulated first, as the crank does, so a failure names the program that failed.
            expect(failure(await simulateMessage(prepared.message))).toBeUndefined();
            const landed = await sendMessage(prepared.message);
            const swept = sweptEvent(landed);
            expect(swept?.received).toBeGreaterThanOrEqual(prepared.minOut);
            expect((await tokenBalance(prepared.userAssetAccount)) - balance).toBe(swept!.received);

            // Every swap-authority token account is byte-identical and none is new; the vault never reaches the route.
            expect(await swapAuthorityTokenAccounts()).toEqual(before);
            const [vault] = await findVaultPda();
            const routed = landed.inner.filter(({ programAddress }) => programAddress === JUPITER_PROGRAM_ADDRESS);
            expect(routed.some(({ accounts }) => accounts.includes(swapAuthority))).toBe(true);
            expect(routed.some(({ accounts }) => accounts.includes(vault))).toBe(false);
            const measured = await measureSweep(prepared, landed.logs);
            expect(measured.swapAuthorityIsOnlySigner).toBe(true);
            expect(measured.logBytes).toBeLessThan(MAX_LOG_BYTES);
            // The declared loaded-accounts limit covers SIMD-0186's count, which mainnet enforces and the fork does not.
            expect(landed.declaredLoadedAccountsDataSize).toBeGreaterThanOrEqual(landed.loadedAccountsDataSize!);

            expect(prepared.treasury).toBe(PYTH_TREASURY);
            const treasury = landed.accounts.indexOf(prepared.treasury);
            const toTreasury = landed.postBalances[treasury]! - landed.preBalances[treasury]!;
            expect(toTreasury).toBe(paymentToken === 1 ? 2n : 1n);

            rows.push({
                sweep: name,
                clockDrift: prepared.clockDrift.drift,
                timeTraveled: prepared.clockDrift.traveled,
                onboardingBytes: onboarding.size,
                bytes: landed.size,
                accounts: landed.accounts.length,
                units: landed.units,
                ...measured,
                pythUnits: measured.pythUnits.join(' + '),
                loaded: landed.loadedAccountsDataSize,
                declaredLoaded: landed.declaredLoadedAccountsDataSize,
                fee: landed.fee,
                createdForRoute: prepared.created.map(({ mint }) => mint).join(' '),
                quoted: prepared.outAmount,
                received: swept!.received,
                minOut: prepared.minOut,
                fillVersusQuoteBps: Number(((swept!.received - prepared.outAmount) * 10_000n) / prepared.outAmount),
            });
            trace.push({
                sweep: name,
                signature: landed.signature,
                bytes: landed.size,
                units: landed.units,
                invocations: invocations(landed.logs),
                swept,
                logs: landed.logs,
            });
        });
    }
});

describe("Jupiter's route_v2 on real routes", () => {
    it('carries the slippage, platform fee and positive-slippage fee at offsets 24, 26 and 28', async () => {
        const [swapAuthority] = await findSwapAuthorityPda();
        const { deployment } = await forkContext();
        const request = async (extra: Record<string, string>) => {
            const query = new URLSearchParams({
                amount: String(5n * DOLLAR),
                dexes: CLASSIC_DEXES.join(','),
                inputMint: MAINNET_MINTS.USDC,
                maxAccounts: '40',
                outputMint: MAINNET_MINTS.SPYx,
                taker: swapAuthority,
                wrapAndUnwrapSol: 'false',
                ...extra,
            });
            const headers: Record<string, string> = jupiter.apiKey ? { 'x-api-key': jupiter.apiKey } : {};
            const response = await jupiter.fetch(`${JUPITER_API_URL}/build?${query}`, { headers });
            return toJupiterSwap(await response.json());
        };
        const fields = (data: Uint8Array) => {
            const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
            return [8, 16]
                .map(offset => view.getBigUint64(offset, true))
                .concat([24, 26, 28].map(offset => BigInt(view.getUint16(offset, true))));
        };
        const plain = await request({ slippageBps: '100' });
        const [inAmount, quoted, slippage, platformFee, positiveSlippageFee] = fields(plain.swap.data as Uint8Array);
        expect([inAmount, quoted, slippage, platformFee, positiveSlippageFee]).toEqual([
            5n * DOLLAR,
            plain.outAmount,
            100n,
            0n,
            0n,
        ]);
        // A platform fee lands at offset 26, which the builder refuses; Jupiter's response does not report it.
        const charged = await request({
            feeAccount: deployment.swapAccounts[0]!,
            platformFeeBps: '25',
            slippageBps: '150',
        });
        expect(fields(charged.swap.data as Uint8Array).slice(2)).toEqual([150n, 25n, 0n]);
        expect(() => getJupiterSweepRoute(charged, { amount: 5n * DOLLAR, swapAuthority })).toThrow('fee');
    });
});

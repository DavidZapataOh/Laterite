import { LATERITE_ERROR__STALE_PRICE, pullTotal, TIERS, TRIAL_CAP } from '@laterite/client';
import { afterAll, describe, expect, it } from 'vitest';

import { forkContext } from './src/deployment';
import { DOLLAR, failure, simulateMessage } from './src/fork';
import { CLASSIC_DEXES } from './src/jupiter';
import { report } from './src/report';
import { jupiterRoute, measureSweep, prepareSweep, type RouteSource } from './src/sweep';
import { backdateEnrollment, enroll, enrollParams } from './src/users';

/** Whether a simulation failed on Laterite's `StalePrice`. */
const staleOnce = (err: unknown) =>
    JSON.stringify(err ?? null, (_, v) => (typeof v === 'bigint' ? Number(v) : v)).includes(
        `"Custom":${LATERITE_ERROR__STALE_PRICE}`,
    );

/** ADR-001's ceilings for a version 1 sweep. */
const MAX_BYTES = 4_096;
const MAX_ACCOUNTS = 64;
const MAX_LOG_BYTES = 10_000;

const rows: Record<string, unknown>[] = [];
afterAll(() => report('limits', rows));

// The trial week's $5, then each tier's whole week, which only a user past the trial can pull.
const AMOUNTS = [
    { amount: TRIAL_CAP, backdated: false, tier: 0 },
    { amount: TIERS[0], backdated: true, tier: 0 },
    { amount: TIERS[1], backdated: true, tier: 1 },
];

describe("ADR-001's worst case on real routes at maxAccounts 40", () => {
    for (const [paymentToken, token] of ['USDC', 'USDT'].entries()) {
        for (const [asset, symbol] of ['SPYx', 'QQQx'].entries()) {
            it(`${token} into ${symbol}: every route the builder accepts fits the version 1 limits`, async () => {
                const fork = await forkContext();
                for (const { amount, backdated, tier } of AMOUNTS) {
                    const params = enrollParams({
                        asset,
                        engineAmount: amount,
                        paymentTokens: 1 << paymentToken,
                        tier,
                    });
                    const { user } = await enroll(fork, params);
                    if (backdated) await backdateEnrollment(user.address);
                    const sources: [string, RouteSource][] = [
                        ['classic', jupiterRoute(fork.keys.authority, CLASSIC_DEXES)],
                        ['any', jupiterRoute(fork.keys.authority)],
                    ];
                    for (const [venues, source] of sources) {
                        const row: Record<string, unknown> = {
                            token,
                            asset: symbol,
                            amount: amount / DOLLAR,
                            // Tier-sized rows come from an enrollment moved back by a fork state override.
                            backdated,
                            venues,
                        };
                        rows.push(row);
                        let prepared;
                        let simulated;
                        try {
                            prepared = await prepareSweep(fork.keys, user.address, paymentToken, source);
                            simulated = await simulateMessage(prepared.message);
                            // The fork's clock moves with what it executes; an update that aged past the program's 60 s
                            // while the route was built is retried with a fresh one, as the crank does.
                            if (staleOnce(simulated.err)) {
                                prepared = await prepareSweep(fork.keys, user.address, paymentToken, source);
                                simulated = await simulateMessage(prepared.message);
                            }
                        } catch (error) {
                            row.refused = String(error).slice(0, 160);
                            continue;
                        }
                        expect(pullTotal(prepared.pull)).toBe(amount);
                        const measured = await measureSweep(prepared, simulated.logs);
                        Object.assign(row, {
                            bytes: simulated.size,
                            accounts: simulated.accounts,
                            units: simulated.err ? undefined : simulated.units,
                            ...measured,
                            pythUnits: measured.pythUnits.join(' + '),
                            loaded: simulated.loaded,
                            createdForRoute: prepared.created.map(({ mint }) => mint).join(' '),
                            error: simulated.err
                                ? JSON.stringify(failure(simulated), (_, v) => (typeof v === 'bigint' ? Number(v) : v))
                                : undefined,
                        });
                        expect(simulated.size).toBeLessThanOrEqual(MAX_BYTES);
                        expect(simulated.accounts).toBeLessThanOrEqual(MAX_ACCOUNTS);
                        expect(measured.logBytes).toBeLessThan(MAX_LOG_BYTES);
                        // Classic pools execute on the fork; a market maker's quote can go stale once cloned.
                        if (venues === 'classic') expect(simulated.err).toBeNull();
                    }
                }
            });
        }
    }
});

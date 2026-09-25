import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';

import {
    type AttestationArgs,
    createSweepTransactionMessage,
    DAY_SECONDS,
    divEuclid,
    EventKind,
    fetchPythStorage,
    fetchSweepState,
    findSwapAuthorityPda,
    getSweepInstructions,
    getSweepPull,
    LATERITE_PROGRAM_ADDRESS,
    pullTotal,
    SWEEP_DISCRIMINATOR,
} from '@laterite/client';
import { type Database, sweepAttempts, sweeps } from '@laterite/db';
import { createTestDatabase } from '@laterite/db/testing';
import { poolPrice, poolReserves, routeInstruction } from '@laterite/devnet';
import { addresses as devnet } from '@laterite/devnet/addresses';
import {
    type Address,
    compileTransaction,
    containsBytes,
    createSolanaRpcSubscriptions,
    generateKeyPairSigner,
    getBase64EncodedWireTransaction,
    getCompiledTransactionMessageDecoder,
    getTransactionDecoder,
    getBase64Encoder,
    type Instruction,
    type KeyPairSigner,
    pipe,
    setTransactionMessageComputeUnitLimit,
    setTransactionMessageLifetimeUsingBlockhash,
    setTransactionMessageLoadedAccountsDataSizeLimit,
} from '@solana/kit';
import { fetchSysvarClock } from '@solana/sysvars';
import { findAssociatedTokenPda } from '@solana-program/token';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Alarms } from '../src/alarms/alarms';
import { headroomAlarm } from '../src/alarms/checks';
import { Crank, MAX_SWEEP_COMPUTE_UNIT_LIMIT } from '../src/crank/crank';
import { Repegger } from '../src/crank/repeg';
import { cpmmRoutes, type RouteRequest, type Routes } from '../src/crank/routes';
import { Indexer } from '../src/indexer/indexer';
import { createLogger } from '../src/log';
import { createFailoverRpc } from '../src/rpc';
import { ComputeLimitExceededError, createSender } from '../src/send';
import { fetchTransaction } from '../src/transaction';
import { Chain, params } from './chain/chain';
import { TestPrices } from './chain/prices';
import { keys, RPC_PORT } from './chain/validator';

const DOLLAR = 1_000_000n;
const USDC = 0;
const USDT = 1;
const NO_WAIT = { alert: 0, nothing: 0, price: 0, slippage: 0, unknown: 0 };

type Line = { message: string } & Record<string, unknown>;

describe('the crank on a local chain', () => {
    let chain: Chain;
    let db: Database;
    let drop: () => Promise<void>;
    let crank: Crank;
    let crankKey: KeyPairSigner;
    let treasury: KeyPairSigner;
    let repegger: Repegger;
    let rpc: ReturnType<typeof createFailoverRpc>;
    const prices = new TestPrices();
    const lines: Line[] = [];
    const notified: string[] = [];
    const sent: Instruction[][] = [];
    /** Runs once, in place of the route, for the user whose asset account a request names. */
    const hooks = new Map<Address, (request: RouteRequest, route: Routes) => ReturnType<Routes>>();

    const log = createLogger(
        'info',
        new Writable({
            write(chunk, _, done) {
                lines.push(JSON.parse(chunk.toString()));
                done();
            },
        }),
    );

    const attempts = async (user: KeyPairSigner) =>
        db.select().from(sweepAttempts).where(eq(sweepAttempts.user, user.address)).orderBy(asc(sweepAttempts.id));
    const outcomes = async (user: KeyPairSigner) =>
        (await attempts(user)).map(({ outcome, reason }) => (reason ? `${outcome} ${reason}` : outcome));
    const assetAccount = async (user: Address) =>
        (
            await findAssociatedTokenPda({
                mint: devnet.tokens.SPYx.mint,
                owner: user,
                tokenProgram: devnet.tokens.SPYx.tokenProgram,
            })
        )[0];
    const hook = async (user: KeyPairSigner, run: (request: RouteRequest, route: Routes) => ReturnType<Routes>) =>
        hooks.set(await assetAccount(user.address), run);

    /** A new wallet with $100 of `paymentTokens`, enrolled with a daily engine of $1. */
    async function enrolled(paymentTokens = 0b01, overrides = {}) {
        const user = await generateKeyPairSigner();
        for (const token of [USDC, USDT]) {
            if (paymentTokens & (1 << token)) await chain.fund(user.address, token, 100n * DOLLAR);
        }
        await chain.onboard(user, params(paymentTokens, overrides));
        return user;
    }

    const today = async () => Number(divEuclid((await fetchSysvarClock(rpc)).unixTimestamp, DAY_SECONDS));
    const pool = async (name: 'SPYx-USDC' | 'SPYx-USDT') => {
        const info = devnet.pools[name];
        return poolPrice(await poolReserves(rpc, info, devnet.tokens), { base: 8, quote: 6 });
    };
    const target = Number(prices.assetQuote.price) * 10 ** prices.assetQuote.exponent;
    const deviationBps = async () => Math.abs((await pool('SPYx-USDC')) / target - 1) * 10_000;

    beforeAll(async () => {
        [chain, { db, drop }] = await Promise.all([Chain.start(RPC_PORT + 200), createTestDatabase()]);
        [crankKey, treasury] = await Promise.all([keys.crank(), keys.treasury()]);
        rpc = createFailoverRpc([chain.validator.rpcUrl]);
        const rpcSubscriptions = createSolanaRpcSubscriptions(chain.validator.wsUrl);
        const sender = createSender({ payer: crankKey, rpc, rpcSubscriptions });
        const alarms = new Alarms(db, async text => void notified.push(text), log, '[laterite devnet]');
        repegger = new Repegger({
            addresses: devnet,
            assetUpdates: () => prices.latest,
            fallbackPrices: () => Promise.reject(new Error('no fallback prices on a local chain')),
            log,
            pools: ['SPYx-USDC', 'SPYx-USDT'],
            rpc,
            treasury: createSender({ payer: treasury, rpc, rpcSubscriptions }),
            usdtUpdate: now => prices.payment(8, now),
        });
        const cpmm = cpmmRoutes(rpc, devnet);
        crank = new Crank({
            alarms,
            crank: crankKey,
            db,
            log,
            prices,
            repegger,
            retryAfterMs: NO_WAIT,
            routes: async request => {
                const run = hooks.get(request.userAssetAccount);
                if (!run) return cpmm(request);
                hooks.delete(request.userAssetAccount);
                return run(request, cpmm);
            },
            rpc,
            sender: {
                sendVersion1: (instructions, options) => {
                    sent.push([...instructions]);
                    return sender.sendVersion1(instructions, options);
                },
            },
        });
    });
    afterAll(async () => {
        await chain?.stop();
        await drop?.();
    });

    it('sweeps each due token once a day, USDC and USDT, and records every sweep', async () => {
        const [ana, ben] = await keys.users();
        await chain.onboard(ana!, params(0b11));
        await chain.onboard(ben!, params(0b10));
        await crank.tick();
        // The daily engine buys once a day across both tokens: ana's USDT has nothing left today.
        expect(await outcomes(ana!)).toEqual(['landed']);
        expect(await outcomes(ben!)).toEqual(['landed']);
        const [anaSweep] = await attempts(ana!);
        const [benSweep] = await attempts(ben!);
        expect(anaSweep).toMatchObject({ day: await today(), paymentToken: USDC, pull: DOLLAR });
        expect(benSweep).toMatchObject({ paymentToken: USDT, pull: DOLLAR });
        for (const row of [anaSweep!, benSweep!]) {
            // The limit is the simulation's units plus 10%; a landed sweep uses a few units fewer at most.
            expect(Math.abs(row.computeUnitLimit! - row.computeUnits! * 1.1)).toBeLessThan(100);
            // No recent fees on a local chain: the floor price, 1,000 micro-lamports a unit, times the limit.
            expect(row.priorityFeeLamports).toBe(BigInt(Math.ceil((1_000 * row.computeUnitLimit!) / 1_000_000)));
            expect(row.quoted).toBeGreaterThanOrEqual(row.minOut!);
            expect(row.priceAgeSeconds).toBe(0);
        }
        // A USDC sweep carries one update and pays Pyth's treasury 1 lamport; a USDT sweep carries two and pays 2.
        const storage = await fetchPythStorage(rpc);
        for (const [row, updates] of [
            [anaSweep!, 1],
            [benSweep!, 2],
        ] as const) {
            const landed = await fetchTransaction(rpc, row.signature as never, 'confirmed');
            const wire = getTransactionDecoder().decode(getBase64Encoder().encode(landed!.transaction[0]));
            const message = getCompiledTransactionMessageDecoder().decode(wire.messageBytes);
            expect(message.version).toBe(1);
            const treasuryIndex = message.staticAccounts.indexOf(storage.treasury);
            expect(landed!.meta!.postBalances![treasuryIndex]! - landed!.meta!.preBalances![treasuryIndex]!).toBe(
                BigInt(updates),
            );
            expect(row.bytes).toBe(wire.messageBytes.length + 64);
        }
        const signatures = sent.length;
        await crank.tick();
        expect(sent).toHaveLength(signatures);
        expect(await outcomes(ana!)).toEqual(['landed']);
    });

    it("sweeps the week's room of an attested income and leaves the rest pending", async () => {
        const [, , cy] = await keys.users();
        await chain.onboard(cy!, params(0b01, { incomeRule: true }));
        const now = (await fetchSysvarClock(rpc)).unixTimestamp;
        const income: AttestationArgs = {
            amount: 500n * DOLLAR,
            eventTime: now,
            kind: EventKind.Income,
            paymentToken: USDC,
            signature: randomBytes(64),
            transferIndex: 0,
            user: cy!.address,
        };
        await chain.attest(income);
        await crank.tick();
        // The $1 engine and $4 of the $50 pending fill the trial week's $5.
        const [row] = await attempts(cy!);
        expect(row).toMatchObject({ outcome: 'landed', pull: 5n * DOLLAR });
        expect((await chain.userConfig(cy!.address)).pending).toBe(46n * DOLLAR);
    });

    it('sweeps no paused or exited user and a resumed one the same day', async () => {
        const [paused, exited] = [await enrolled(), await enrolled()];
        await chain.setPaused(paused, true);
        await chain.exit(exited);
        await crank.tick();
        expect(await outcomes(paused)).toEqual([]);
        expect(await outcomes(exited)).toEqual([]);
        await chain.setPaused(paused, false);
        await crank.tick();
        expect(await outcomes(paused)).toEqual(['landed']);
    });

    it('skips a token whose approval was ended outside Laterite, once a day, until it is restored', async () => {
        const user = await enrolled();
        await chain.revokeDelegate(user, USDC);
        await crank.tick();
        await crank.tick();
        expect(await outcomes(user)).toEqual(['skipped RestoreRequired delegate']);
    });

    it('sends nothing while the kill switch is on, and says why', async () => {
        const user = await enrolled();
        await chain.setProgramPaused(true);
        const before = sent.length;
        await crank.tick();
        expect(sent).toHaveLength(before);
        expect(lines.map(({ message }) => message)).toContain('the kill switch is on: no sweeps until it is off');
        await chain.setProgramPaused(false);
        await crank.tick();
        expect(await outcomes(user)).toEqual(['landed']);
    });

    it('retries a stale or uncertain price with a fresh update later in the day', async () => {
        const user = await enrolled();
        // No post fresh enough came within the wait, then only one 50 s old.
        prices.assetMissing = true;
        await crank.tick();
        prices.assetMissing = false;
        prices.assetAge = 50n;
        await crank.tick();
        prices.assetAge = 0n;
        // 60 bps of confidence, above the program's 50.
        prices.assetQuote = { ...prices.assetQuote, confidence: (prices.assetQuote.price * 60n) / 10_000n };
        await crank.tick();
        prices.reset();
        await crank.tick();
        expect(await outcomes(user)).toEqual([
            'failed StalePrice',
            'failed StalePrice',
            'failed PriceUncertain',
            'landed',
        ]);
        const rows = await attempts(user);
        expect(rows.map(({ priceAgeSeconds }) => priceAgeSeconds)).toEqual([null, 50, 0, 0]);
        expect(rows.map(({ signature }) => signature === null)).toEqual([true, true, true, false]);
    });

    it('alarms, and sends nothing, on an update without the asset feed', async () => {
        const user = await enrolled();
        prices.assetFeed = 1837;
        await crank.tick();
        prices.reset();
        expect(await outcomes(user)).toEqual(['failed PriceUnavailable']);
        expect(notified.at(-1)).toMatch(
            /FIRING sweep-bug: an update the relay kept fails the local checks with PriceUnavailable/,
        );
        await crank.tick();
        expect(await outcomes(user)).toEqual(['failed PriceUnavailable', 'landed']);
        expect(notified.at(-1)).toMatch(/RESOLVED sweep-bug/);
    });

    it('re-pegs the pool within 10 bps of the price the sweep carries before sweeping', async () => {
        const user = await enrolled();
        // A trade 50 bps up, past the 10 bps band: the crank trades it back from the treasury, then sweeps.
        await chain.trade(treasury, 'SPYx-USDC', 'buy', 1_950n * DOLLAR);
        expect(await deviationBps()).toBeGreaterThan(45);
        await crank.tick();
        expect(await deviationBps()).toBeLessThanOrEqual(10);
        expect(lines.some(({ message, pool }) => message === 'pool re-pegged' && pool === 'SPYx-USDC')).toBe(true);
        const [row] = await attempts(user);
        expect(row).toMatchObject({ outcome: 'landed', route: 'SPYx-USDC' });
    });

    it('refuses to trade a pool more than 500 bps from its target, alarms, and sweeps once it is back', async () => {
        const user = await enrolled();
        const before = await fetchSysvarClock(rpc);
        const spyx = (await chain.rpc.getTokenAccountBalance(await assetAccount(treasury.address)).send()).value.amount;
        await chain.trade(treasury, 'SPYx-USDC', 'buy', 25_000n * DOLLAR);
        expect(await deviationBps()).toBeGreaterThan(500);
        expect(await repegger.tick(before.unixTimestamp)).toMatchObject({
            'repeg-SPYx-USDC': expect.stringMatching(/bps from .*; refusing to re-peg: the devnet pool is not traded/),
            'repeg-SPYx-USDT': null,
        });
        await crank.tick();
        // The pool quotes below min_out: the crank waits, twice (a fresh route after the first), and alarms.
        expect(await outcomes(user)).toEqual(['failed quote below min_out', 'failed quote below min_out']);
        expect(notified.at(-1)).toMatch(/FIRING repeg-before-sweep/);
        // Sold back to where it was: the next run sweeps.
        const bought =
            BigInt((await chain.rpc.getTokenAccountBalance(await assetAccount(treasury.address)).send()).value.amount) -
            BigInt(spyx);
        await chain.trade(treasury, 'SPYx-USDC', 'sell', bought);
        await crank.tick();
        expect((await outcomes(user)).at(-1)).toBe('landed');
        expect(await deviationBps()).toBeLessThanOrEqual(10);
    });

    it('retries a route the pool moved under with a fresh one after a re-peg', async () => {
        const user = await enrolled();
        // The pool moves after the route was quoted: the program refuses the fill below min_out.
        await hook(user, async (request, route) => {
            const quoted = await route(request);
            await chain.trade(treasury, 'SPYx-USDC', 'buy', 3_000n * DOLLAR);
            return quoted;
        });
        await crank.tick();
        expect(await outcomes(user)).toEqual(['failed SlippageExceeded', 'landed']);
        const [refused] = await attempts(user);
        expect(refused!.signature).toBeNull();
    });

    it('builds again once when the pull changed after building', async () => {
        const user = await enrolled();
        // The user spends down to $0.50 above the cushion between the build and the send.
        await hook(user, async (request, route) => {
            await chain.transfer([
                { amount: 79_500_000n, from: user, paymentToken: USDC, to: (await keys.counterparty()).address },
            ]);
            return route(request);
        });
        await crank.tick();
        expect(await outcomes(user)).toEqual(['failed token 1', 'landed']);
        expect((await attempts(user))[1]).toMatchObject({ pull: 500_000n });
    });

    it('alarms and skips the route for the day when it changes a swap-authority account twice', async () => {
        const user = await enrolled();
        const { tokens, cpmm } = devnet;
        const [swapAuthority] = await findSwapAuthorityPda();
        // A route that leaves one raw unit of the pull behind in the swap authority's account.
        const shortRoute = async (request: RouteRequest, route: Routes) => {
            const honest = await route(request);
            const instruction = await routeInstruction({
                amountIn: request.amount - 1n,
                ammConfig: cpmm.ammConfig,
                authority: swapAuthority,
                destination: request.userAssetAccount,
                pool: devnet.pools['SPYx-USDC'],
                tokens,
            });
            return { ...honest, instruction };
        };
        await hook(user, async (request, route) => {
            await hook(user, shortRoute);
            return shortRoute(request, route);
        });
        await crank.tick();
        expect(await outcomes(user)).toEqual(['failed SwapAccountChanged', 'failed SwapAccountChanged']);
        expect(notified.at(-1)).toMatch(
            /FIRING sweep-route: SwapAccountChanged twice with the same pull through SPYx-USDC/,
        );
        await crank.tick();
        expect((await outcomes(user)).at(-1)).toBe('failed No route: SPYx-USDC failed today');
    });

    it("records a third party's sweep as final for the day", async () => {
        const user = await enrolled();
        await hook(user, async (request, route) => {
            await chain.sweep(user, await keys.counterparty());
            return route(request);
        });
        await crank.tick();
        expect(await outcomes(user)).toEqual(['already_swept AlreadySwept']);
        await crank.tick();
        expect(await outcomes(user)).toEqual(['already_swept AlreadySwept']);
    });

    it('reads the state again after NothingToSweep, which spends no day', async () => {
        const user = await enrolled();
        await hook(user, async (request, route) => {
            await chain.setPaused(user, true);
            return route(request);
        });
        await crank.tick();
        expect(await outcomes(user)).toEqual(['failed NothingToSweep']);
        expect((await chain.userConfig(user.address)).lastSweepDay[USDC]).toBe(0);
        await chain.setPaused(user, false);
        await crank.tick();
        expect(await outcomes(user)).toEqual(['failed NothingToSweep', 'landed']);
    });

    it('reads Config again after ProgramPaused and waits for the kill switch', async () => {
        const user = await enrolled();
        await hook(user, async (request, route) => {
            await chain.setProgramPaused(true);
            return route(request);
        });
        await crank.tick();
        expect(await outcomes(user)).toEqual(['failed ProgramPaused']);
        await chain.setProgramPaused(false);
        await crank.tick();
        expect(await outcomes(user)).toEqual(['failed ProgramPaused', 'landed']);
    });

    it('reads the user again after a tier change and sweeps under the new plan', async () => {
        const user = await enrolled();
        await hook(user, async (request, route) => {
            await chain.changeTier(user, 1);
            return route(request);
        });
        await crank.tick();
        expect(await outcomes(user)).toEqual(['failed SubscriptionMismatch', 'landed']);
    });

    it('records a pull that fails as a pull failure and does not retry it that day', async () => {
        const user = await enrolled();
        await hook(user, async (request, route) => {
            await chain.revokeDelegate(user, USDC);
            return route(request);
        });
        await crank.tick();
        await crank.tick();
        expect(await outcomes(user)).toEqual(['pull_failed token 4']);
    });

    it("waits while the asset's issuer pauses it", async () => {
        const user = await enrolled();
        await chain.setAssetPaused(true);
        await crank.tick();
        await chain.setAssetPaused(false);
        await crank.tick();
        expect(await outcomes(user)).toEqual(['failed AssetPaused', 'landed']);
    });

    it('declares the loaded account data the simulation reports, which the validator enforces', async () => {
        const user = await enrolled();
        const { config } = chain;
        const state = await fetchSweepState(rpc, { config, paymentToken: USDC, user: user.address });
        const now = state.now;
        const [[swapAuthority], storage] = await Promise.all([findSwapAuthorityPda(), fetchPythStorage(rpc)]);
        const route = await routeInstruction({
            amountIn: pullTotal(getSweepPull(state)),
            ammConfig: devnet.cpmm.ammConfig,
            authority: swapAuthority,
            destination: await assetAccount(user.address),
            pool: devnet.pools['SPYx-USDC'],
            tokens: devnet.tokens,
        });
        const { message: assetUpdate } = (await prices.asset(devnet.tokens.SPYx.pyth!.proId, now))!;
        const built = await getSweepInstructions({
            assetUpdate,
            crank: crankKey,
            pythTreasury: storage.treasury,
            route,
            state,
        });
        const { value: blockhash } = await rpc.getLatestBlockhash().send();
        const simulate = async (loaded: number) => {
            const message = pipe(
                createSweepTransactionMessage({ crank: crankKey, instructions: built.instructions }),
                m => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
                m => setTransactionMessageComputeUnitLimit(400_000, m),
                m => setTransactionMessageLoadedAccountsDataSizeLimit(loaded, m),
            );
            const { value } = await rpc
                .simulateTransaction(getBase64EncodedWireTransaction(compileTransaction(message)), {
                    encoding: 'base64',
                    replaceRecentBlockhash: true,
                    sigVerify: false,
                })
                .send();
            return value;
        };
        const measured = await simulate(64 * 1024 * 1024);
        expect(measured.err).toBeNull();
        const loaded = Number(measured.loadedAccountsDataSize);
        expect((await simulate(loaded)).err).toBeNull();
        expect((await simulate(loaded - 1)).err).toBe('MaxLoadedAccountsDataSizeExceeded');
        // The crank declares the simulation's figure plus 10%.
        await crank.tick();
        const [row] = await attempts(user);
        expect(row!.loadedAccountsDataSizeLimit).toBe(Math.ceil(loaded * 1.1));
        console.log(
            `a CPMM sweep loads ${loaded} bytes of account data; the crank declares ${row!.loadedAccountsDataSizeLimit}`,
        );
    });

    it('refuses to send a sweep whose compute limit would pass the ceiling', async () => {
        const user = await enrolled();
        const sender = createSender({
            payer: crankKey,
            rpc,
            rpcSubscriptions: createSolanaRpcSubscriptions(chain.validator.wsUrl),
        });
        const state = await fetchSweepState(rpc, { config: chain.config, paymentToken: USDC, user: user.address });
        const [[swapAuthority], storage] = await Promise.all([findSwapAuthorityPda(), fetchPythStorage(rpc)]);
        const route = await routeInstruction({
            amountIn: pullTotal(getSweepPull(state)),
            ammConfig: devnet.cpmm.ammConfig,
            authority: swapAuthority,
            destination: await assetAccount(user.address),
            pool: devnet.pools['SPYx-USDC'],
            tokens: devnet.tokens,
        });
        const { message: assetUpdate } = (await prices.asset(devnet.tokens.SPYx.pyth!.proId, state.now))!;
        const built = await getSweepInstructions({
            assetUpdate,
            crank: crankKey,
            pythTreasury: storage.treasury,
            route,
            state,
        });
        const error = await sender.sendVersion1(built.instructions, { maxComputeUnitLimit: 50_000 }).catch(e => e);
        expect(error).toBeInstanceOf(ComputeLimitExceededError);
        expect(error.ceiling).toBe(50_000);
        expect((await chain.userConfig(user.address)).lastSweepDay[USDC]).toBe(0);
        expect(MAX_SWEEP_COMPUTE_UNIT_LIMIT).toBe(490_000);
    });

    it('sends only sweeps, never an attestation or a record close, and feeds the headroom alarm', async () => {
        for (const instructions of sent) {
            const programs = instructions.map(({ programAddress }) => programAddress);
            expect(programs[0]).toBe('Ed25519SigVerify111111111111111111111111111');
            expect(programs.slice(1)).toEqual([LATERITE_PROGRAM_ADDRESS]);
            expect(containsBytes(instructions[1]!.data!, SWEEP_DISCRIMINATOR, 0)).toBe(true);
        }
        const rows = await db.select().from(sweepAttempts);
        const landed = rows.filter(({ outcome }) => outcome === 'landed');
        const sentOnChain = rows.filter(({ signature }) => signature !== null);
        const latency = landed.map(({ latencyMs }) => latencyMs!).sort((a, b) => a - b);
        console.log(
            `${landed.length} sweeps landed of ${sentOnChain.length} sent; latency from build to confirmation ` +
                `${latency[0]}–${latency.at(-1)} ms (median ${latency[Math.floor(latency.length / 2)]}); ` +
                `compute ${Math.min(...landed.map(r => r.computeUnits!))}–${Math.max(...landed.map(r => r.computeUnits!))} CU; ` +
                `${Math.min(...landed.map(r => r.bytes!))}–${Math.max(...landed.map(r => r.bytes!))} B`,
        );
        expect(landed.length).toBe(sentOnChain.length);
        // The health check's count of the day's outcomes.
        expect((await crank.outcomes(await today())).landed).toBe(landed.length);
        // The indexer stores them with the crank as fee payer, and the headroom alarm reads the latest.
        const last = landed.at(-1)!.signature!;
        await chain.finalized(last as never);
        await new Indexer(
            db,
            rpc,
            chain.config.assets.map(({ mint }) => mint),
            log,
        ).poll();
        const indexed = await db.select().from(sweeps).where(eq(sweeps.feePayer, crankKey.address));
        expect(indexed.length).toBeGreaterThanOrEqual(landed.length);
        // The devnet route's quote is the pool's own output for the pull after its fee, which the sweep received.
        for (const row of landed) {
            const sweep = indexed.find(({ signature }) => signature === row.signature)!;
            expect(sweep.received - row.quoted!).toBeGreaterThanOrEqual(-1n);
            expect(sweep.received - row.quoted!).toBeLessThanOrEqual(1n);
        }
        const headroom = indexed.map(({ headroomBps }) => headroomBps!).sort((a, b) => a - b);
        console.log(`headroom over min_out on the local pools: ${headroom[0]}–${headroom.at(-1)} bps`);
        expect(await headroomAlarm(db, crankKey.address, 'devnet')).toEqual({ 'sweep-headroom': null });
    });
});

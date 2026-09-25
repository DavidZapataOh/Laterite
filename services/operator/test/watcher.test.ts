import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';

import {
    ATTESTATION_TTL_SECONDS,
    type AttestationArgs,
    EventKind,
    findAttestationRecordPda,
    findSwapAuthorityPda,
    getAttestInstructions,
    getAttestationRecordSize,
    LATERITE_ERROR__ATTESTATION_EXPIRED,
    LATERITE_ERROR__NOTHING_TO_INVEST,
} from '@laterite/client';
import { attestations, type Database, watchCursors } from '@laterite/db';
import { createTestDatabase } from '@laterite/db/testing';
import {
    type Address,
    createSolanaRpcSubscriptions,
    fetchEncodedAccount,
    fetchEncodedAccounts,
    getBase58Decoder,
    getBase58Encoder,
    getBase64Encoder,
    getTransactionDecoder,
    type KeyPairSigner,
    type MessagePartialSigner,
    type Signature,
} from '@solana/kit';
import { fetchSysvarClock } from '@solana/sysvars';
import { findAssociatedTokenPda } from '@solana-program/token';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Alarms } from '../src/alarms/alarms';
import { Indexer } from '../src/indexer/indexer';
import { createLogger } from '../src/log';
import { every } from '../src/loop';
import { createFailoverRpc } from '../src/rpc';
import { createSender } from '../src/send';
import { fetchTransaction, type FetchedTransaction } from '../src/transaction';
import { getAttestations, getPaymentTransfers, type WatchedAccount } from '../src/watcher/transfers';
import { attestFailure, attestRefusal, deploymentMismatch } from '../src/watcher/refusals';
import { Watcher } from '../src/watcher/watcher';
import { Chain, params } from './chain/chain';
import { keys, RPC_PORT } from './chain/validator';

const DOLLAR = 1_000_000n;
const USDC = 0;
const USDT = 1;
/** Devnet's genesis hash: a config for another cluster than the local one. */
const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

type Line = { message: string } & Record<string, unknown>;

describe('the watcher on a local chain', () => {
    let chain: Chain;
    let db: Database;
    let drop: () => Promise<void>;
    let indexer: Indexer;
    let alarms: Alarms;
    let watcher: Watcher;
    let ana: KeyPairSigner;
    let ben: KeyPairSigner;
    let cy: KeyPairSigner;
    let counterparty: KeyPairSigner;
    let crank: KeyPairSigner;
    let veteranRecords: Address[];
    const sent: Record<string, Signature> = {};
    const lines: Line[] = [];
    const notified: string[] = [];
    let signed = 0;

    const log = createLogger(
        'info',
        new Writable({
            write(chunk, _, done) {
                lines.push(JSON.parse(chunk.toString()));
                done();
            },
        }),
    );
    /** The attestor as the service holds it, counting the messages it signs. */
    const counting = ({ address, signMessages }: KeyPairSigner): MessagePartialSigner => ({
        address,
        signMessages: messages => {
            signed += messages.length;
            return signMessages(messages);
        },
    });
    const start = async (attestor: KeyPairSigner) =>
        new Watcher({
            alarms,
            attestor: counting(attestor),
            crank,
            db,
            log,
            rpc: createFailoverRpc([chain.validator.rpcUrl]),
            rpcSubscriptions: createSolanaRpcSubscriptions(chain.validator.wsUrl),
        });
    const now = async () => (await fetchSysvarClock(chain.rpc)).unixTimestamp;
    /** Waits for the cluster's clock to pass the current second, so the next transfer is strictly after a control. */
    const nextSecond = async () => {
        const second = await now();
        while ((await now()) <= second) await sleep(200);
    };
    /** Waits until `signature` is finalized, stores the history, then reads every watched account once. */
    const settle = async (signature: Signature, by = watcher) => {
        await chain.finalized(signature);
        await indexer.poll();
        const [from, before] = [lines.length, signed];
        by.reconcile();
        await by.tick();
        const outcomes = lines
            .slice(from)
            .filter(line => line.message.startsWith('transfer'))
            .map(({ message, reason, signature: source, transferIndex }) => ({
                message,
                reason,
                source,
                transferIndex,
            }));
        return { lines: lines.slice(from), outcomes, signed: signed - before };
    };
    const attested = (source: Signature, transferIndex = 0) => ({
        message: 'transfer attested',
        reason: undefined,
        source,
        transferIndex,
    });
    const usdcAccount = async (user: KeyPairSigner): Promise<WatchedAccount> => {
        const { mint, tokenProgram } = chain.config.paymentTokens[USDC]!;
        const [address] = await findAssociatedTokenPda({ mint, owner: user.address, tokenProgram });
        return { address, paymentToken: USDC, user: user.address };
    };
    const income = (to: KeyPairSigner, dollars: bigint, paymentToken = USDC) =>
        chain.transfer([{ amount: dollars * DOLLAR, from: counterparty, paymentToken, to: to.address }]);
    const attestationsOf = async (signature: Signature, user: KeyPairSigner) =>
        getAttestations(
            signature,
            (await fetchTransaction(chain.rpc, signature))!,
            await usdcAccount(user),
            chain.config.paymentTokens,
            (await findSwapAuthorityPda())[0],
        );

    beforeAll(async () => {
        [chain, { db, drop }] = await Promise.all([Chain.start(RPC_PORT + 100), createTestDatabase()]);
        [[ana, ben, cy], counterparty, crank] = await Promise.all([keys.users(), keys.counterparty(), keys.crank()]);
        indexer = new Indexer(
            db,
            createFailoverRpc([chain.validator.rpcUrl]),
            chain.config.assets.map(asset => asset.mint),
            createLogger('silent'),
        );
        alarms = new Alarms(db, async text => void notified.push(text), log, '[laterite local]');
        watcher = await start(await keys.attestor());

        // Two transfers of the veteran attested 15 s before their window ends, so their records expire during the test.
        const veteran = await keys.veteran();
        const eventTime = (await now()) + 15n - ATTESTATION_TTL_SECONDS;
        veteranRecords = [];
        for (let index = 0; index < 2; index++) {
            const old: AttestationArgs = {
                amount: 100n * DOLLAR,
                eventTime,
                kind: EventKind.Income,
                paymentToken: USDC,
                signature: randomBytes(64),
                transferIndex: 0,
                user: veteran.address,
            };
            await chain.attest(old);
            veteranRecords.push((await findAttestationRecordPda(old))[0]);
        }
    });
    afterAll(async () => {
        watcher?.stop();
        await drop?.();
        await chain?.stop();
    });

    it("attests incomes and payments through the user's account, and nothing else", async () => {
        await chain.onboard(ana, params(0b01, { changeMultiplier: 1, incomeRule: true }));
        await chain.onboard(ben, params(0b01, { incomeRule: true }));
        await chain.onboard(cy, params(0b01));
        const second = await chain.createTokenAccount(ana.address, USDC);
        await nextSecond();
        sent.income = await chain.transfer([
            { amount: 100n * DOLLAR, from: counterparty, paymentToken: USDC, plain: true, to: ana.address },
        ]);
        sent.payment = await chain.transfer([
            { amount: 3_200_000n, from: ana, paymentToken: USDC, to: counterparty.address },
        ]);
        sent.swept = await chain.sweep(ana);
        sent.self = await chain.transfer([{ amount: 5n * DOLLAR, from: ana, paymentToken: USDC, toAccount: second }]);
        sent.zero = await income(ana, 0n);
        sent.usdt = await income(ana, 100n, USDT);
        sent.both = await chain.transfer([
            { amount: 60n * DOLLAR, from: counterparty, paymentToken: USDT, to: ana.address },
            { amount: 70n * DOLLAR, from: counterparty, paymentToken: USDC, plain: true, to: ana.address },
        ]);
        sent.small = await income(ana, 20n);
        sent.ben = await income(ben, 100n);
        sent.cy = await income(cy, 100n);

        const { outcomes, signed } = await settle(sent.cy);
        // Accounts are read concurrently: each one's transfers in order.
        expect(outcomes.filter(({ source }) => source !== sent.ben)).toEqual([
            ...[attested(sent.income), attested(sent.payment), attested(sent.both, 1)],
            {
                message: 'transfer not attested',
                reason: 'NothingToInvest',
                source: sent.small,
                transferIndex: 0,
            },
        ]);
        expect(outcomes.filter(({ source }) => source === sent.ben)).toEqual([attested(sent.ben)]);
        expect(signed).toBe(4);
        // 10% of $100 and $70, and $0.80 of change on $3.20.
        expect((await chain.userConfig(ana.address)).pending).toBe(17_800_000n);
        expect((await chain.userConfig(ben.address)).pending).toBe(10n * DOLLAR);
        expect(watcher.watchedAccounts().map(({ user }) => user)).not.toContain(cy.address);
        for (const name of ['swept', 'self', 'zero', 'usdt'] as const) {
            expect(await attestationsOf(sent[name]!, ana)).toEqual([]);
        }
    });

    it('numbers transfers by both payment tokens, skips sweeps and self-transfers, alike in two copies', async () => {
        const [swapAuthority] = await findSwapAuthorityPda();
        const swept = getPaymentTransfers(
            (await fetchTransaction(chain.rpc, sent.swept!))!,
            ana.address,
            chain.config.paymentTokens,
        );
        expect(swept).toMatchObject([{ destinationOwner: swapAuthority, index: 0, sourceOwner: ana.address }]);
        const self = getPaymentTransfers(
            (await fetchTransaction(chain.rpc, sent.self!))!,
            ana.address,
            chain.config.paymentTokens,
        );
        expect(self).toMatchObject([{ amount: 5n * DOLLAR, destinationOwner: ana.address, sourceOwner: ana.address }]);

        // The same transaction from `getTransaction` and from its block numbers its transfers alike.
        const fromTransaction = (await fetchTransaction(chain.rpc, sent.both!))!;
        const block = await chain.rpc
            .getBlock(fromTransaction.slot, {
                commitment: 'finalized',
                encoding: 'base64',
                maxSupportedTransactionVersion: 1,
                rewards: false,
                transactionDetails: 'full',
            })
            .send();
        const inBlock = block!.transactions.find(({ transaction }) => {
            const wire = getTransactionDecoder().decode(getBase64Encoder().encode(transaction[0]));
            return getBase58Decoder().decode(Object.values(wire.signatures)[0]!) === sent.both;
        })!;
        const fromBlock = { ...inBlock, blockTime: block!.blockTime, slot: fromTransaction.slot } as FetchedTransaction;
        const numbered = getPaymentTransfers(fromTransaction, ana.address, chain.config.paymentTokens);
        expect(numbered.map(({ amount, index, paymentToken }) => [index, paymentToken, amount])).toEqual([
            [0, USDT, 60n * DOLLAR],
            [1, USDC, 70n * DOLLAR],
        ]);
        expect(getPaymentTransfers(fromBlock, ana.address, chain.config.paymentTokens)).toEqual(numbered);
    });

    it('signs nothing for a paused user, and no transfer from before a rule was turned on', async () => {
        await chain.setPaused(ben, true);
        await nextSecond();
        sent.benPaused = await income(ben, 100n);
        await nextSecond();
        await chain.updateSettings(cy, params(0b01, { incomeRule: true }));
        await nextSecond();
        sent.cyRule = await income(cy, 100n);

        const { outcomes, signed } = await settle(sent.cyRule);
        expect(outcomes).toEqual([attested(sent.cyRule)]);
        expect(signed).toBe(1);
        expect(watcher.watchedAccounts().map(({ user }) => user)).not.toContain(ben.address);
        expect((await chain.userConfig(cy.address)).pending).toBe(10n * DOLLAR);
    });

    it('attests no transfer from before a payment token was turned on', async () => {
        sent.cyUsdtBefore = await income(cy, 100n, USDT);
        await nextSecond();
        await chain.changePaymentTokens(cy, 0b11);
        await nextSecond();
        sent.cyUsdt = await income(cy, 100n, USDT);

        const { outcomes, signed } = await settle(sent.cyUsdt);
        expect(outcomes).toEqual([attested(sent.cyUsdt)]);
        expect(signed).toBe(1);
        expect((await chain.userConfig(cy.address)).pending).toBe(20n * DOLLAR);
    });

    it('attests nothing from a pause after a resume, nor from before a reactivation', async () => {
        await chain.setPaused(ben, false);
        await nextSecond();
        sent.benResumed = await income(ben, 100n);
        let settled = await settle(sent.benResumed);
        expect(settled.outcomes).toEqual([attested(sent.benResumed)]);
        expect(settled.signed).toBe(1);

        await chain.exit(ben);
        await nextSecond();
        sent.benExited = await income(ben, 100n);
        settled = await settle(sent.benExited);
        expect(settled.outcomes).toEqual([]);
        expect(settled.signed).toBe(0);

        await chain.reactivate(ben, params(0b01, { incomeRule: true }));
        await nextSecond();
        sent.benBack = await income(ben, 100n);
        settled = await settle(sent.benBack);
        expect(settled.outcomes).toEqual([attested(sent.benBack)]);
        expect(settled.signed).toBe(1);
        for (const name of ['benPaused', 'benExited'] as const) {
            const [attestation] = await attestationsOf(sent[name]!, ben);
            const [record] = await findAttestationRecordPda(attestation!);
            expect((await fetchEncodedAccount(chain.rpc, record)).exists).toBe(false);
        }
    });

    it('attests what it missed while stopped exactly once, and nothing twice after a restart', async () => {
        watcher.stop();
        sent.missedIncome = await income(ana, 100n);
        sent.missedPayment = await chain.transfer([
            { amount: 1_500_000n, from: ana, paymentToken: USDC, to: counterparty.address },
        ]);
        watcher = await start(await keys.attestor());
        let settled = await settle(sent.missedPayment);
        expect(settled.outcomes).toEqual([attested(sent.missedIncome), attested(sent.missedPayment)]);
        expect(settled.signed).toBe(2);

        watcher.stop();
        watcher = await start(await keys.attestor());
        settled = await settle(sent.missedPayment);
        expect(settled).toMatchObject({ outcomes: [], signed: 0 });

        // Without its cursors it reads everything again and finds every transfer already counted.
        await db.delete(watchCursors);
        settled = await settle(sent.missedPayment);
        expect(settled.signed).toBe(0);
        expect(new Set(settled.outcomes.map(({ message }) => message))).toEqual(
            new Set(['transfer already attested', 'transfer not attested']),
        );
        expect(settled.outcomes.filter(({ message }) => message === 'transfer already attested')).toHaveLength(7);
    });

    it('counts a transfer someone else attested first once, and reads refusals from the program', async () => {
        sent.third = await income(ana, 100n);
        await chain.finalized(sent.third);
        const [attestation] = await attestationsOf(sent.third, ana);
        await chain.attest(attestation!);
        const settled = await settle(sent.third);
        expect(settled.outcomes).toEqual([
            { message: 'transfer already attested', reason: undefined, source: sent.third, transferIndex: 0 },
        ]);
        expect(settled.signed).toBe(0);

        // The program's own answers, as the watcher reads them from a failed simulation.
        const sender = createSender({
            payer: crank,
            rpc: chain.rpc,
            rpcSubscriptions: createSolanaRpcSubscriptions(chain.validator.wsUrl),
        });
        const failure = async (attestation: AttestationArgs, attestor: KeyPairSigner) => {
            const message = await sender.build(
                await getAttestInstructions({
                    attestation,
                    attestor,
                    genesisHash: chain.config.genesisHash,
                    payer: crank,
                }),
            );
            return sender.send(message).then(
                () => 'landed',
                (error: unknown) => attestFailure(error, message),
            );
        };
        const fresh = { ...attestation!, signature: randomBytes(64) };
        expect(await failure(attestation!, await keys.attestor())).toEqual({ kind: 'counted' });
        expect(await failure(fresh, await keys.nextAttestor())).toEqual({ kind: 'signature' });
        expect(await failure({ ...fresh, amount: 20n * DOLLAR }, await keys.attestor())).toEqual({
            kind: 'refused',
            reason: LATERITE_ERROR__NOTHING_TO_INVEST,
        });
    });

    it("reads the user's state right before signing, never from what it last saw", async () => {
        await chain.setPaused(ana, true);
        await nextSecond();
        sent.anaPaused = await income(ana, 100n);
        // The pause is not indexed yet, so the watcher still watches ana's account.
        await chain.finalized(sent.anaPaused);
        const [from, before] = [lines.length, signed];
        watcher.reconcile();
        await watcher.tick();
        expect(signed).toBe(before);
        expect(lines.slice(from).filter(({ message }) => message.startsWith('transfer'))).toMatchObject([
            { message: 'transfer not attested', reason: 'UserNotActive', signature: sent.anaPaused },
        ]);
        await chain.setPaused(ana, false);
    });

    it('reads only finalized transactions', async () => {
        await nextSecond();
        sent.confirmed = await income(ana, 100n);
        const [from, before] = [lines.length, signed];
        watcher.reconcile();
        await watcher.tick();
        expect(signed).toBe(before);
        // Not even listed: listing it would fail the read of a transaction that is not final yet.
        expect(lines.slice(from).map(({ message }) => message)).not.toContain('account not read, retrying');
        expect(lines.slice(from).filter(({ message }) => message.startsWith('transfer'))).toEqual([]);
        const settled = await settle(sent.confirmed);
        expect(settled.outcomes).toEqual([attested(sent.confirmed)]);
    });

    it('refuses to sign for another attestor or cluster, and signs with the rotated key what is still due', async () => {
        const genesisHash = await chain.rpc.getGenesisHash().send();
        const attestor = (await keys.attestor()).address;
        expect(deploymentMismatch(chain.config, genesisHash, attestor)).toBeNull();
        expect(
            deploymentMismatch(
                { ...chain.config, genesisHash: getBase58Encoder().encode(DEVNET_GENESIS_HASH) },
                genesisHash,
                attestor,
            ),
        ).toBe(
            `the RPC serves the cluster ${genesisHash}, not the one Laterite's config names (${DEVNET_GENESIS_HASH})`,
        );

        sent.beforeRotation = await income(ana, 100n);
        const next = await keys.nextAttestor();
        await chain.rotateAttestor(next.address);
        const [cursor] = await db
            .select()
            .from(watchCursors)
            .where(eq(watchCursors.tokenAccount, (await usdcAccount(ana)).address));
        let settled = await settle(sent.beforeRotation);
        expect(settled).toMatchObject({ outcomes: [], signed: 0 });
        expect(settled.lines.map(({ message }) => message)).toContain(
            `not signing: Config.attestor is ${next.address}, not this service's key ${attestor}: set ATTESTOR_KEYPAIR to the key update_config named`,
        );
        expect((await watcher.deploymentCheck()).mismatch).not.toBeNull();
        expect(notified.at(-1)).toMatch(/^\[laterite local\] FIRING attestor-deployment: Config\.attestor is /);
        expect(
            (await db.select().from(watchCursors).where(eq(watchCursors.tokenAccount, cursor!.tokenAccount)))[0],
        ).toEqual(cursor);

        watcher.stop();
        watcher = await start(next);
        settled = await settle(sent.beforeRotation);
        expect(settled.outcomes).toEqual([attested(sent.beforeRotation)]);
        expect(settled.signed).toBe(1);
        expect(notified.at(-1)).toMatch(/^\[laterite local\] RESOLVED attestor-deployment/);
    });

    it('drops a transfer once it is older than the window', async () => {
        const [attestation] = await attestationsOf(sent.confirmed!, ana);
        const user = await chain.userConfig(ana.address);
        const end = BigInt(attestation!.eventTime) + ATTESTATION_TTL_SECONDS;
        expect(attestRefusal(user, attestation!, end)).toBeNull();
        expect(attestRefusal(user, attestation!, end + 1n)).toBe(LATERITE_ERROR__ATTESTATION_EXPIRED);
    });

    it('closes its expired records, the rent back to the crank, and counts the rent still locked', async () => {
        const rent = await chain.rpc.getMinimumBalanceForRentExemption(BigInt(getAttestationRecordSize())).send();
        const from = lines.length;
        await watcher.closeRecords();
        const [closed] = lines.slice(from).filter(line => line.message === 'expired records closed');
        expect(closed).toMatchObject({ records: 2 });
        expect((await fetchEncodedAccounts(chain.rpc, veteranRecords)).map(({ exists }) => exists)).toEqual([
            false,
            false,
        ]);
        const transaction = await chain.rpc
            .getTransaction(closed!.signature as Signature, {
                commitment: 'confirmed',
                encoding: 'json',
                maxSupportedTransactionVersion: 0,
            })
            .send();
        const crankIndex = transaction!.transaction.message.accountKeys.indexOf(crank.address);
        const { fee, postBalances, preBalances } = transaction!.meta!;
        expect(postBalances[crankIndex]! - preBalances[crankIndex]!).toBe(2n * rent - fee);
        // Every attestation the crank paid for in this test but the veteran's two.
        expect(watcher.records).toEqual({ lockedLamports: 13n * rent, open: 13 });
        expect(lines.at(-1)).toMatchObject({
            enrolledUsers: 3,
            lockedLamports: (13n * rent).toString(),
            message: 'attestation records',
            openRecords: 13,
        });
        await chain.finalized(closed!.signature as Signature);
        await indexer.poll();
        const rows = await db.select().from(attestations).where(inArray(attestations.record, veteranRecords));
        expect(rows.map(row => row.closedSignature)).toEqual([closed!.signature, closed!.signature]);
    });

    it('attests a payment within seconds of its finality, woken by the account notification', async () => {
        const stopping = new AbortController();
        const running = every('watcher', 1_000, () => watcher.tick(), log, stopping.signal);
        try {
            const signature = await income(ana, 100n);
            const confirmedAt = Date.now();
            await chain.finalized(signature);
            const finalizedAt = Date.now();
            const [attestation] = await attestationsOf(signature, ana);
            const [record] = await findAttestationRecordPda(attestation!);
            while (!(await fetchEncodedAccount(chain.rpc, record, { commitment: 'confirmed' })).exists)
                await sleep(100);
            const landedAt = Date.now();
            console.log(
                `attested ${((landedAt - confirmedAt) / 1_000).toFixed(1)} s after confirmation, ${((landedAt - finalizedAt) / 1_000).toFixed(1)} s after finality`,
            );
            expect(landedAt - finalizedAt).toBeLessThan(5_000);
        } finally {
            stopping.abort();
            await running;
        }
    });

    it('sends each attestation as one version 0 transaction the simulation sized', async () => {
        const [line] = lines.filter(
            ({ message, signature }) => message === 'transfer attested' && signature === sent.income,
        );
        const transaction = await chain.rpc
            .getTransaction(line!.attestation as Signature, {
                commitment: 'confirmed',
                encoding: 'base64',
                maxSupportedTransactionVersion: 0,
            })
            .send();
        const bytes = getBase64Encoder().encode(transaction!.transaction[0]).length;
        const { computeUnitsConsumed, fee } = transaction!.meta!;
        console.log(`attest transaction: ${bytes} bytes, ${computeUnitsConsumed} CU, ${fee} lamports`);
        expect(transaction!.version).toBe(0);
        expect(bytes).toBeLessThanOrEqual(1_232);
    });
});

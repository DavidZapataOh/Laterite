import { setTimeout as sleep } from 'node:timers/promises';

import {
    ATTESTATION_RECORD_DISCRIMINATOR,
    ATTESTATION_TTL_SECONDS,
    type AttestationArgs,
    type Config,
    decodeUserConfig,
    enabledPaymentTokens,
    EventKind,
    fetchAllMaybeUserConfig,
    fetchConfig,
    findAttestationRecordPda,
    findConfigPda,
    findSwapAuthorityPda,
    findUserConfigPda,
    getAttestationRecordSize,
    getAttestInstructions,
    getCloseAttestationInstruction,
    LATERITE_PROGRAM_ADDRESS,
    USER_CONFIG_DISCRIMINATOR,
    type UserConfig,
    UserStatus,
} from '@laterite/client';
import { attestations, type Database, userEvents, watchCursors } from '@laterite/db';
import {
    type Address,
    assertAccountExists,
    type Base58EncodedBytes,
    createTransactionPlanExecutor,
    createTransactionPlanner,
    fetchEncodedAccounts,
    getBase58Decoder,
    type MessagePartialSigner,
    parallelInstructionPlan,
    parseBase64RpcAccount,
    type ReadonlyUint8Array,
    type Rpc,
    type RpcSubscriptions,
    type Signature,
    type SolanaRpcApi,
    type SolanaRpcSubscriptionsApi,
    type TransactionSigner,
} from '@solana/kit';
import { fetchSysvarClock } from '@solana/sysvars';
import { findAssociatedTokenPda } from '@solana-program/token';
import { and, eq, gt, isNull, lt, max } from 'drizzle-orm';

import type { Alarms } from '../alarms/alarms';
import type { Logger } from '../log';
import { createSender, type Sender } from '../send';
import { fetchTransaction } from '../transaction';
import { attestFailure, attestRefusal, deploymentMismatch, FINAL } from './refusals';
import { getAttestations, type WatchedAccount } from './transfers';

/** How often every watched account is read in full, besides the ones a notification names. */
export const RECONCILE_MS = 5 * 60 * 1_000;
/** How long a deployment check stays current when there is nothing to sign. */
const DEPLOYMENT_CHECK_MS = 60 * 1_000;
/** Accounts read at once. */
const SCAN_CONCURRENCY = 4;
/** Failed ticks in a row after which the watcher alarms. */
const FAILURES_TO_ALARM = 3;
/** Expired records closed per run, oldest first. */
const CLOSE_BATCH = 256;

const base58 = (bytes: ReadonlyUint8Array) => getBase58Decoder().decode(bytes) as Base58EncodedBytes;

export type WatcherInput = {
    alarms: Alarms;
    /** Signs attestation messages and nothing else. */
    attestor: MessagePartialSigner;
    /** Pays every fee and every record's rent. */
    crank: TransactionSigner;
    db: Database;
    log: Logger;
    rpc: Rpc<SolanaRpcApi>;
    rpcSubscriptions: RpcSubscriptions<SolanaRpcSubscriptionsApi>;
};

/**
 * Attests enrolled users' payments: incoming ones for the income rule and outgoing ones for change per payment, from
 * each watched user's associated account in each enabled payment token, read from finalized transactions after the
 * account's cursor. It signs only after checking the deployment and each user's state, submits `attest` with the crank
 * paying, and closes its own records once expired.
 */
export class Watcher {
    /** When the last tick finished without an error, in milliseconds. */
    lastSuccessAt: number | null = null;
    /** Open records the crank paid for and the rent they hold, as of the last close run. */
    records: { lockedLamports: bigint; open: number } | null = null;

    private config: Config | undefined;
    private checkedAt = 0;
    private readonly dirty = new Set<Address>();
    private eventsSlot: bigint | undefined;
    private failures = 0;
    private reconciledAt = 0;
    private readonly sender: Sender;
    private readonly stopping = new AbortController();
    private readonly subscriptions = new Map<Address, AbortController>();
    private readonly users = new Map<Address, UserConfig>();
    private readonly watched = new Map<Address, WatchedAccount>();

    constructor(private readonly input: WatcherInput) {
        this.sender = createSender({ payer: input.crank, rpc: input.rpc, rpcSubscriptions: input.rpcSubscriptions });
    }

    /** Why signing is refused now (see {@link deploymentMismatch}), from the confirmed `Config` and the RPC. */
    async deploymentCheck(): Promise<{ config: Config; mismatch: string | null }> {
        const { rpc } = this.input;
        const [{ data: config }, genesisHash] = await Promise.all([
            fetchConfig(rpc, (await findConfigPda())[0], { commitment: 'confirmed' }),
            rpc.getGenesisHash().send(),
        ]);
        return { config, mismatch: deploymentMismatch(config, genesisHash, this.input.attestor.address) };
    }

    /** Marks every watched account to be read in full on the next tick. */
    reconcile(): void {
        for (const address of this.watched.keys()) this.dirty.add(address);
        this.reconciledAt = Date.now();
    }

    /** The token accounts watched now. */
    watchedAccounts(): WatchedAccount[] {
        return [...this.watched.values()];
    }

    /** Follows the watched users' changes, then reads every account due and attests what it finds. */
    async tick(): Promise<void> {
        this.config ??= (await this.deploymentCheck()).config;
        const reload = this.eventsSlot === undefined || Date.now() - this.reconciledAt >= RECONCILE_MS;
        await this.refresh(reload);
        if (reload) this.reconcile();
        const due = [...this.dirty];
        if (due.length === 0 && Date.now() - this.checkedAt < DEPLOYMENT_CHECK_MS) {
            this.lastSuccessAt = Date.now();
            return;
        }
        const { config, mismatch } = await this.deploymentCheck();
        this.checkedAt = Date.now();
        await this.alarm('attestor-deployment', mismatch);
        if (mismatch) {
            this.input.log.error({ attestor: this.input.attestor.address }, `not signing: ${mismatch}`);
            return;
        }
        this.config = config;
        const now = (await fetchSysvarClock(this.input.rpc, { commitment: 'confirmed' })).unixTimestamp;
        for (const address of due) this.dirty.delete(address);
        const failed: Address[] = [];
        let next = 0;
        await Promise.all(
            Array.from({ length: Math.min(SCAN_CONCURRENCY, due.length) }, async () => {
                while (next < due.length) {
                    const account = this.watched.get(due[next++]!);
                    if (!account) continue;
                    try {
                        await this.scan(account, now);
                    } catch (error) {
                        failed.push(account.address);
                        this.dirty.add(account.address);
                        this.input.log.warn({ account: account.address, err: error }, 'account not read, retrying');
                    }
                }
            }),
        );
        this.failures = failed.length === 0 ? 0 : this.failures + 1;
        await this.alarm(
            'watcher',
            this.failures >= FAILURES_TO_ALARM
                ? `the watcher could not read ${failed.length} watched accounts ${this.failures} times in a row (${failed.join(', ')}): check the RPC`
                : null,
        );
        if (failed.length === 0) this.lastSuccessAt = Date.now();
    }

    /**
     * Closes the expired records the crank paid for, as many to a transaction as fit, the rent back to the crank; then
     * counts the records it still holds open on-chain and the rent they lock.
     */
    async closeRecords(): Promise<void> {
        const { crank, db, log, rpc } = this.input;
        const now = (await fetchSysvarClock(rpc, { commitment: 'confirmed' })).unixTimestamp;
        const expired = await db
            .selectDistinct({ expiresAt: attestations.expiresAt, record: attestations.record })
            .from(attestations)
            .where(
                and(
                    isNull(attestations.closedSignature),
                    eq(attestations.payer, crank.address),
                    lt(attestations.expiresAt, new Date(Number(now) * 1_000)),
                ),
            )
            .orderBy(attestations.expiresAt)
            .limit(CLOSE_BATCH);
        const records = expired.map(({ record }) => record as Address);
        const accounts = await fetchEncodedAccounts(rpc, records, { commitment: 'confirmed' });
        const open = records.filter((_, index) => accounts[index]!.exists);
        if (open.length > 0) {
            const base = await this.sender.build([], [crank.address, ...open]);
            const plan = await createTransactionPlanner({ createTransactionMessage: () => base })(
                parallelInstructionPlan(
                    open.map(record => getCloseAttestationInstruction({ payer: crank.address, record })),
                ),
            );
            await createTransactionPlanExecutor({
                executeTransactionMessage: async (context, message) => {
                    const signature = await this.sender.send(message);
                    const records = message.instructions.filter(
                        ({ programAddress }) => programAddress === LATERITE_PROGRAM_ADDRESS,
                    ).length;
                    log.info({ records, signature }, 'expired records closed');
                    return { ...context, signature };
                },
            })(plan);
        }
        const [held, rent, { data: config }] = await Promise.all([
            rpc
                .getProgramAccounts(LATERITE_PROGRAM_ADDRESS, {
                    commitment: 'confirmed',
                    dataSlice: { length: 0, offset: 0 },
                    encoding: 'base64',
                    filters: [
                        { dataSize: BigInt(getAttestationRecordSize()) },
                        { memcmp: { bytes: base58(ATTESTATION_RECORD_DISCRIMINATOR), encoding: 'base58', offset: 0n } },
                        {
                            memcmp: {
                                bytes: crank.address as unknown as Base58EncodedBytes,
                                encoding: 'base58',
                                offset: 8n,
                            },
                        },
                    ],
                })
                .send(),
            rpc.getMinimumBalanceForRentExemption(BigInt(getAttestationRecordSize())).send(),
            fetchConfig(rpc, (await findConfigPda())[0], { commitment: 'confirmed' }),
        ]);
        this.records = { lockedLamports: BigInt(held.length) * rent, open: held.length };
        log.info(
            {
                enrolledUsers: config.userCount,
                lockedLamports: this.records.lockedLamports.toString(),
                openRecords: held.length,
            },
            'attestation records',
        );
    }

    /** Ends every notification subscription. */
    stop(): void {
        this.stopping.abort();
    }

    /** Brings the watched users up to date: all of them, or those with an indexed event since the last refresh. */
    private async refresh(all: boolean) {
        const { db, rpc } = this.input;
        if (all) {
            const [{ slot } = { slot: null }] = await db.select({ slot: max(userEvents.slot) }).from(userEvents);
            const accounts = await rpc
                .getProgramAccounts(LATERITE_PROGRAM_ADDRESS, {
                    commitment: 'confirmed',
                    encoding: 'base64',
                    filters: [
                        {
                            memcmp: {
                                bytes: base58(USER_CONFIG_DISCRIMINATOR),
                                encoding: 'base58',
                                offset: 0n,
                            },
                        },
                    ],
                })
                .send();
            this.users.clear();
            for (const { account, pubkey } of accounts) {
                const { data } = decodeUserConfig(parseBase64RpcAccount(pubkey, account));
                this.users.set(data.user, data);
            }
            this.eventsSlot = slot ?? -1n;
        } else {
            const rows = await db
                .select({ slot: max(userEvents.slot), user: userEvents.user })
                .from(userEvents)
                .where(gt(userEvents.slot, this.eventsSlot!))
                .groupBy(userEvents.user);
            if (rows.length === 0) return;
            const addresses = await Promise.all(
                rows.map(async ({ user }) => (await findUserConfigPda({ user: user as Address }))[0]),
            );
            for (const account of await fetchAllMaybeUserConfig(rpc, addresses, { commitment: 'confirmed' })) {
                if (account.exists) this.users.set(account.data.user, account.data);
            }
            for (const { slot } of rows) if (slot! > this.eventsSlot!) this.eventsSlot = slot!;
        }
        await this.follow();
    }

    /** Watches the associated account of each enabled token of each active user whose rules can invest. */
    private async follow() {
        const config = this.config!;
        const next = new Map<Address, WatchedAccount>();
        for (const user of this.users.values()) {
            if (user.status !== UserStatus.Active || (!user.incomeRule && user.changeMultiplier === 0)) continue;
            for (const paymentToken of enabledPaymentTokens(user.paymentTokens)) {
                const { mint, tokenProgram } = config.paymentTokens[paymentToken]!;
                const [address] = await findAssociatedTokenPda({ mint, owner: user.user, tokenProgram });
                next.set(address, { address, paymentToken, user: user.user });
            }
        }
        for (const [address, controller] of this.subscriptions) {
            if (next.has(address)) continue;
            controller.abort();
            this.subscriptions.delete(address);
        }
        for (const address of next.keys()) {
            if (this.watched.has(address)) continue;
            this.dirty.add(address);
            this.subscribe(address);
        }
        this.watched.clear();
        for (const [address, account] of next) this.watched.set(address, account);
    }

    /** Marks `address` due whenever a finalized block changes it, resubscribing after a dropped connection. */
    private subscribe(address: Address) {
        const controller = new AbortController();
        this.subscriptions.set(address, controller);
        const signal = AbortSignal.any([controller.signal, this.stopping.signal]);
        void (async () => {
            while (!signal.aborted) {
                try {
                    const notifications = await this.input.rpcSubscriptions
                        .accountNotifications(address, { commitment: 'finalized', encoding: 'base64' })
                        .subscribe({ abortSignal: signal });
                    // A change between two subscriptions is caught by reading the account once more.
                    this.dirty.add(address);
                    for await (const _ of notifications) this.dirty.add(address);
                } catch (error) {
                    if (!signal.aborted) this.input.log.warn({ account: address, err: error }, 'subscription lost');
                }
                await sleep(1_000, undefined, { signal }).catch(() => {});
            }
        })();
    }

    /** Reads `account`'s finalized transactions after its cursor, oldest first, and attests each one's transfers. */
    private async scan(account: WatchedAccount, now: bigint) {
        const { db, log, rpc } = this.input;
        const user = this.users.get(account.user)!;
        const windowStart = now - ATTESTATION_TTL_SECONDS;
        const floor = user.attestableFrom > windowStart ? user.attestableFrom : windowStart;
        const [cursor] = await db.select().from(watchCursors).where(eq(watchCursors.tokenAccount, account.address));
        const newestFirst: { blockTime: bigint | null; err: unknown; signature: Signature; slot: bigint }[] = [];
        for (let before: Signature | undefined; ;) {
            const page = await rpc
                .getSignaturesForAddress(account.address, {
                    before,
                    commitment: 'finalized',
                    limit: 1_000,
                    until: cursor?.signature as Signature | undefined,
                })
                .send();
            newestFirst.push(...page);
            const last = page.at(-1);
            if (page.length < 1_000 || (last!.blockTime !== null && last!.blockTime < floor)) break;
            before = last!.signature;
        }
        const [swapAuthority] = await findSwapAuthorityPda();
        let handled: { signature: Signature; slot: bigint } | undefined;
        const outsideWindow: Signature[] = [];
        try {
            for (const { blockTime, err, signature, slot } of newestFirst.reverse()) {
                if (!err && (blockTime === null || blockTime >= floor)) {
                    const transaction = await fetchTransaction(rpc, signature);
                    if (!transaction || transaction.blockTime === null) {
                        throw new Error(`finalized transaction ${signature} is not available yet`);
                    }
                    const found = getAttestations(
                        signature,
                        transaction,
                        account,
                        this.config!.paymentTokens,
                        swapAuthority,
                    );
                    for (const attestation of found) {
                        if (!(await this.attest(attestation, now))) {
                            throw new Error(`a transfer of ${signature} is not attested yet`);
                        }
                    }
                } else if (!err && blockTime! >= user.attestableFrom) {
                    outsideWindow.push(signature);
                }
                handled = { signature, slot };
            }
        } finally {
            if (outsideWindow.length > 0) {
                log.warn(
                    { account: account.address, newest: outsideWindow.at(-1), transactions: outsideWindow.length },
                    'transactions older than the attestation window: not attested',
                );
            }
            if (handled) {
                await db
                    .insert(watchCursors)
                    .values({ ...handled, tokenAccount: account.address })
                    .onConflictDoUpdate({
                        set: { ...handled, updatedAt: new Date() },
                        target: watchCursors.tokenAccount,
                    });
            }
        }
    }

    /**
     * Signs and submits one attestation unless the user's state, read now, refuses it or its record exists. Returns
     * whether the transfer is done with (attested, already counted or never countable); `false` leaves it for a later
     * tick.
     */
    private async attest(attestation: AttestationArgs, now: bigint): Promise<boolean> {
        const { attestor, crank, log, rpc } = this.input;
        const [[userConfig], [record]] = await Promise.all([
            findUserConfigPda({ user: attestation.user }),
            findAttestationRecordPda(attestation),
        ]);
        const [userAccount, recordAccount] = await fetchEncodedAccounts(rpc, [userConfig, record], {
            commitment: 'confirmed',
        });
        const transfer = {
            amount: attestation.amount.toString(),
            kind: attestation.kind === EventKind.Income ? 'income' : 'payment',
            paymentToken: attestation.paymentToken,
            signature: getBase58Decoder().decode(attestation.signature),
            transferIndex: attestation.transferIndex,
            user: attestation.user,
        };
        assertAccountExists(userAccount!);
        const user = decodeUserConfig(userAccount).data;
        this.users.set(attestation.user, user);
        const refusal = attestRefusal(user, attestation, now);
        if (refusal !== null) {
            log.info({ ...transfer, reason: FINAL.get(refusal) }, 'transfer not attested');
            return true;
        }
        if (recordAccount!.exists) {
            log.info(transfer, 'transfer already attested');
            return true;
        }
        const instructions = await getAttestInstructions({
            attestation,
            attestor,
            genesisHash: this.config!.genesisHash,
            payer: crank,
        });
        const message = await this.sender.build(instructions);
        try {
            const signature = await this.sender.send(message);
            log.info({ ...transfer, attestation: signature }, 'transfer attested');
            await this.alarm('invalid-attestation-signature', null);
            return true;
        } catch (error) {
            const failure = attestFailure(error, message);
            if (failure?.kind === 'signature') {
                await this.alarm(
                    'invalid-attestation-signature',
                    `attest refused ${attestor.address}'s signature although Config names it: check Config.attestor and the cluster`,
                );
                return false;
            }
            if (failure?.kind === 'refused') {
                log.info({ ...transfer, reason: FINAL.get(failure.reason) }, 'transfer not attested');
                return true;
            }
            if (failure?.kind === 'counted') {
                log.info(transfer, 'transfer already attested');
                return true;
            }
            throw error;
        }
    }

    private alarm(key: string, message: string | null) {
        return this.input.alarms.set({ [key]: message });
    }
}

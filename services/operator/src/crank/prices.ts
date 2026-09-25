import { setTimeout as sleep } from 'node:timers/promises';

import { feedUpdatedAt, hasFeed, PYTH_PRO_PROGRAM_ADDRESS, type PythStorage, verifyPythUpdate } from '@laterite/client';
import {
    fetchKaminoUpdate,
    fetchLatestKaminoUpdates,
    fetchPythProUpdate,
    KAMINO_SCOPE_PROGRAM_ADDRESS,
} from '@laterite/client/node';
import type {
    GetSignaturesForAddressApi,
    GetTransactionApi,
    LogsNotificationsApi,
    ReadonlyUint8Array,
    Rpc,
    RpcSubscriptions,
    Signature,
} from '@solana/kit';

import type { Logger } from '../log';

/** The newest asset update a sweep may be built with, by its feed's own time: it must land inside the program's 60 s. */
export const MAX_ASSET_UPDATE_AGE_SECONDS = 45n;
/** How long a sweep waits for Kamino Scope's next post when the latest is too old: Scope posts about every 42 s. */
export const KAMINO_WAIT_MS = 50_000;
/** How recent a USDT update must be to serve another sweep: an update is valid for 60 s on-chain. */
export const PAYMENT_UPDATE_REUSE_SECONDS = 20n;
/** How long the relay may go without a post before it also polls Scope's recent transactions. */
const POLL_AFTER_SILENCE_MS = 50_000;
const POLL_INTERVAL_MS = 15_000;
/** Attempts to read a post both mainnet providers do not return yet. */
const POST_READS = 3;

/** An update with its feed's own update time, in Unix seconds. */
export type TimedUpdate = { message: ReadonlyUint8Array; updatedAt: bigint };

/** The price updates a sweep carries, as the crank obtains them. */
export type PriceUpdates = {
    /**
     * The newest checked update carrying the asset feed `feedId`, waiting for a newer post while the latest is older than
     * {@link MAX_ASSET_UPDATE_AGE_SECONDS} at `now` (the cluster's clock); `null` when none came in time.
     */
    asset(feedId: number, now: bigint): Promise<(TimedUpdate & { waitedMs: number }) | null>;
    /** A checked update of the payment token's feed `feedId` (USDT/USD), fetched with the access token. */
    payment(feedId: number, now: bigint): Promise<ReadonlyUint8Array>;
};

type MainnetRpc = Rpc<GetSignaturesForAddressApi & GetTransactionApi>;

/**
 * Holds Kamino Scope's latest Pyth Pro update of each asset feed, read from mainnet as Scope posts it: a confirmed
 * `logsNotifications` subscription on the Scope program names each post that invoked Pyth Pro, and Scope's and Pyth
 * Pro's recent signatures are polled while the subscription is silent. Each post is read with `getTransaction` from
 * the failover RPC (a provider's `null` is asked of the other) and kept only when its signer is one the cluster's
 * Pyth Pro storage trusts and its signature verifies.
 */
export class KaminoRelay {
    private readonly latest = new Map<number, TimedUpdate & { signature: Signature }>();
    private readonly seen = new Set<Signature>();
    private lastPollAt = 0;
    private lastPostAt = 0;
    private posted = new AbortController();
    private storage: { at: number; value: PythStorage } | undefined;

    constructor(
        private readonly input: {
            feedIds: readonly number[];
            log: Logger;
            /** Mainnet through the failover RPC: the primary provider, then the fallback. */
            mainnet: MainnetRpc;
            mainnetSubscriptions?: RpcSubscriptions<LogsNotificationsApi>;
            /** Reads the Pyth Pro storage of the cluster the sweeps land on: its trusted signers. */
            storage: () => Promise<PythStorage>;
            /** How long {@link asset} waits for a fresh post ({@link KAMINO_WAIT_MS} by default). */
            waitMs?: number;
        },
    ) {}

    /** The latest update of each feed, for the relay's alarms. */
    updates(): ReadonlyMap<number, TimedUpdate> {
        return this.latest;
    }

    /** Follows Scope's posts until `signal` aborts: the subscription, and the poll while it is silent. */
    start(signal: AbortSignal): void {
        void this.subscribe(signal);
        void (async () => {
            while (!signal.aborted) {
                if (Date.now() - this.lastPostAt >= POLL_AFTER_SILENCE_MS) {
                    await this.poll().catch(error => this.input.log.warn({ err: error }, 'Kamino Scope poll failed'));
                }
                await sleep(POLL_INTERVAL_MS, undefined, { signal }).catch(() => {});
            }
        })();
    }

    /** Reads the latest post carrying each feed from Scope's and Pyth Pro's recent signatures. */
    async poll(): Promise<void> {
        this.lastPollAt = Date.now();
        const found = await fetchLatestKaminoUpdates(this.input.mainnet, this.input.feedIds);
        for (const { message, signature } of found.values()) await this.keep(signature, message);
    }

    /** Reads the post `signature` and keeps its update; a post neither provider returns yet is read again. */
    async ingest(signature: Signature): Promise<void> {
        if (this.seen.has(signature)) return;
        for (let read = 1; read <= POST_READS; read++) {
            const post = await fetchKaminoUpdate(this.input.mainnet, signature);
            if (post) return this.keep(signature, post.message);
            if (read < POST_READS) await sleep(2_000 * read);
        }
        this.input.log.warn({ signature }, 'Kamino Scope post not returned by either mainnet provider');
    }

    async asset(feedId: number, now: bigint): Promise<(TimedUpdate & { waitedMs: number }) | null> {
        const { waitMs = KAMINO_WAIT_MS } = this.input;
        const started = Date.now();
        for (;;) {
            const waitedMs = Date.now() - started;
            const update = this.latest.get(feedId);
            if (
                update &&
                now + BigInt(Math.floor(waitedMs / 1_000)) - update.updatedAt <= MAX_ASSET_UPDATE_AGE_SECONDS
            ) {
                return { message: update.message, updatedAt: update.updatedAt, waitedMs };
            }
            if (waitedMs >= waitMs) return null;
            // A sweep waiting for a fresh post also polls, in case the subscription missed it.
            if (Date.now() - this.lastPollAt >= POLL_INTERVAL_MS) await this.poll().catch(() => {});
            const timeout = AbortSignal.timeout(Math.min(POLL_INTERVAL_MS, waitMs - waitedMs));
            await sleep(waitMs, undefined, { signal: AbortSignal.any([this.posted.signal, timeout]) }).catch(() => {});
        }
    }

    private async keep(signature: Signature, message: ReadonlyUint8Array) {
        this.seen.add(signature);
        if (this.seen.size > 10_000) this.seen.clear();
        const storage = await this.trusted();
        await verifyPythUpdate(message, storage, BigInt(Math.floor(Date.now() / 1_000)));
        let kept = false;
        for (const feedId of this.input.feedIds) {
            if (!hasFeed(message, feedId)) continue;
            const updatedAt = feedUpdatedAt(message, feedId);
            const current = this.latest.get(feedId);
            if (updatedAt === null || (current && current.updatedAt >= updatedAt)) continue;
            this.latest.set(feedId, { message, signature, updatedAt });
            kept = true;
        }
        if (!kept) return;
        this.lastPostAt = Date.now();
        this.posted.abort();
        this.posted = new AbortController();
    }

    /** The cluster's Pyth Pro storage, read again every ten minutes: its signers can be rotated. */
    private async trusted() {
        if (!this.storage || Date.now() - this.storage.at > 600_000) {
            this.storage = { at: Date.now(), value: await this.input.storage() };
        }
        return this.storage.value;
    }

    private async subscribe(signal: AbortSignal) {
        const { log, mainnetSubscriptions } = this.input;
        if (!mainnetSubscriptions) return;
        while (!signal.aborted) {
            try {
                const notifications = await mainnetSubscriptions
                    .logsNotifications({ mentions: [KAMINO_SCOPE_PROGRAM_ADDRESS] }, { commitment: 'confirmed' })
                    .subscribe({ abortSignal: signal });
                for await (const { value } of notifications) {
                    // Scope refreshes many oracles: only a post that invoked Pyth Pro carries a Pyth Pro update.
                    if (
                        value.err ||
                        !value.logs.some(line => line.startsWith(`Program ${PYTH_PRO_PROGRAM_ADDRESS} invoke`))
                    ) {
                        continue;
                    }
                    void this.ingest(value.signature).catch(error =>
                        log.warn({ err: error, signature: value.signature }, 'Kamino Scope post not kept'),
                    );
                }
            } catch (error) {
                if (!signal.aborted) log.warn({ err: error }, 'Kamino Scope subscription lost');
            }
            await sleep(5_000, undefined, { signal }).catch(() => {});
        }
    }
}

/**
 * The payment token's update, fetched from Pyth Pro with the service's access token (never logged) and checked against
 * the cluster's storage; one update serves every sweep built within {@link PAYMENT_UPDATE_REUSE_SECONDS} of its time.
 */
export class PythProUpdates {
    private readonly latest = new Map<number, TimedUpdate>();

    constructor(
        private readonly input: {
            accessToken: string;
            fetch?: typeof globalThis.fetch;
            storage: () => Promise<PythStorage>;
        },
    ) {}

    async payment(feedId: number, now: bigint): Promise<ReadonlyUint8Array> {
        const cached = this.latest.get(feedId);
        if (cached && now - cached.updatedAt <= PAYMENT_UPDATE_REUSE_SECONDS) return cached.message;
        const message = await fetchPythProUpdate({
            accessToken: this.input.accessToken,
            fetch: this.input.fetch,
            priceFeedIds: [feedId],
        });
        await verifyPythUpdate(message, await this.input.storage(), now);
        const updatedAt = feedUpdatedAt(message, feedId);
        if (updatedAt !== null) this.latest.set(feedId, { message, updatedAt });
        return message;
    }
}

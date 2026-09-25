import {
    address,
    type Address,
    assertAccountExists,
    fetchEncodedAccount,
    fixDecoderSize,
    getAddressDecoder,
    getArrayDecoder,
    getBytesDecoder,
    getI64Decoder,
    getPublicKeyFromAddress,
    getStructDecoder,
    getU64Decoder,
    getU8Decoder,
    type GetAccountInfoApi,
    type ReadonlyUint8Array,
    type Rpc,
    type SignatureBytes,
    verifySignature,
} from '@solana/kit';

import { MAX_CONFIDENCE_BPS, MAX_PRICE_AGE_SECONDS, SLIPPAGE_BPS } from './constants';
import { LateriteCheckError } from './errors';
import {
    LATERITE_ERROR__AMOUNT_TOO_SMALL,
    LATERITE_ERROR__INVALID_PRICE_UPDATE,
    LATERITE_ERROR__PRICE_UNAVAILABLE,
    LATERITE_ERROR__PRICE_UNCERTAIN,
    LATERITE_ERROR__STALE_PRICE,
} from './generated';

/** Pyth Pro's program on every cluster. */
export const PYTH_PRO_PROGRAM_ADDRESS = address('pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt');

/** Pyth Pro's storage account: its trusted signers and the treasury that collects the verification fee. */
export const PYTH_STORAGE_ADDRESS = address('3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL');

const SOLANA_FORMAT_MAGIC = 2_182_742_457;
const PAYLOAD_FORMAT_MAGIC = 2_479_346_549;
/** Magic, signature, public key and payload length: the bytes of a Solana-format update before its payload. */
const ENVELOPE = 4 + 64 + 32 + 2;
const U64_MAX = 2n ** 64n - 1n;
const U128_MAX = 2n ** 128n - 1n;

/** A price of `price × 10^exponent` dollars, with its confidence in the same units. */
export type Quote = { confidence: bigint; exponent: number; price: bigint };

/** Exactly one dollar, for payment tokens counted at face value. */
export const DOLLAR_QUOTE: Quote = { confidence: 0n, exponent: 0, price: 1n };

/** A Solana-format Pyth Pro update, split into what its signature covers. */
export type PythUpdate = { payload: ReadonlyUint8Array; publicKey: Address; signature: SignatureBytes };

class Reader {
    private offset = 0;
    constructor(private readonly bytes: ReadonlyUint8Array) {}

    get remaining() {
        return this.bytes.length - this.offset;
    }

    private take(length: number): DataView {
        if (this.remaining < length) throw new LateriteCheckError(LATERITE_ERROR__INVALID_PRICE_UPDATE);
        const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, length);
        this.offset += length;
        return view;
    }

    skip(length: number) {
        this.take(length);
    }
    u8 = () => this.take(1).getUint8(0);
    u16 = () => this.take(2).getUint16(0, true);
    i16 = () => this.take(2).getInt16(0, true);
    u32 = () => this.take(4).getUint32(0, true);
    u64 = () => this.take(8).getBigUint64(0, true);
    /** An `i64` where 0 encodes "absent". */
    nonzero = () => {
        const value = this.take(8).getBigInt64(0, true);
        return value === 0n ? undefined : value;
    };
    /** A presence flag, then a `u64` when present. */
    optional = () => {
        const flag = this.u8();
        if (flag === 0) return undefined;
        if (flag === 1) return this.u64();
        throw new LateriteCheckError(LATERITE_ERROR__INVALID_PRICE_UPDATE);
    };
}

/** Splits a Solana-format update into its signature, signer and payload; fails as the program does on malformed bytes. */
export function parsePythUpdate(message: ReadonlyUint8Array): PythUpdate {
    const reader = new Reader(message);
    if (reader.u32() !== SOLANA_FORMAT_MAGIC) throw new LateriteCheckError(LATERITE_ERROR__INVALID_PRICE_UPDATE);
    reader.skip(96);
    if (reader.u16() !== reader.remaining) throw new LateriteCheckError(LATERITE_ERROR__INVALID_PRICE_UPDATE);
    return {
        payload: message.slice(ENVELOPE),
        publicKey: getAddressDecoder().decode(message.slice(68, 100)),
        signature: message.slice(4, 68) as SignatureBytes,
    };
}

type Feed = { confidence?: bigint; exponent?: number; price?: bigint; updatedAt?: bigint };

function findFeed(payload: ReadonlyUint8Array, feedId: number): Feed | undefined {
    const reader = new Reader(payload);
    if (reader.u32() !== PAYLOAD_FORMAT_MAGIC) throw new LateriteCheckError(LATERITE_ERROR__INVALID_PRICE_UPDATE);
    reader.skip(9); // timestamp and channel
    for (let feeds = reader.u8(); feeds > 0; feeds--) {
        const id = reader.u32();
        const feed: Feed = {};
        for (let properties = reader.u8(); properties > 0; properties--) {
            const property = reader.u8();
            if (property === 0) feed.price = reader.nonzero();
            else if (property === 4) feed.exponent = reader.i16();
            else if (property === 5) feed.confidence = reader.nonzero();
            else if (property === 12) feed.updatedAt = reader.optional();
            else if ([1, 2, 10, 11].includes(property)) reader.skip(8);
            else if (property === 3 || property === 9) reader.skip(2);
            else if (property >= 6 && property <= 8) reader.optional();
            else throw new LateriteCheckError(LATERITE_ERROR__INVALID_PRICE_UPDATE);
        }
        if (id === feedId) return feed;
    }
    return undefined;
}

/** Whether a well-formed update carries `feedId`, whatever its values. */
export function hasFeed(message: ReadonlyUint8Array, feedId: number): boolean {
    try {
        return findFeed(parsePythUpdate(message).payload, feedId) !== undefined;
    } catch {
        return false;
    }
}

/**
 * When `feedId`'s price in a well-formed update was last updated, by the feed's own timestamp, in Unix seconds: the time
 * the program's freshness check reads. `null` when the update does not carry the feed or its timestamp.
 */
export function feedUpdatedAt(message: ReadonlyUint8Array, feedId: number): bigint | null {
    const updatedAt = findFeed(parsePythUpdate(message).payload, feedId)?.updatedAt;
    return updatedAt === undefined ? null : updatedAt / 1_000_000n;
}

/**
 * The quote of `feedId` in one Solana-format update, as the program's `quote` reads it at `now`: fresh by the
 * feed's own update time and within the confidence bound. Feed 0 is {@link DOLLAR_QUOTE} and takes no update.
 * `maxAgeSeconds` lets a sender require a younger price than the program does, so it still lands in time.
 */
export function quote(
    message: ReadonlyUint8Array,
    feedId: number,
    now: bigint,
    maxAgeSeconds: bigint = MAX_PRICE_AGE_SECONDS,
): Quote {
    if (feedId === 0) {
        if (message.length !== 0) throw new LateriteCheckError(LATERITE_ERROR__INVALID_PRICE_UPDATE);
        return DOLLAR_QUOTE;
    }
    const feed = findFeed(parsePythUpdate(message).payload, feedId);
    if (!feed) throw new LateriteCheckError(LATERITE_ERROR__PRICE_UNAVAILABLE);
    const { confidence, exponent, price, updatedAt } = feed;
    if (price === undefined || confidence === undefined || exponent === undefined || updatedAt === undefined) {
        throw new LateriteCheckError(LATERITE_ERROR__PRICE_UNAVAILABLE);
    }
    if (price < 0n || confidence < 0n) throw new LateriteCheckError(LATERITE_ERROR__PRICE_UNAVAILABLE);
    if (now - updatedAt / 1_000_000n > maxAgeSeconds) throw new LateriteCheckError(LATERITE_ERROR__STALE_PRICE);
    if (confidence * 10_000n > price * MAX_CONFIDENCE_BPS)
        throw new LateriteCheckError(LATERITE_ERROR__PRICE_UNCERTAIN);
    return { confidence, exponent, price };
}

/**
 * The program's `min_out`: the least raw output a swap of `amount` raw units of a payment token into an asset may
 * deliver, at the payment token's lowest and the asset's highest price within confidence, less `SLIPPAGE_BPS`.
 */
export function minOut(amount: bigint, payment: Quote, paymentDecimals: number, asset: Quote, assetDecimals: number) {
    const invalid = () => new LateriteCheckError(LATERITE_ERROR__INVALID_PRICE_UPDATE);
    const worth = amount * (payment.price > payment.confidence ? payment.price - payment.confidence : 0n);
    const assetPrice = asset.price + asset.confidence;
    const scale = payment.exponent - asset.exponent + assetDecimals - paymentDecimals;
    const factor = 10n ** BigInt(Math.abs(scale));
    if (factor > U128_MAX) throw invalid();
    const [numerator, denominator] = scale >= 0 ? [worth * factor, assetPrice] : [worth, assetPrice * factor];
    if (numerator > U128_MAX || denominator > U128_MAX || denominator === 0n) throw invalid();
    const scaled = (numerator / denominator) * (10_000n - SLIPPAGE_BPS);
    if (scaled > U128_MAX) throw invalid();
    const out = scaled / 10_000n;
    if (out === 0n && amount !== 0n) throw new LateriteCheckError(LATERITE_ERROR__AMOUNT_TOO_SMALL);
    if (out > U64_MAX) throw invalid();
    return out;
}

/** A key Pyth Pro accepts updates from until `expiresAt`. */
export type PythTrustedSigner = { expiresAt: bigint; pubkey: Address };

/** Pyth Pro's storage account, as its IDL lays it out. */
export type PythStorage = {
    singleUpdateFeeInLamports: bigint;
    topAuthority: Address;
    treasury: Address;
    trustedSigners: PythTrustedSigner[];
};

const STORAGE_DISCRIMINATOR = [209, 117, 255, 185, 196, 175, 68, 9];

/** Decodes Pyth Pro's storage account data. */
export function decodePythStorage(data: ReadonlyUint8Array): PythStorage {
    if (STORAGE_DISCRIMINATOR.some((byte, index) => data[index] !== byte)) {
        throw new Error('Not a Pyth Pro storage account');
    }
    const signer = getStructDecoder([
        ['pubkey', getAddressDecoder()],
        ['expiresAt', getI64Decoder()],
    ]);
    const storage = getStructDecoder([
        ['discriminator', fixDecoderSize(getBytesDecoder(), 8)],
        ['topAuthority', getAddressDecoder()],
        ['treasury', getAddressDecoder()],
        ['singleUpdateFeeInLamports', getU64Decoder()],
        ['numTrustedSigners', getU8Decoder()],
        ['trustedSigners', getArrayDecoder(signer, { size: 5 })],
    ]).decode(data);
    return {
        singleUpdateFeeInLamports: storage.singleUpdateFeeInLamports,
        topAuthority: storage.topAuthority,
        treasury: storage.treasury,
        trustedSigners: storage.trustedSigners.slice(0, storage.numTrustedSigners),
    };
}

/** Reads Pyth Pro's storage from the cluster, which Pyth Pro must own: the signers it trusts and the treasury a sweep pays. */
export async function fetchPythStorage(rpc: Rpc<GetAccountInfoApi>, storage = PYTH_STORAGE_ADDRESS) {
    const account = await fetchEncodedAccount(rpc, storage);
    assertAccountExists(account);
    if (account.programAddress !== PYTH_PRO_PROGRAM_ADDRESS) throw new Error(`${storage} is not Pyth Pro's account`);
    return decodePythStorage(account.data);
}

/**
 * Checks an update as Pyth Pro will before a transaction carries it: the Solana format, and an ed25519 signature
 * over the payload by a signer the storage account trusts at `now`.
 */
export async function verifyPythUpdate(message: ReadonlyUint8Array, storage: PythStorage, now: bigint) {
    const update = parsePythUpdate(message);
    const trusted = storage.trustedSigners.some(
        ({ expiresAt, pubkey }) => pubkey === update.publicKey && expiresAt > now,
    );
    if (!trusted) throw new Error(`Pyth Pro does not trust the update's signer ${update.publicKey}`);
    const key = await getPublicKeyFromAddress(update.publicKey);
    if (!(await verifySignature(key, update.signature, update.payload))) {
        throw new Error("The update's signature does not verify");
    }
    return update;
}

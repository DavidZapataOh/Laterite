import { fetchConfig, findConfigPda } from '@laterite/client';
import {
    type Address,
    getBase58Decoder,
    getBase64Encoder,
    getCompiledTransactionMessageDecoder,
    getTransactionDecoder,
    isSolanaError,
    SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED,
    SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
    type Transaction,
} from '@solana/kit';
import { ipAddress } from '@vercel/functions';
import { type NextRequest, NextResponse } from 'next/server';
import { database } from '@/lib/db';
import { isBlocked, requestRegion } from '@/lib/geo';
import { closedReason } from '@/lib/onboarding';
import {
    cosign,
    failureOf,
    logSponsor,
    messageHash,
    onboardingLookupTable,
    sendSponsored,
    shapeProblem,
    signedBy,
    sponsorRpc,
    sponsorSigner,
} from '@/lib/sponsor';
import { claimSend, settleSend } from '@/lib/sponsorships';

const headers = { 'Cache-Control': 'no-store' };

/** A version 0 transaction is at most 1,232 bytes, about 1,650 in base64. */
const MAX_BODY = 4096;

/**
 * Co-signs and sends a transaction the wallet signed, only when its message is byte for byte one `prepare` built for
 * that wallet within two minutes and never sent, the program is open, the wallet, its address and the sponsor are
 * within their limits, the asset account is paid at most once, and the message is an allowed shape. Answers once the
 * cluster confirms it.
 */
export async function POST(request: NextRequest) {
    const ip = ipAddress(request) ?? null;
    // who a refusal is logged for, once the request names a wallet
    const who: { wallet?: Address } = {};
    const refuse = (error: string, status: number, extra: Record<string, unknown> = {}, retryAfter?: number) => {
        logSponsor(status >= 500 || error === 'shape' ? 'error' : 'warn', 'sponsor refused to co-sign', {
            error,
            ip,
            status,
            wallet: who.wallet,
            ...extra,
        });
        return NextResponse.json(
            { error, ...extra },
            { headers: retryAfter ? { ...headers, 'Retry-After': String(retryAfter) } : headers, status },
        );
    };
    if (isBlocked(requestRegion(request.headers))) return refuse('unavailable', 451);
    const text = await request.text();
    if (text.length > MAX_BODY) return refuse('invalid', 413);
    let transaction: Transaction;
    let user: Address;
    let blockhash: string;
    try {
        const { transaction: wire } = JSON.parse(text) ?? {};
        transaction = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
        const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
        user = compiled.staticAccounts[1]!;
        blockhash = compiled.lifetimeToken;
    } catch {
        return refuse('invalid', 400);
    }
    const wallet = (who.wallet = user);
    if (!(await signedBy(transaction, user))) return refuse('signature', 400);

    const db = database();
    const { rpc, rpcSubscriptions } = sponsorRpc();
    const sponsor = await sponsorSigner();
    const { data: config } = await fetchConfig(rpc, (await findConfigPda())[0], { commitment: 'confirmed' });
    const closed = closedReason(config);
    if (closed) return refuse(closed, 409);
    if (config.sponsor !== sponsor.address) return refuse('sponsor', 503);

    const claim = await claimSend(db, { ip, message: messageHash(transaction.messageBytes), wallet });
    if (!claim.ok) {
        if (claim.reason === 'limited') return refuse('limited', 429, { limit: claim.limit }, claim.retryAfterSeconds);
        return refuse(claim.reason, claim.reason === 'unknown' ? 400 : 409);
    }
    const { row } = claim;
    const lookupTable = await onboardingLookupTable(rpc, config);
    const shape = await shapeProblem(transaction, {
        config,
        kind: row.kind,
        lookupTable,
        sponsor: sponsor.address,
        user,
    });
    if (shape) {
        await settleSend(db, row.id, { landed: false, reason: `shape: ${shape}` });
        return refuse('shape', 400, { shape });
    }
    const signed = await cosign(transaction, sponsor);
    const signature = getBase58Decoder().decode(signed.signatures[sponsor.address]!);
    try {
        await sendSponsored({
            blockhash,
            lastValidBlockHeight: row.lastValidBlockHeight,
            rpc,
            rpcSubscriptions,
            transaction: signed,
        });
    } catch (error) {
        if (isSolanaError(error, SOLANA_ERROR__BLOCK_HEIGHT_EXCEEDED)) {
            await settleSend(db, row.id, { landed: false, reason: 'expired', signature });
            return refuse('expired', 409);
        }
        const programs = instructionPrograms(transaction, lookupTable);
        const cause = isSolanaError(error, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE)
            ? error.cause
            : isSolanaError(error)
              ? error
              : undefined;
        if (cause) {
            const failure = failureOf(cause, programs);
            await settleSend(db, row.id, {
                landed: false,
                reason: `${failure.program} ${failure.code ?? ''}`.trim(),
                signature,
            });
            return refuse('simulation', 422, { ...failure });
        }
        await settleSend(db, row.id, { landed: false, reason: String(error), signature });
        throw error;
    }
    await settleSend(db, row.id, { landed: true, signature });
    logSponsor('info', 'sponsor sent', { kind: row.kind, signature, wallet });
    return NextResponse.json({ signature }, { headers });
}

/** The program of each instruction of `transaction`'s message, in order, the lookup table resolved. */
function instructionPrograms(transaction: Transaction, lookupTable: Record<Address, Address[]>): Address[] {
    const compiled = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    if (compiled.version !== 0) return [];
    const lookups = compiled.addressTableLookups ?? [];
    const accounts = [
        ...compiled.staticAccounts,
        ...lookups.flatMap(({ lookupTableAddress, writableIndexes }) =>
            writableIndexes.map(index => lookupTable[lookupTableAddress]![index]!),
        ),
        ...lookups.flatMap(({ lookupTableAddress, readonlyIndexes }) =>
            readonlyIndexes.map(index => lookupTable[lookupTableAddress]![index]!),
        ),
    ];
    return compiled.instructions.map(({ programAddressIndex }) => accounts[programAddressIndex]!);
}

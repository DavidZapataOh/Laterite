import {
    type Address,
    getBase64EncodedWireTransaction,
    getBase64Encoder,
    getTransactionDecoder,
    isTransactionModifyingSigner,
    isTransactionPartialSigner,
    type Signature,
    type Transaction,
    type TransactionSigner,
} from '@solana/kit';

import { intentBody, type OnboardingIntent } from './onboarding';
import { isUserRejection } from './solana';

/** What the route's simulation of the exact transaction says, before the wallet opens. */
export type Simulation = { computeUnits: number; sponsorLamports: bigint; userLamports: bigint };

/** A transaction the sponsor route built and simulated, waiting for the wallet's signature. */
export type Prepared = { preparedAt: number; simulation: Simulation; transaction: Transaction };

/** A prepared transaction's blockhash expires within about a minute; an older one is built again before signing. */
export const PREPARED_FRESH_MS = 45_000;

/**
 * Why nothing was signed or sent, in words the screen can say: the route's refusal (`paused`, `full`, `limited`,
 * `asset-account`, `enrolled`, `simulation`, `expired`, ...), the wallet's (`rejected`, `modified`, `version`), or the
 * network's (`network`).
 */
export class PermissionError extends Error {
    constructor(
        readonly reason: string,
        readonly detail: {
            asset?: Address;
            code?: number;
            limit?: string;
            program?: string;
            retryAfterSeconds?: number;
        } = {},
    ) {
        super(reason);
        this.name = 'PermissionError';
    }
}

async function post(path: string, body: unknown, signal?: AbortSignal) {
    let response: Response;
    try {
        response = await fetch(`/api/sponsor/${path}`, {
            body: JSON.stringify(body),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
            signal,
        });
    } catch (error) {
        if (signal?.aborted) throw error;
        throw new PermissionError('network');
    }
    const answer = await response.json().catch(() => ({}));
    if (response.ok) return answer;
    const retry = Number(response.headers.get('retry-after'));
    throw new PermissionError(typeof answer.error === 'string' ? answer.error : 'network', {
        asset: answer.asset,
        code: answer.code,
        limit: answer.limit,
        program: answer.program,
        retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? retry : undefined,
    });
}

/** Asks the sponsor route to build and simulate `intent` for `wallet`. */
export async function prepare(wallet: Address, intent: OnboardingIntent, signal?: AbortSignal): Promise<Prepared> {
    const { simulation, transaction } = await post('prepare', { intent: intentBody(intent), wallet }, signal);
    return {
        preparedAt: Date.now(),
        simulation: {
            computeUnits: simulation.computeUnits,
            sponsorLamports: BigInt(simulation.sponsorLamports),
            userLamports: BigInt(simulation.userLamports),
        },
        transaction: getTransactionDecoder().decode(getBase64Encoder().encode(transaction)),
    };
}

const sameBytes = (a: Transaction['messageBytes'], b: Transaction['messageBytes']) =>
    a.length === b.length && a.every((byte, i) => byte === b[i]);

/**
 * The wallet's one signature on a prepared transaction. A wallet that changes the message instead of signing it is
 * refused here, before anything is sent.
 */
export async function signPrepared(signer: TransactionSigner, { transaction }: Prepared): Promise<Transaction> {
    let signed: Transaction;
    try {
        if (isTransactionModifyingSigner(signer)) {
            [signed] = (await signer.modifyAndSignTransactions([transaction as never])) as unknown as Transaction[];
        } else if (isTransactionPartialSigner(signer)) {
            const [signatures] = await signer.signTransactions([transaction as never]);
            signed = { ...transaction, signatures: { ...transaction.signatures, ...signatures } };
        } else {
            throw new PermissionError('version');
        }
    } catch (error) {
        if (error instanceof PermissionError) throw error;
        throw new PermissionError(isUserRejection(error) ? 'rejected' : 'wallet');
    }
    if (!sameBytes(signed!.messageBytes, transaction.messageBytes)) {
        throw new PermissionError('modified');
    }
    return signed!;
}

/** Hands the wallet-signed transaction to the sponsor route, which co-signs, sends and answers once it is confirmed. */
export async function submit(signed: Transaction): Promise<Signature> {
    const { signature } = await post('submit', { transaction: getBase64EncodedWireTransaction(signed) });
    return signature;
}

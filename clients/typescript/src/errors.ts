import type { Address } from '@solana/kit';

import { getLateriteErrorMessage, type LateriteError } from './generated';

/** A transaction the program would refuse with `code`, caught before it is built. */
export class LateriteCheckError extends Error {
    readonly code: LateriteError;

    constructor(code: LateriteError) {
        super(getLateriteErrorMessage(code));
        this.name = 'LateriteCheckError';
        this.code = code;
    }
}

/**
 * Why a payment token cannot be pulled until the user restores it: its subscription was closed or ran out, its
 * Subscriptions authority was revoked or re-created, the account's delegate is not the authority, or the account is
 * frozen.
 */
export type RestoreReason = 'authority' | 'delegate' | 'frozen' | 'subscription';

/** A payment token ended outside Laterite: the crank skips it and the app offers Restore. */
export class RestoreRequiredError extends Error {
    readonly account: Address;
    readonly reason: RestoreReason;

    constructor(reason: RestoreReason, account: Address) {
        super(`${account} needs a restore: ${reason}`);
        this.name = 'RestoreRequiredError';
        this.account = account;
        this.reason = reason;
    }
}

/** A subscription whose authority is gone can be closed only by the payer it recorded, whose key is not at hand. */
export class RecordedPayerRequiredError extends Error {
    readonly payer: Address;
    readonly subscription: Address;

    constructor(payer: Address, subscription: Address) {
        super(`Only ${payer}, who paid for ${subscription}, can close it`);
        this.name = 'RecordedPayerRequiredError';
        this.payer = payer;
        this.subscription = subscription;
    }
}

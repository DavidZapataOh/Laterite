import {
    ATTESTATION_TTL_SECONDS,
    EventKind,
    getLateriteEventData,
    getLateriteLogEvents,
    identifyLateriteEvent,
    identifyLateriteInstruction,
    LATERITE_PROGRAM_ADDRESS,
    LateriteEvent,
    LateriteInstruction,
    parseAttestedEvent,
    parseAttestInstruction,
    parseCloseAttestationInstruction,
    parseEnrolledEvent,
    parseExitedEvent,
    parsePaymentTokensChangedEvent,
    parsePendingLoweredEvent,
    parseReactivatedEvent,
    parseSweptEvent,
    parseTierChangedEvent,
    parseUserPausedEvent,
    parseUserSettingsUpdatedEvent,
    SWEPT_EVENT_DISCRIMINATOR,
} from '@laterite/client';
import type { attestations, sweeps, userEvents, UserEventData } from '@laterite/db';
import {
    AccountRole,
    type Address,
    containsBytes,
    getBase16Decoder,
    getBase58Decoder,
    getBase58Encoder,
    getBase64Encoder,
    getCompiledTransactionMessageDecoder,
    getTransactionDecoder,
    type ReadonlyUint8Array,
} from '@solana/kit';

/** A finalized transaction as `getTransaction` returns it with `encoding: 'base64'`. */
export type FetchedTransaction = {
    blockTime: bigint | null;
    meta: {
        err: unknown;
        innerInstructions?:
            | readonly {
                  index: number;
                  instructions: readonly { accounts: readonly number[]; data: string; programIdIndex: number }[];
              }[]
            | null;
        loadedAddresses?: { readonly: readonly Address[]; writable: readonly Address[] };
        logMessages?: readonly string[] | null;
    } | null;
    slot: bigint;
    transaction: readonly [string, 'base64'];
};

export type Sweep = Omit<typeof sweeps.$inferInsert, 'multiplier'>;
export type AttestationRow = typeof attestations.$inferInsert;
export type UserEventRow = typeof userEvents.$inferInsert;
export type Close = { closedAt: Date; closedSignature: string; record: Address };

/** What one transaction adds to the history. */
export type Decoded = { attestations: AttestationRow[]; closes: Close[]; sweeps: Sweep[]; userEvents: UserEventRow[] };

type Executed = { accounts: Address[]; data: ReadonlyUint8Array; programAddress: Address };

/** Laterite's instructions in the order they ran: each top-level one followed by those it invoked. */
function executedInstructions(transaction: FetchedTransaction): { executed: Executed[]; feePayer: Address } {
    const wire = getTransactionDecoder().decode(getBase64Encoder().encode(transaction.transaction[0]));
    const message = getCompiledTransactionMessageDecoder().decode(wire.messageBytes);
    const loaded = transaction.meta?.loadedAddresses;
    const keys = [...message.staticAccounts, ...(loaded?.writable ?? []), ...(loaded?.readonly ?? [])];
    const outer =
        'instructions' in message
            ? message.instructions.map(({ accountIndices, data, programAddressIndex }) => ({
                  accounts: accountIndices ?? [],
                  data: data ?? new Uint8Array(),
                  programIdIndex: programAddressIndex,
              }))
            : message.instructionHeaders.map((header, index) => ({
                  accounts: message.instructionPayloads[index]!.instructionAccountIndices,
                  data: message.instructionPayloads[index]!.instructionData,
                  programIdIndex: header.programAccountIndex,
              }));
    const inner = new Map(
        (transaction.meta?.innerInstructions ?? []).map(({ index, instructions }) => [index, instructions]),
    );
    const resolve = (accounts: readonly number[], data: ReadonlyUint8Array, programIdIndex: number): Executed => ({
        accounts: accounts.map(index => keys[index]!),
        data,
        programAddress: keys[programIdIndex]!,
    });
    const executed = outer.flatMap(({ accounts, data, programIdIndex }, index) => [
        resolve(accounts, data, programIdIndex),
        ...(inner.get(index) ?? []).map(instruction =>
            resolve(instruction.accounts, getBase58Encoder().encode(instruction.data), instruction.programIdIndex),
        ),
    ]);
    return { executed, feePayer: keys[0]! };
}

const asInstruction = ({ accounts, data, programAddress }: Executed) => ({
    accounts: accounts.map(address => ({ address, role: AccountRole.READONLY })),
    data,
    programAddress,
});

const isLaterite = (instruction: Executed, kind: LateriteInstruction) => {
    if (instruction.programAddress !== LATERITE_PROGRAM_ADDRESS) return false;
    try {
        return identifyLateriteInstruction(instruction.data) === kind;
    } catch {
        return false;
    }
};

/** Event fields as JSON: amounts as decimal strings, bytes as hex. */
function toJson(value: unknown): unknown {
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Uint8Array) return getBase16Decoder().decode(value);
    if (Array.isArray(value)) return value.map(toJson);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, toJson(field)]));
    }
    return value;
}

/**
 * The history rows of one successful transaction: `Swept` from Laterite's self-CPI among the inner instructions, the
 * `emit!` events from the `Program data:` lines Laterite itself logged, and each attestation's payer and each closed
 * record from the `attest` and `close_attestation` instructions, identified by discriminator.
 */
export function decodeTransaction(signature: string, transaction: FetchedTransaction): Decoded {
    const decoded: Decoded = { attestations: [], closes: [], sweeps: [], userEvents: [] };
    if (!transaction.meta || transaction.meta.err || transaction.blockTime === null) return decoded;
    const blockTime = new Date(Number(transaction.blockTime) * 1_000);
    const at = { blockTime, signature, slot: transaction.slot };
    const { executed, feePayer } = executedInstructions(transaction);

    for (const instruction of executed) {
        const data = getLateriteEventData(instruction);
        if (!data || !containsBytes(data, SWEPT_EVENT_DISCRIMINATOR, 0)) continue;
        const event = parseSweptEvent(data);
        decoded.sweeps.push({ ...at, ...event, eventIndex: decoded.sweeps.length, feePayer });
    }
    for (const instruction of executed.filter(i => isLaterite(i, LateriteInstruction.CloseAttestation))) {
        const { accounts } = parseCloseAttestationInstruction(asInstruction(instruction));
        decoded.closes.push({ closedAt: blockTime, closedSignature: signature, record: accounts.record.address });
    }
    const attests = executed.filter(i => isLaterite(i, LateriteInstruction.Attest)).map(asInstruction);

    const user = (kind: UserEventRow['kind'], address: Address, data: UserEventData = {}) =>
        decoded.userEvents.push({ ...at, data, eventIndex: decoded.userEvents.length, kind, user: address });
    for (const data of getLateriteLogEvents(transaction.meta.logMessages ?? [])) {
        let kind: LateriteEvent;
        try {
            kind = identifyLateriteEvent(data);
        } catch {
            continue;
        }
        switch (kind) {
            case LateriteEvent.Attested: {
                const { attestation, invested, pending } = parseAttestedEvent(data);
                const { accounts } = parseAttestInstruction(attests[decoded.attestations.length]!);
                decoded.attestations.push({
                    ...at,
                    amount: attestation.amount,
                    eventIndex: decoded.attestations.length,
                    eventTime: new Date(Number(attestation.eventTime) * 1_000),
                    expiresAt: new Date(Number(attestation.eventTime + ATTESTATION_TTL_SECONDS) * 1_000),
                    invested,
                    kind: attestation.kind === EventKind.Income ? 'income' : 'payment',
                    payer: accounts.payer.address,
                    paymentToken: attestation.paymentToken,
                    pendingAfter: pending,
                    record: accounts.record.address,
                    sourceSignature: getBase58Decoder().decode(attestation.signature),
                    transferIndex: attestation.transferIndex,
                    user: attestation.user,
                });
                break;
            }
            case LateriteEvent.Enrolled: {
                const { asset, paymentTokens, tier, user: address } = parseEnrolledEvent(data);
                user('enrolled', address, { asset, paymentTokens, tier });
                break;
            }
            case LateriteEvent.Reactivated: {
                const { asset, paymentTokens, tier, user: address } = parseReactivatedEvent(data);
                user('reactivated', address, { asset, paymentTokens, tier });
                break;
            }
            case LateriteEvent.UserSettingsUpdated: {
                const { params, user: address } = parseUserSettingsUpdatedEvent(data);
                user('settings_updated', address, { params: toJson(params) as Record<string, unknown> });
                break;
            }
            case LateriteEvent.UserPaused: {
                const { paused, user: address } = parseUserPausedEvent(data);
                user(paused ? 'paused' : 'resumed', address);
                break;
            }
            case LateriteEvent.PendingLowered: {
                const { pending, user: address } = parsePendingLoweredEvent(data);
                user('pending_lowered', address, { pending: pending.toString() });
                break;
            }
            case LateriteEvent.TierChanged: {
                const { tier, user: address } = parseTierChangedEvent(data);
                user('tier_changed', address, { tier });
                break;
            }
            case LateriteEvent.PaymentTokensChanged: {
                const { paymentTokens, user: address } = parsePaymentTokensChangedEvent(data);
                user('payment_tokens_changed', address, { paymentTokens });
                break;
            }
            case LateriteEvent.Exited:
                user('exited', parseExitedEvent(data).user);
                break;
            default:
                break;
        }
    }
    return decoded;
}

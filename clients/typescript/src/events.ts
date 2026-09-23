import { type Address, containsBytes, getBase64Encoder, type ReadonlyUint8Array } from '@solana/kit';

import { LATERITE_PROGRAM_ADDRESS, parseSweptEvent, SWEPT_EVENT_DISCRIMINATOR, type SweptEvent } from './generated';

/** Anchor's tag before an event emitted by self-CPI: `sha256("anchor:event")[..8]`, little-endian. */
export const EVENT_IX_TAG_LE = new Uint8Array([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);

/** An executed instruction: its program and data, as a transaction's inner instructions list them. */
export type ExecutedInstruction = { data: ReadonlyUint8Array; programAddress: Address };

/**
 * The event data of a Laterite self-CPI (discriminator first), or `null` for any other instruction. Events are read
 * from inner instructions, never from logs, which a long route can truncate.
 */
export function getLateriteEventData(instruction: ExecutedInstruction): ReadonlyUint8Array | null {
    if (instruction.programAddress !== LATERITE_PROGRAM_ADDRESS) return null;
    return containsBytes(instruction.data, EVENT_IX_TAG_LE, 0) ? instruction.data.slice(EVENT_IX_TAG_LE.length) : null;
}

/** The `Swept` event among a successful sweep's inner instructions. */
export function findSweptEvent(innerInstructions: Iterable<ExecutedInstruction>): SweptEvent | undefined {
    for (const instruction of innerInstructions) {
        const data = getLateriteEventData(instruction);
        if (data && containsBytes(data, SWEPT_EVENT_DISCRIMINATOR, 0)) return parseSweptEvent(data);
    }
    return undefined;
}

/**
 * The data of the events Laterite emitted with `emit!` (every event but `Swept`), discriminator first, in order: the
 * `Program data:` lines logged while Laterite itself was executing, not a program it called.
 */
export function getLateriteLogEvents(logs: readonly string[]): ReadonlyUint8Array[] {
    const running: string[] = [];
    const events: ReadonlyUint8Array[] = [];
    for (const line of logs) {
        const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(line);
        if (invoke) running.push(invoke[1]!);
        else if (/^Program \w+ (success|failed)/.test(line)) running.pop();
        else if (line.startsWith('Program data: ') && running.at(-1) === LATERITE_PROGRAM_ADDRESS) {
            events.push(getBase64Encoder().encode(line.slice('Program data: '.length)));
        }
    }
    return events;
}

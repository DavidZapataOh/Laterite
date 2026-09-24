import { setTimeout as sleep } from 'node:timers/promises';

import type { Logger } from './log';

/**
 * Runs `task` every `intervalMs` until `signal` aborts, logging a failure and trying again on the next tick. A task
 * that returns `true` has more to do and runs again at once.
 */
export async function every(
    name: string,
    intervalMs: number,
    task: () => Promise<boolean | void>,
    log: Logger,
    signal: AbortSignal,
): Promise<void> {
    while (!signal.aborted) {
        let again = false;
        try {
            again = (await task()) === true;
        } catch (error) {
            log.error({ err: error, task: name }, `${name} failed`);
        }
        if (!again) await sleep(intervalMs, undefined, { signal }).catch(() => {});
    }
}

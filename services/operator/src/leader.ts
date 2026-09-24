import type { Database } from '@laterite/db';

/** The advisory lock that makes one process at a time the operator. */
const OPERATOR_LOCK = 7_470_001;

/**
 * Waits until this process holds the operator lock, on a connection of its own kept for the process's life: during a
 * deploy the new process stays a healthy standby until the old one exits and its session ends. `onLost` runs if that
 * connection ends, since the lock ends with it.
 */
export async function acquireLeadership(db: Database, onLost: (error: Error) => void): Promise<() => Promise<void>> {
    const client = await db.$client.connect();
    client.on('error', onLost);
    await client.query('select pg_advisory_lock($1)', [OPERATOR_LOCK]);
    return async () => {
        client.off('error', onLost);
        await client.query('select pg_advisory_unlock($1)', [OPERATOR_LOCK]).catch(() => {});
        client.release();
    };
}

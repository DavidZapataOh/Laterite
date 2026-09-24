import { alarms, type Database } from '@laterite/db';
import { eq } from 'drizzle-orm';

import type { Logger } from '../log';

/** Delivers one line of text to the operator. */
export type Notify = (text: string) => Promise<void>;

/** How often a firing alarm is repeated to the operator. */
export const REPEAT_MS = 6 * 60 * 60 * 1_000;

/**
 * Posts `text` to an incoming webhook in Slack's format (`{"text": …}`), which Slack takes as is and Discord takes at
 * its webhook URL followed by `/slack`.
 */
export function webhookNotifier(url: string, fetch: typeof globalThis.fetch = globalThis.fetch): Notify {
    return async text => {
        const response = await fetch(url, {
            body: JSON.stringify({ text }),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`The alert webhook answered ${response.status}`);
    };
}

/**
 * The operations alarms, kept in Postgres: an alarm notifies the operator when it starts firing, every
 * {@link REPEAT_MS} while it fires and once when it resolves. Every change is also logged, at `error` while firing.
 */
export class Alarms {
    constructor(
        private readonly db: Database,
        private readonly notify: Notify,
        private readonly log: Logger,
        private readonly prefix: string,
        private readonly repeatMs = REPEAT_MS,
    ) {}

    /** Brings each alarm in `states` to its state: a message fires it, `null` resolves it. */
    async set(states: Record<string, string | null>, now = new Date()): Promise<void> {
        const stored = new Map((await this.db.select().from(alarms)).map(row => [row.key, row]));
        for (const [key, message] of Object.entries(states)) {
            const row = stored.get(key);
            if (message === null) {
                if (!row?.firing) continue;
                await this.db.update(alarms).set({ changedAt: now, firing: false }).where(eq(alarms.key, key));
                this.log.info({ alarm: key }, `resolved: ${row.message}`);
                await this.deliver(`${this.prefix} RESOLVED ${key}: ${row.message}`);
                continue;
            }
            const started = !row?.firing;
            const due = started || !row.notifiedAt || now.getTime() - row.notifiedAt.getTime() >= this.repeatMs;
            if (started) this.log.error({ alarm: key }, message);
            const label = started || !row.notifiedAt ? 'FIRING' : 'STILL FIRING';
            const notified = due && (await this.deliver(`${this.prefix} ${label} ${key}: ${message}`));
            const values = {
                changedAt: started ? now : row.changedAt,
                firing: true,
                key,
                message,
                notifiedAt: notified ? now : (row?.notifiedAt ?? null),
            };
            await this.db.insert(alarms).values(values).onConflictDoUpdate({ set: values, target: alarms.key });
        }
    }

    /** The alarms firing now, oldest first. */
    async firing() {
        const rows = await this.db.select().from(alarms).where(eq(alarms.firing, true)).orderBy(alarms.changedAt);
        return rows.map(({ changedAt, key, message }) => ({ key, message, since: changedAt }));
    }

    private async deliver(text: string): Promise<boolean> {
        try {
            await this.notify(text);
            return true;
        } catch (error) {
            this.log.error({ err: error }, 'alert not delivered');
            return false;
        }
    }
}

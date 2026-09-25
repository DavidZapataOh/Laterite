import { alarms, type Database } from '@laterite/db';
import { eq } from 'drizzle-orm';

import type { Logger } from '../log';
import { createBotApi } from '../telegram/api';

/** Delivers one line of text to the operator. */
export type Notify = (text: string) => Promise<void>;

/** How often a firing alarm is repeated to the operator. */
export const REPEAT_MS = 6 * 60 * 60 * 1_000;

/** Sends `text` to the operations chat through the Telegram Bot API's `sendMessage`. */
export function telegramNotifier(
    botToken: string,
    chatId: string,
    options: { api?: string; fetch?: typeof globalThis.fetch } = {},
): Notify {
    const call = createBotApi(botToken, options);
    return async text => {
        await call('sendMessage', { chat_id: chatId, link_preview_options: { is_disabled: true }, text });
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

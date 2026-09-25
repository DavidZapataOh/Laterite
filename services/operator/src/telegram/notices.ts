import {
    type Config,
    fetchAllMaybeUserConfig,
    fetchConfig,
    findConfigPda,
    findUserConfigPda,
    spentAt,
    TIERS,
    type UserConfig,
    UserStatus,
    weeklyCap,
} from '@laterite/client';
import { type Database, telegramLinks, telegramNotifications, type UserEventData } from '@laterite/db';
import { addresses as devnet } from '@laterite/devnet/addresses';
import type { Address, Rpc, SolanaRpcApi } from '@solana/kit';
import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Logger } from '../log';
import { type BotApi, TelegramError } from './api';
import { botTranslator } from './messages';

/** How far back a notification is still worth sending: older events are recorded as handled, not sent. */
export const NOTICE_WINDOW_MS = 24 * 60 * 60 * 1_000;

/** Shares of the goal that each send one message the first time the invested total reaches them. */
export const GOAL_MILESTONES = [25, 50, 75, 100] as const;

/** The user's own controls the bot confirms. */
type Control = 'exited' | 'payment_tokens_changed' | 'paused' | 'reactivated' | 'resumed' | 'tier_changed';

/** One notification for one chat: its key (the source it comes from), when its source happened and its text. */
type Notice = { at: Date; chatId: bigint; key: string; text: string | null };

type Link = { chat_id: string; locale: string };
type SweepRow = Link & {
    asset: number;
    block_time: Date;
    engine: string;
    event_index: number;
    multiplier: number;
    payment_token: number;
    pending: string;
    received: string;
    signature: string;
    slot: string;
    user: Address;
};
type EventRow = Link & {
    block_time: Date;
    data: UserEventData;
    event_index: number;
    kind: Control;
    signature: string;
    user: Address;
};
type AttemptRow = Link & {
    at: Date;
    day: number;
    id: string;
    outcome: 'pull_failed' | 'skipped';
    payment_token: number;
    previous_reason: string | null;
    reason: string | null;
    user: Address;
};

const dollars = (raw: bigint) => Number(raw) / 1e6;
const symbolOf = (mint: Address) => Object.entries(devnet.tokens).find(([, token]) => token.mint === mint)?.[0] ?? mint;
const goalLabel = (user: UserConfig) => {
    const end = user.goalLabel.indexOf(0);
    return new TextDecoder().decode(user.goalLabel.slice(0, end === -1 ? undefined : end)).trim();
};

/**
 * The product bot's notifications to every linked chat, from the indexed history (finalized): each purchase with the
 * week's cap and what waits, each goal milestone, each of the user's own controls, and each day a token was not
 * bought (the crank's final word). Each is handled once per chat, recorded before it is sent, so a restart never
 * repeats one; a skipped day while paused, a `RestoreRequired` day after another, and anything while the user is
 * exited but the exit itself are recorded and not sent.
 */
export class Notices {
    /** Telegram's flood control: nothing is sent before this time. */
    private resumeAt = 0;

    constructor(
        private readonly api: BotApi,
        private readonly db: Database,
        private readonly rpc: Rpc<SolanaRpcApi>,
        private readonly log: Logger,
    ) {}

    /** Sends what is new since each chat was linked, within {@link NOTICE_WINDOW_MS}, oldest first. */
    async tick(now = new Date()): Promise<void> {
        if (now.getTime() < this.resumeAt) return;
        const since = new Date(now.getTime() - NOTICE_WINDOW_MS);
        const [sweeps, events, attempts] = await Promise.all([
            this.rows<SweepRow>(sql`
                select l.chat_id, l.locale, s.signature, s.event_index, s.slot, s."user", s.payment_token, s.asset,
                    s.engine, s.pending, s.received, s.multiplier, s.block_time
                from telegram_links l join sweeps s on s."user" = l.wallet
                where l.revoked_at is null and s.block_time >= ${since} and s.block_time >= l.linked_at
                    and not exists (select 1 from telegram_notifications n where n.chat_id = l.chat_id
                        and n.key = 'sweep:' || s.signature || ':' || s.event_index)`),
            this.rows<EventRow>(sql`
                select l.chat_id, l.locale, e.signature, e.event_index, e."user", e.kind, e.data, e.block_time
                from telegram_links l join user_events e on e."user" = l.wallet
                where l.revoked_at is null and e.block_time >= ${since} and e.block_time >= l.linked_at
                    and e.kind in ('paused', 'resumed', 'tier_changed', 'payment_tokens_changed', 'exited', 'reactivated')
                    and not exists (select 1 from telegram_notifications n where n.chat_id = l.chat_id
                        and n.key = 'event:' || e.signature || ':' || e.event_index)`),
            this.rows<AttemptRow>(sql`
                select l.chat_id, l.locale, a.id, a."user", a.payment_token, a.day, a.outcome, a.reason, a.at,
                    (select p.reason from sweep_attempts p where p."user" = a."user"
                        and p.payment_token = a.payment_token and p.day < a.day and p.outcome <> 'failed'
                        order by p.day desc, p.id desc limit 1) as previous_reason
                from telegram_links l join sweep_attempts a on a."user" = l.wallet
                where l.revoked_at is null and a.outcome in ('skipped', 'pull_failed')
                    and a.at >= ${since} and a.at >= l.linked_at
                    and not exists (select 1 from telegram_notifications n where n.chat_id = l.chat_id
                        and n.key = 'attempt:' || a.id)`),
        ]);
        const wallets = [...new Set([...sweeps, ...events, ...attempts].map(row => row.user))];
        if (wallets.length === 0) return;
        const [config, users] = await Promise.all([this.config(), this.users(wallets)]);
        const notices = [
            ...(
                await Promise.all(
                    sweeps.map(async row => this.purchase(row, await this.invested(row), config, users.get(row.user))),
                )
            ).flat(),
            ...events.map(row => this.control(row, config, users.get(row.user))),
            ...attempts.map(row => this.skipped(row, config, users.get(row.user))),
        ].sort((a, b) => a.at.getTime() - b.at.getTime());
        for (const notice of notices) {
            if (!(await this.deliver(notice))) return;
        }
    }

    private async rows<T>(query: ReturnType<typeof sql>): Promise<T[]> {
        return (await this.db.execute(query)).rows as T[];
    }

    /** What the user had invested up to and including the sweep in `row`, across both tokens. */
    private async invested(row: SweepRow): Promise<bigint> {
        const [total] = await this.rows<{ invested: string }>(sql`
            select sum(engine + pending) as invested from sweeps
            where "user" = ${row.user} and (slot, signature, event_index) <= (${row.slot}, ${row.signature}, ${row.event_index})`);
        return BigInt(total!.invested);
    }

    private async config(): Promise<Config> {
        return (await fetchConfig(this.rpc, (await findConfigPda())[0])).data;
    }

    private async users(wallets: Address[]): Promise<Map<Address, UserConfig>> {
        const pdas = await Promise.all(wallets.map(async user => (await findUserConfigPda({ user }))[0]));
        const accounts = await fetchAllMaybeUserConfig(this.rpc, pdas);
        return new Map(accounts.flatMap((account, i) => (account.exists ? [[wallets[i]!, account.data]] : [])));
    }

    /** A purchase, and the highest goal milestone it reached, if any. */
    private purchase(row: SweepRow, invested: bigint, config: Config, user: UserConfig | undefined): Notice[] {
        const at = new Date(row.block_time);
        const chatId = BigInt(row.chat_id);
        const key = `sweep:${row.signature}:${row.event_index}`;
        if (!user || user.status === UserStatus.Exited) return [{ at, chatId, key, text: null }];
        const t = botTranslator(row.locale);
        const [engine, pending] = [BigInt(row.engine), BigInt(row.pending)];
        const asset = config.assets[row.asset]!;
        const lines = [
            t('notices.purchase', {
                asset: symbolOf(asset.mint),
                shares: (Number(row.received) * row.multiplier) / 10 ** asset.decimals,
                token: symbolOf(config.paymentTokens[row.payment_token]!.mint),
                total: dollars(engine + pending),
            }),
        ];
        if (engine > 0n && pending > 0n) {
            lines.push(t('notices.parts', { engine: dollars(engine), pending: dollars(pending) }));
        }
        if (user.pending > 0n) {
            const now = BigInt(Math.floor(at.getTime() / 1_000));
            const cap = weeklyCap(user, config.userWeeklyCap, now);
            lines.push(
                spentAt(user, now) >= cap
                    ? t('notices.capReached', { cap: dollars(cap), waiting: dollars(user.pending) })
                    : t('notices.waiting', { waiting: dollars(user.pending) }),
            );
        }
        const notices: Notice[] = [{ at, chatId, key, text: lines.join(' ') }];
        const reached = GOAL_MILESTONES.filter(
            percent =>
                user.goalAmount > 0n &&
                invested - engine - pending < (user.goalAmount * BigInt(percent)) / 100n &&
                invested >= (user.goalAmount * BigInt(percent)) / 100n,
        ).at(-1);
        if (reached) {
            const label = goalLabel(user);
            const values = { goal: dollars(user.goalAmount), invested: dollars(invested), percent: reached };
            notices.push({
                at,
                chatId,
                key: `goal:${row.user}:${user.goalAmount}:${reached}`,
                text: label ? t('notices.goal', { ...values, label }) : t('notices.goalUnnamed', values),
            });
        }
        return notices;
    }

    /** A confirmation of one of the user's own controls; while exited, only the exit's. */
    private control(row: EventRow, config: Config, user: UserConfig | undefined): Notice {
        const notice = {
            at: new Date(row.block_time),
            chatId: BigInt(row.chat_id),
            key: `event:${row.signature}:${row.event_index}`,
        };
        if (!user || (user.status === UserStatus.Exited && row.kind !== 'exited')) return { ...notice, text: null };
        const t = botTranslator(row.locale);
        switch (row.kind) {
            case 'tier_changed':
                return {
                    ...notice,
                    text: t('notices.tierChanged', {
                        cap: dollars(TIERS[(row.data as { tier: number }).tier as 0 | 1]),
                    }),
                };
            case 'payment_tokens_changed': {
                const enabled = (row.data as { paymentTokens: number }).paymentTokens;
                const tokens = new Intl.ListFormat(row.locale, { type: 'conjunction' }).format(
                    config.paymentTokens.filter((_, i) => enabled & (1 << i)).map(({ mint }) => symbolOf(mint)),
                );
                return { ...notice, text: t('notices.tokensChanged', { tokens }) };
            }
            case 'paused':
                return { ...notice, text: t('notices.paused') };
            case 'resumed':
                return { ...notice, text: t('notices.resumed') };
            case 'exited':
                return { ...notice, text: t('notices.exited') };
            case 'reactivated':
                return { ...notice, text: t('notices.reactivated') };
        }
    }

    /**
     * A day a token was not bought, by the crank's final word: none while the user is paused or exited, and a token
     * ended outside Laterite once, not every day until it is restored.
     */
    private skipped(row: AttemptRow, config: Config, user: UserConfig | undefined): Notice {
        const notice = { at: new Date(row.at), chatId: BigInt(row.chat_id), key: `attempt:${row.id}` };
        const restore = row.reason?.startsWith('RestoreRequired') ?? false;
        if (
            !user ||
            user.status !== UserStatus.Active ||
            (restore && row.previous_reason?.startsWith('RestoreRequired'))
        ) {
            return { ...notice, text: null };
        }
        const text = botTranslator(row.locale)('notices.skipped', {
            day: new Date(row.day * 86_400_000),
            reason: restore ? 'restore' : row.outcome === 'pull_failed' ? 'pull' : 'other',
            token: symbolOf(config.paymentTokens[row.payment_token]!.mint),
        });
        return { ...notice, text };
    }

    /** Records `notice` as handled, then sends it; false when the tick should stop (Telegram is refusing sends). */
    private async deliver({ at, chatId, key, text }: Notice): Promise<boolean> {
        const [claimed] = await this.db
            .insert(telegramNotifications)
            .values({ chatId, key, sent: text !== null })
            .onConflictDoNothing()
            .returning({ key: telegramNotifications.key });
        if (!claimed || text === null) return true;
        try {
            await this.api('sendMessage', {
                chat_id: Number(chatId),
                link_preview_options: { is_disabled: true },
                text,
            });
            this.log.info({ key, latencyMs: Date.now() - at.getTime() }, 'telegram notification sent');
            return true;
        } catch (error) {
            // Blocked by the user, or the chat is gone: the link ends, as `/unlink` would.
            if (error instanceof TelegramError && error.errorCode === 403) {
                await this.db
                    .update(telegramLinks)
                    .set({ revokedAt: new Date() })
                    .where(and(eq(telegramLinks.chatId, chatId), isNull(telegramLinks.revokedAt)));
                this.log.info({ chatId: String(chatId), reason: error.description }, 'telegram chat unlinked');
                return true;
            }
            await this.db
                .delete(telegramNotifications)
                .where(and(eq(telegramNotifications.chatId, chatId), eq(telegramNotifications.key, key)));
            if (error instanceof TelegramError && error.retryAfterSeconds) {
                this.resumeAt = Date.now() + error.retryAfterSeconds * 1_000;
            }
            this.log.warn({ err: error, key }, 'telegram notification not sent');
            return false;
        }
    }
}

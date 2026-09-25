/** A refusal of the Telegram Bot API: its error code, description and, under flood control, the wait it asks for. */
export class TelegramError extends Error {
    constructor(
        readonly errorCode: number,
        readonly description: string,
        readonly retryAfterSeconds?: number,
    ) {
        super(`Telegram answered ${errorCode}: ${description}`);
        this.name = 'TelegramError';
    }
}

/** Calls one Bot API method with JSON parameters and returns its result. */
export type BotApi = <T>(method: string, parameters: Record<string, unknown>, signal?: AbortSignal) => Promise<T>;

/** The part of an incoming message the bot reads. */
export type Message = {
    chat: { id: number; type: string };
    from?: { language_code?: string };
    text?: string;
};

export type Update = { message?: Message; update_id: number };

/**
 * A Telegram Bot API client for `botToken`. The request URL holds the token, so errors carry only Telegram's code and
 * description, never the URL.
 */
export function createBotApi(
    botToken: string,
    {
        api = 'https://api.telegram.org',
        fetch = globalThis.fetch,
        timeoutMs = 10_000,
    }: { api?: string; fetch?: typeof globalThis.fetch; timeoutMs?: number } = {},
): BotApi {
    return async <T>(method: string, parameters: Record<string, unknown>, signal?: AbortSignal) => {
        const timeout = AbortSignal.timeout(timeoutMs + ((parameters.timeout as number | undefined) ?? 0) * 1_000);
        const response = await fetch(`${api}/bot${botToken}/${method}`, {
            body: JSON.stringify(parameters),
            headers: { 'Content-Type': 'application/json' },
            method: 'POST',
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        const body = (await response.json().catch(() => null)) as {
            description?: string;
            error_code?: number;
            ok?: boolean;
            parameters?: { retry_after?: number };
            result?: T;
        } | null;
        if (!response.ok || !body?.ok) {
            throw new TelegramError(
                body?.error_code ?? response.status,
                body?.description ?? response.statusText,
                body?.parameters?.retry_after,
            );
        }
        return body.result as T;
    };
}

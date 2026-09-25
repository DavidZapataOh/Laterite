import { pino, type DestinationStream, type Logger } from 'pino';

export type { Logger };

/**
 * A JSON logger in Railway's structured format: one line per entry with `message` and a lowercase `level`, which its
 * log explorer indexes and filters (`@level:error`). Secrets are censored wherever a key names one.
 */
export function createLogger(level: string, destination?: DestinationStream): Logger {
    return pino(
        {
            base: undefined,
            formatters: { level: label => ({ level: label }) },
            level,
            messageKey: 'message',
            redact: {
                censor: '[secret]',
                paths: [
                    'accessToken',
                    'apiKey',
                    'authorization',
                    'botToken',
                    '*.accessToken',
                    '*.apiKey',
                    '*.authorization',
                    '*.botToken',
                ],
            },
            timestamp: pino.stdTimeFunctions.isoTime,
        },
        destination,
    );
}

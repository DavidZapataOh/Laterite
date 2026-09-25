import { signatureProblem } from './signed';

/** The declaration's current version; a new text takes a new version, and every wallet declares again. */
export const DECLARATION_VERSION = '1';

/** What a wallet declares, one statement a line. */
export const DECLARATION_STATEMENTS = ['us', 'residence', 'sanctions'] as const;

type Key = 'heading' | 'request' | 'wallet' | 'version' | 'issuedAt' | (typeof DECLARATION_STATEMENTS)[number];

/** The `declaration` messages of one locale, as next-intl's translators on the client and the server give them. */
export type DeclarationTranslator = (key: Key, values?: Record<string, string>) => string;

export type Declaration = { domain: string; wallet: string; issuedAt: string };

/** The exact text a wallet signs: the same on the client that asks for the signature and the server that checks it. */
export function declarationMessage(t: DeclarationTranslator, { domain, wallet, issuedAt }: Declaration): string {
    return [
        t('heading'),
        t('request', { domain }),
        ...DECLARATION_STATEMENTS.map(statement => `- ${t(statement)}`),
        t('wallet', { wallet }),
        t('version', { version: DECLARATION_VERSION }),
        t('issuedAt', { issuedAt }),
    ].join('\n');
}

/**
 * Why a declaration cannot be recorded, or null when `signature` (base58) is `wallet`'s signature of the declaration
 * issued at `issuedAt` for `domain` within `SIGNATURE_MAX_AGE_MS` of `now`.
 */
export function declarationProblem(
    t: DeclarationTranslator,
    declaration: Declaration & { signature: string },
    now = Date.now(),
): Promise<string | null> {
    return signatureProblem(declaration, declarationMessage(t, declaration), now);
}

import {
    type Address,
    getBase58Encoder,
    getPublicKeyFromAddress,
    isAddress,
    type SignatureBytes,
    verifySignature,
} from '@solana/kit';

/** The declaration's current version; a new text takes a new version, and every wallet declares again. */
export const DECLARATION_VERSION = '1';

/** How far a declaration's issue time may be from the server's clock, so a signature is not replayed later. */
export const DECLARATION_MAX_AGE_MS = 10 * 60 * 1000;

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
 * issued at `issuedAt` for `domain` within {@link DECLARATION_MAX_AGE_MS} of `now`.
 */
export async function declarationProblem(
    t: DeclarationTranslator,
    declaration: Declaration & { signature: string },
    now = Date.now(),
): Promise<string | null> {
    const { wallet, issuedAt, signature } = declaration;
    if (!isAddress(wallet)) return 'wallet is not an address';
    const issued = Date.parse(issuedAt);
    if (Number.isNaN(issued) || new Date(issued).toISOString() !== issuedAt) return 'issuedAt is not an ISO time';
    if (Math.abs(now - issued) > DECLARATION_MAX_AGE_MS) return 'issuedAt is too far from now';
    let bytes: Uint8Array;
    try {
        bytes = new Uint8Array(getBase58Encoder().encode(signature));
    } catch {
        return 'signature is not base58';
    }
    if (bytes.length !== 64) return 'signature is not 64 bytes';
    const key = await getPublicKeyFromAddress(wallet as Address);
    const message = new TextEncoder().encode(declarationMessage(t, declaration));
    return (await verifySignature(key, bytes as SignatureBytes, message)) ? null : 'signature does not match';
}

import {
    type Address,
    getBase58Encoder,
    getPublicKeyFromAddress,
    isAddress,
    type SignatureBytes,
    verifySignature,
} from '@solana/kit';

/** How far a signed message's issue time may be from the server's clock, so a signature is not replayed later. */
export const SIGNATURE_MAX_AGE_MS = 10 * 60 * 1000;

/** A text a wallet signed with `signMessage`: who, when, and the signature in base58. */
export type SignedText = { wallet: string; issuedAt: string; signature: string };

/**
 * Why `signature` is not `wallet`'s signature of `message`, issued at `issuedAt` within {@link SIGNATURE_MAX_AGE_MS}
 * of `now`, or null when it is.
 */
export async function signatureProblem(
    { wallet, issuedAt, signature }: SignedText,
    message: string,
    now = Date.now(),
): Promise<string | null> {
    if (!isAddress(wallet)) return 'wallet is not an address';
    const issued = Date.parse(issuedAt);
    if (Number.isNaN(issued) || new Date(issued).toISOString() !== issuedAt) return 'issuedAt is not an ISO time';
    if (Math.abs(now - issued) > SIGNATURE_MAX_AGE_MS) return 'issuedAt is too far from now';
    let bytes: Uint8Array;
    try {
        bytes = new Uint8Array(getBase58Encoder().encode(signature));
    } catch {
        return 'signature is not base58';
    }
    if (bytes.length !== 64) return 'signature is not 64 bytes';
    const key = await getPublicKeyFromAddress(wallet as Address);
    return (await verifySignature(key, bytes as SignatureBytes, new TextEncoder().encode(message)))
        ? null
        : 'signature does not match';
}

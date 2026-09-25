import {
    ATTESTATION_TTL_SECONDS,
    type AttestationArgs,
    change,
    type Config,
    EventKind,
    incomeShare,
    isLateriteError,
    LATERITE_ERROR__ATTESTATION_EXPIRED,
    LATERITE_ERROR__INVALID_ATTESTATION,
    LATERITE_ERROR__INVALID_ATTESTATION_SIGNATURE,
    LATERITE_ERROR__NOTHING_TO_INVEST,
    LATERITE_ERROR__UNKNOWN_PAYMENT_TOKEN,
    LATERITE_ERROR__USER_NOT_ACTIVE,
    LATERITE_PROGRAM_ADDRESS,
    type LateriteError,
    type UserConfig,
    UserStatus,
} from '@laterite/client';
import {
    type Address,
    getBase58Decoder,
    isSolanaError,
    SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM,
    type SolanaError,
} from '@solana/kit';

/**
 * Why the attestor must not sign on this deployment, or `null`: `Config.attestor` must be its key and
 * `Config.genesisHash` the genesis hash of the cluster its RPC serves, so a watcher pointed at another cluster or
 * deployment, or holding a rotated key, signs nothing.
 */
export function deploymentMismatch(config: Config, genesisHash: string, attestor: Address): string | null {
    if (config.attestor !== attestor) {
        return `Config.attestor is ${config.attestor}, not this service's key ${attestor}: set ATTESTOR_KEYPAIR to the key update_config named`;
    }
    const configured = getBase58Decoder().decode(config.genesisHash);
    if (configured !== genesisHash) {
        return `the RPC serves the cluster ${genesisHash}, not the one Laterite's config names (${configured})`;
    }
    return null;
}

/**
 * The error `attest` would fail with for `attestation` at `now`, in the program's order, or `null` when it would add
 * to `pending`: only an active user, a transfer from `attestableFrom` on and at most 7 days old, in a token the user
 * enabled, that their rules turn into a positive amount.
 */
export function attestRefusal(user: UserConfig, attestation: AttestationArgs, now: bigint): LateriteError | null {
    const eventTime = BigInt(attestation.eventTime);
    const amount = BigInt(attestation.amount);
    if (user.status !== UserStatus.Active) return LATERITE_ERROR__USER_NOT_ACTIVE;
    if (amount === 0n || eventTime < user.attestableFrom || eventTime > now) return LATERITE_ERROR__INVALID_ATTESTATION;
    if (eventTime + ATTESTATION_TTL_SECONDS < now) return LATERITE_ERROR__ATTESTATION_EXPIRED;
    if ((user.paymentTokens & (1 << attestation.paymentToken)) === 0) return LATERITE_ERROR__UNKNOWN_PAYMENT_TOKEN;
    const invested = attestation.kind === EventKind.Income ? incomeShare(user, amount) : change(user, amount);
    return invested === 0n ? LATERITE_ERROR__NOTHING_TO_INVEST : null;
}

/** The refusals that stay refusals (the transfer can never count), by the program's names for them. */
export const FINAL = new Map<LateriteError, string>([
    [LATERITE_ERROR__ATTESTATION_EXPIRED, 'AttestationExpired'],
    [LATERITE_ERROR__INVALID_ATTESTATION, 'InvalidAttestation'],
    [LATERITE_ERROR__NOTHING_TO_INVEST, 'NothingToInvest'],
    [LATERITE_ERROR__UNKNOWN_PAYMENT_TOKEN, 'UnknownPaymentToken'],
    [LATERITE_ERROR__USER_NOT_ACTIVE, 'UserNotActive'],
]);

/** What a failed `attest` transaction means for its transfer. */
export type AttestFailure =
    /** Its record exists: someone landed it first. */
    | { kind: 'counted' }
    /** The program refuses it for good. */
    | { kind: 'refused'; reason: LateriteError }
    /** The program does not accept the attestor's signature: a key or deployment mismatch. */
    | { kind: 'signature' };

/**
 * Reads the custom error of a failed simulation, preflight or execution of `message`: `null` for any other failure,
 * which is worth retrying.
 */
export function attestFailure(
    error: unknown,
    message: { instructions: Record<number, { programAddress: Address }> },
): AttestFailure | null {
    let failure: unknown = error;
    while (failure && !isSolanaError(failure, SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM)) {
        failure = (failure as { cause?: unknown }).cause;
    }
    if (!failure) return null;
    if (isLateriteError(failure, message, LATERITE_ERROR__INVALID_ATTESTATION_SIGNATURE)) return { kind: 'signature' };
    const reason = [...FINAL.keys()].find(code => isLateriteError(failure, message, code));
    if (reason !== undefined) return { kind: 'refused', reason };
    // The system program's `AccountAlreadyInUse` (0), raised inside `attest` when the record exists.
    const { code, index } = (failure as SolanaError<typeof SOLANA_ERROR__INSTRUCTION_ERROR__CUSTOM>).context;
    return code === 0 && message.instructions[index]?.programAddress === LATERITE_PROGRAM_ADDRESS
        ? { kind: 'counted' }
        : null;
}

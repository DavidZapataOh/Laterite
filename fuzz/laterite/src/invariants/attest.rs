use crucible_fuzzer::*;
use laterite::{EventKind, UserStatus, ATTESTATION_TTL_SECONDS};

use crate::fixture::{Fixture, Last};

/// Attestations: only the attestor's exact signature over this deployment's message, immediately before, adds to
/// `pending`, and it always does when the transfer is due; each transfer counts once, only for an active user, only
/// from `attestable_from` on (which never decreases) and inside its 7 days, and only in an enabled token; records close
/// only after expiry, only to their payer.
pub fn check(f: &mut Fixture) {
    let (before, after) = (&f.before, &f.after);
    for (u, (b, a)) in before.users.iter().zip(&after.users).enumerate() {
        fuzz_assert!(a.attestable_from >= b.attestable_from, "attestable_from decreased");
        let attested = matches!(f.last, Last::Attest { user, mutated: false, ok: true, .. } if user == u);
        fuzz_assert!(a.pending <= b.pending || attested, "pending grew outside a valid attestation");
    }

    match f.last.clone() {
        Last::Attest { user, attestation, mutated, ok } => {
            fuzz_assert!(!(mutated && ok), "a mutated or foreign-deployment signature was accepted");
            let (b, a) = (&before.users[user], &after.users[user]);
            let transfer = (user, attestation.signature, attestation.transfer_index);
            if !ok {
                fuzz_assert!(before.user_data[user] == after.user_data[user], "a failed attestation wrote UserConfig");
                let invested = match attestation.kind {
                    EventKind::Income => b.income_share(attestation.amount),
                    EventKind::Payment => b.change(attestation.amount),
                };
                let event = attestation.event_time;
                let due = b.status == UserStatus::Active
                    && attestation.amount > 0
                    && (b.attestable_from..=after.now).contains(&event)
                    && after.now <= event + ATTESTATION_TTL_SECONDS
                    && b.payment_tokens & (1 << attestation.payment_token) != 0
                    && invested > 0
                    && !f.counted.contains(&transfer);
                fuzz_assert!(mutated || !due, "a valid attestation of a due transfer was refused");
                return;
            }
            fuzz_assert!(f.counted.insert(transfer), "a transfer counted twice");
            let event = attestation.event_time;
            fuzz_assert!(b.status == UserStatus::Active, "a paused or exited user was credited");
            fuzz_assert!(event >= b.attestable_from, "a transfer from before attestable_from counted");
            fuzz_assert!(
                event <= after.now && after.now <= event + ATTESTATION_TTL_SECONDS,
                "a transfer counted outside its window"
            );
            fuzz_assert!(
                b.payment_tokens & (1 << attestation.payment_token) != 0,
                "a transfer in a disabled token counted"
            );
            let invested = match attestation.kind {
                EventKind::Income => b.income_share(attestation.amount),
                EventKind::Payment => b.change(attestation.amount),
            };
            fuzz_assert!(
                invested > 0 && a.pending == b.pending.saturating_add(invested),
                "pending grew by other than the rule's amount"
            );
        }
        Last::CloseAttestation { expires_at, to_payer, gain, rent, ok: true } => {
            fuzz_assert!(to_payer, "a record closed to someone other than its payer");
            fuzz_assert!(
                expires_at.is_some_and(|expires_at| after.now > expires_at),
                "a record closed before it expired"
            );
            fuzz_assert!(gain == rent, "the payer did not get the record's rent back");
        }
        _ => {}
    }
}

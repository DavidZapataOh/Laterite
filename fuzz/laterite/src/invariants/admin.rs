use crucible_fuzzer::*;
use laterite::TIERS;
use solana_pubkey::Pubkey;

use crate::fixture::{Admin, Fixture, Last};

/// The admin surface: the router, the tables and the genesis hash never change after `initialize`; the settings, the
/// kill switch, the calendar and the handover change only by the admin (or the proposed admin accepting); a second
/// enrollment never lands; reactivation and tier changes respect the kill switch and the beta caps.
pub fn check(f: &mut Fixture) {
    let (before, after) = (&f.before, &f.after);
    let (b, a) = (&before.config, &after.config);
    let fixed = (a.router, a.assets, a.payment_tokens, a.genesis_hash);
    fuzz_assert!(
        fixed == (f.params.router, f.params.assets, f.params.payment_tokens, f.params.genesis_hash),
        "the router, the tables or the genesis hash changed after initialize"
    );

    let settings = |c: &laterite::Config| {
        (c.attestor, c.sponsor, c.user_weekly_cap, c.max_users, c.paused, c.admin, c.pending_admin, c.market_calendar)
    };
    match f.last.clone() {
        Last::Admin { signer, admin, ok } => {
            if !ok {
                fuzz_assert!(before.config_data == after.config_data, "a failed admin call changed the config");
                return;
            }
            match admin {
                Admin::Accept => {
                    fuzz_assert!(
                        signer == b.pending_admin && signer != Pubkey::default(),
                        "someone other than the proposed admin took over"
                    );
                    fuzz_assert!(
                        a.admin == signer && a.pending_admin == Pubkey::default(),
                        "the handover did not complete"
                    );
                }
                _ => {
                    fuzz_assert!(signer == b.admin, "someone other than the admin changed the config");
                    fuzz_assert!(a.admin == b.admin, "the admin changed outside the handover");
                }
            }
            if admin == Admin::UpdateConfig {
                let valid = a.attestor != Pubkey::default() && a.sponsor != Pubkey::default();
                fuzz_assert!(
                    valid && a.user_weekly_cap > 0 && a.max_users > 0,
                    "update_config accepted an unset key or a zero cap"
                );
            }
            fuzz_assert!(
                a.market_calendar == b.market_calendar || admin == Admin::SetCalendar,
                "the calendar changed outside set_market_calendar"
            );
        }
        last => {
            fuzz_assert!(settings(a) == settings(b), "the config changed outside an admin call");
            match last {
                Last::Enroll { ok } => fuzz_assert!(!ok, "a user enrolled twice"),
                Last::Reactivate { user, ok: true, .. } => {
                    fuzz_assert!(!b.paused, "a reactivation under the kill switch");
                    fuzz_assert!(b.user_count < b.max_users, "a reactivation beyond max_users");
                    let tier = usize::from(after.users[user].tier);
                    fuzz_assert!(TIERS[tier] <= b.user_weekly_cap, "a reactivation in a tier above the beta cap");
                }
                Last::TierChange { user, ok: true } => {
                    let tier = usize::from(after.users[user].tier);
                    fuzz_assert!(TIERS[tier] <= b.user_weekly_cap, "a tier change above the beta cap");
                }
                _ => {}
            }
        }
    }
}

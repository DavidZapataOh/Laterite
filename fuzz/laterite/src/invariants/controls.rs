use crucible_fuzzer::*;
use laterite::{EnrollParams, UserConfig, UserStatus};

use crate::fixture::{Control, Fixture, Last, State};
use crate::helpers::{enabled, pullable};

/// The user's controls: one seat per user who has not exited; a status moves only along pause, resume, exit and
/// reactivation; each control touches only its signer's accounts, never raises `pending` or moves `enrolled_at`;
/// the tier and the tokens change only through their instructions, which leave no pullable subscription to a plan
/// they drop; exit always works, keeps the counters and frees one seat; reactivation needs the configured sponsor's
/// signature, keeps the counters and credits only transfers from then on.
pub fn check(f: &mut Fixture) {
    let (before, after) = (&f.before, &f.after);
    let seated = after.users.iter().filter(|user| user.status != UserStatus::Exited).count() as u32;
    fuzz_assert!(after.config.user_count == seated, "user_count differs from the users who have not exited");

    let last = f.last.clone();
    for (u, (b, a)) in before.users.iter().zip(&after.users).enumerate() {
        let attested = matches!(last, Last::Attest { user, ok: true, .. } if user == u);
        fuzz_assert!(a.pending <= b.pending || attested, "pending raised by something other than an attestation");
        fuzz_assert!((a.user, a.enrolled_at) == (b.user, b.enrolled_at), "the user or enrolled_at changed");
        let moved = match last {
            Last::Control { target, control: Control::Pause(_), ok: true, .. } => target == u,
            Last::Exit { user, ok: true } | Last::Reactivate { user, ok: true, .. } => user == u,
            _ => false,
        };
        fuzz_assert!(a.status == b.status || moved, "the status changed outside pause, resume, exit or reactivation");
        let tier = matches!(last, Last::TierChange { user, ok: true } | Last::Reactivate { user, ok: true, .. } if user == u)
            || matches!(last, Last::Exit { user, ok: true } if user == u);
        fuzz_assert!(a.tier == b.tier || tier, "the tier changed outside its instructions");
        let tokens = matches!(last, Last::TokensChange { user, ok: true } | Last::Reactivate { user, ok: true, .. } if user == u)
            || matches!(last, Last::Exit { user, ok: true } if user == u);
        fuzz_assert!(a.payment_tokens == b.payment_tokens || tokens, "the tokens changed outside their instructions");
    }

    match last {
        Last::Control { signer, target, control, ok } => {
            only_own_accounts(before, after, signer);
            fuzz_assert!(!ok || signer == target, "a control succeeded on another user's settings");
            if signer != target {
                return;
            }
            let (b, a) = (&before.users[signer], &after.users[signer]);
            fuzz_assert!(!ok || b.status != UserStatus::Exited, "a control changed an exited user");
            match control {
                Control::Pause(true) => {
                    fuzz_assert!(
                        ok == (b.status == UserStatus::Active),
                        "pause refused an active user or took another"
                    );
                    fuzz_assert!(!ok || a.status == UserStatus::Paused, "pause did not pause");
                }
                Control::Pause(false) => {
                    fuzz_assert!(
                        ok == (b.status == UserStatus::Paused),
                        "resume refused a paused user or took another"
                    );
                    fuzz_assert!(!ok || resumed_at(b, a, after.now), "resume did not credit only later transfers");
                }
                Control::LowerPending(pending) => {
                    let allowed = pending <= b.pending && b.status != UserStatus::Exited;
                    fuzz_assert!(ok == allowed, "lower_pending refused a lower value or took a higher one");
                    fuzz_assert!(!ok || a.pending == pending, "lower_pending set another value");
                }
                Control::UpdateSettings { counts_more } if ok => {
                    let expected = if counts_more { b.attestable_from.max(after.now) } else { b.attestable_from };
                    fuzz_assert!(a.attestable_from == expected, "a settings change backfilled or moved the window");
                }
                Control::UpdateSettings { .. } => {}
            }
        }
        Last::TierChange { user, ok } => {
            only_own_accounts(before, after, user);
            let (b, a) = (&before.users[user], &after.users[user]);
            if ok {
                dropped(after, user, b.tier, b.payment_tokens);
                fuzz_assert!(a.attestable_from == b.attestable_from, "a tier change moved attestable_from");
            }
        }
        Last::TokensChange { user, ok } => {
            only_own_accounts(before, after, user);
            let (b, a) = (&before.users[user], &after.users[user]);
            if ok {
                dropped(after, user, b.tier, b.payment_tokens & !a.payment_tokens);
                let added = a.payment_tokens & !b.payment_tokens != 0;
                let expected = if added { b.attestable_from.max(after.now) } else { b.attestable_from };
                fuzz_assert!(a.attestable_from == expected, "an added token backfilled or the window moved");
            }
        }
        Last::Exit { user, ok } => {
            only_own_accounts(before, after, user);
            let (b, a) = (&before.users[user], &after.users[user]);
            fuzz_assert!(ok == (b.status != UserStatus::Exited), "exit failed for a user who had not exited");
            if !ok {
                return;
            }
            fuzz_assert!(a.status == UserStatus::Exited && a.pending == 0, "exit left the user active or pending");
            fuzz_assert!(settings(a) == EnrollParams::default(), "exit kept the settings");
            fuzz_assert!(counters(a) == counters(b), "exit changed the counters");
            fuzz_assert!(a.attestable_from == b.attestable_from, "exit moved attestable_from");
            fuzz_assert!(
                before.config.user_count >= 1 && after.config.user_count + 1 == before.config.user_count,
                "exit did not free exactly one seat"
            );
            dropped(after, user, b.tier, b.payment_tokens);
        }
        Last::Reactivate { user, sponsored, ok } => {
            only_own_accounts(before, after, user);
            let (b, a) = (&before.users[user], &after.users[user]);
            fuzz_assert!(!ok || sponsored, "a reactivation landed without the configured sponsor's signature");
            if !ok {
                fuzz_assert!(before.user_data[user] == after.user_data[user], "a failed reactivation wrote UserConfig");
                return;
            }
            fuzz_assert!(b.status == UserStatus::Exited, "a user who had not exited was reactivated");
            fuzz_assert!(counters(a) == counters(b), "reactivation changed the counters");
            fuzz_assert!(resumed_at(b, a, after.now), "reactivation did not credit only later transfers");
            fuzz_assert!(after.config.user_count == before.config.user_count + 1, "reactivation did not take a seat");
        }
        Last::Subscriptions { user } => only_own_accounts(before, after, user),
        _ => {}
    }
}

/// `a` is `b` returned to `Active` at `now`, crediting only transfers from then on.
fn resumed_at(b: &UserConfig, a: &UserConfig, now: i64) -> bool {
    a.status == UserStatus::Active && a.attestable_from == b.attestable_from.max(now)
}

/// No subscription `user` had to `tier`'s plan, for each token in `tokens`, can still be pulled.
fn dropped(after: &State, user: usize, tier: u8, tokens: u8) {
    for token in enabled(tokens) {
        let subscription = after.subscriptions[user][token][usize::from(tier) % 2].as_deref();
        fuzz_assert!(!pullable(subscription, after.now), "a dropped plan's subscription can still be pulled");
    }
}

fn settings(user: &UserConfig) -> EnrollParams {
    EnrollParams {
        tier: user.tier,
        payment_tokens: user.payment_tokens,
        asset: user.asset,
        engine: user.engine,
        engine_amount: user.engine_amount,
        income_rule: user.income_rule,
        change_multiplier: user.change_multiplier,
        cushions: user.cushions,
        goal_amount: user.goal_amount,
        goal_label: user.goal_label,
    }
}

/// What outlives an exit and a return: the trial's start, the week's spending, the engine's and the sweeps' days.
fn counters(user: &UserConfig) -> (i64, u32, u64, i64, [u32; 2]) {
    (user.enrolled_at, user.week, user.week_spent, user.engine_ran_at, user.last_sweep_day)
}

fn only_own_accounts(before: &State, after: &State, signer: usize) {
    for u in (0..before.users.len()).filter(|&u| u != signer) {
        let unchanged = before.user_data[u] == after.user_data[u] && before.subscriptions[u] == after.subscriptions[u];
        fuzz_assert!(unchanged, "a user's action changed another user's accounts");
    }
}

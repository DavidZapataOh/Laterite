use crucible_fuzzer::*;
use laterite::{Engine, UserStatus, DAY_SECONDS};

use crate::constants::AMOUNT_EXCEEDS_PERIOD_LIMIT;
use crate::fixture::{Fixture, Last};

/// The sweep: the swap authority's accounts and the plans never change, and no route takes anything from another
/// subscriber; a sweep pulls exactly what the amount engine gives within the subscription's period, keeps the cushion,
/// the combined weekly cap and one sweep a day, buys at least the minimum both verified updates allow, and runs only
/// for an active user, a weekly user only in an NYSE session of the loaded calendar (fail closed, and judged by the
/// harness's own New York clock and calendar file, not the program's), and never under the kill switch.
pub fn check(f: &mut Fixture) {
    let (before, after) = (&f.before, &f.after);
    fuzz_assert!(before.swap == after.swap, "a swap-authority token account changed or appeared");
    fuzz_assert!(before.plans == after.plans, "a plan changed");

    let Last::Sweep { user, token, pull, native, minimum, honest_updates, code, ok } = f.last.clone() else {
        for (b, a) in before.users.iter().zip(&after.users) {
            let unchanged = (b.week, b.week_spent, b.engine_ran_at, b.last_sweep_day)
                == (a.week, a.week_spent, a.engine_ran_at, a.last_sweep_day);
            fuzz_assert!(unchanged, "sweep bookkeeping changed outside a sweep");
        }
        return;
    };
    for other in (0..before.users.len()).filter(|&other| other != user) {
        let unchanged = before.user_data[other] == after.user_data[other]
            && before.balances[other] == after.balances[other]
            && before.subscriptions[other] == after.subscriptions[other];
        fuzz_assert!(unchanged, "a sweep touched another user's accounts");
    }
    if !ok {
        fuzz_assert!(before.user_data[user] == after.user_data[user], "a failed sweep wrote UserConfig");
        fuzz_assert!(before.balances[user] == after.balances[user], "a failed sweep moved the user's tokens");
        fuzz_assert!(code != Some(AMOUNT_EXCEEDS_PERIOD_LIMIT), "a pull exceeded the subscription's period");
        return;
    }
    let (b, a) = (&before.users[user], &after.users[user]);
    fuzz_assert!(!before.config.paused, "a sweep under the kill switch");
    fuzz_assert!(b.status == UserStatus::Active, "a paused or exited user was swept");
    fuzz_assert!(b.payment_tokens & (1 << token) != 0, "a disabled token was swept");
    fuzz_assert!(
        b.engine != Engine::Weekly || f.calendar.open(after.now),
        "a weekly user was swept outside an NYSE session of the loaded calendar"
    );
    fuzz_assert!(honest_updates, "a sweep landed without both its updates, trusted and each at its own entry");

    let total = pull.total();
    let pulled = before.balances[user][token].checked_sub(after.balances[user][token]);
    fuzz_assert!(total > 0, "a zero pull succeeded");
    fuzz_assert!(pulled == Some(total), "the amount pulled is not the engine's, capped by the native remaining");
    fuzz_assert!(total <= native, "a pull exceeded the subscription's native remaining");
    let cushion = b.cushions[token].min(before.balances[user][token]);
    fuzz_assert!(after.balances[user][token] >= cushion, "a pull took the cushion");
    fuzz_assert!(a.pending == b.pending - pull.pending, "pending did not drop by the pending part of the pull");

    let asset = 2 + usize::from(b.asset) % 2;
    let received = after.balances[user][asset].saturating_sub(before.balances[user][asset]);
    fuzz_assert!(
        minimum.is_some_and(|minimum| minimum > 0 && received >= minimum),
        "the user received less than the minimum the verified prices allow"
    );

    let today = after.now.div_euclid(DAY_SECONDS) as u32;
    fuzz_assert!(b.last_sweep_day[token] < today && a.last_sweep_day[token] == today, "last_sweep_day not advanced");
    fuzz_assert!(f.sweep_days.insert((user, token, today)), "two sweeps of one token on one UTC day");

    let week = b.week_at(after.now);
    let spent = f.week_pulls.entry((user, week)).or_default();
    *spent += total;
    let cap = b.weekly_cap(before.config.user_weekly_cap, after.now);
    fuzz_assert!(*spent <= cap, "a week's pulls across both tokens exceeded the combined cap");
    fuzz_assert!(a.week == week && a.week_spent == *spent, "the week's spending differs from the pulls");
}

mod common;

use {
    common::*,
    laterite::{Engine, MarketCalendar, Pull, UserConfig, DAY_SECONDS, TIERS, TRIAL_CAP, WEEK_SECONDS},
    proptest::prelude::*,
};

/// Monday 2026-09-21, 14:13:20 UTC: 10:13 in New York, a regular session.
const MONDAY: i64 = 1_790_000_000;
const HOUR: i64 = 3_600;
const DOLLAR: u64 = 1_000_000;
const BETA_CAP: u64 = 25 * DOLLAR;
const RICH: u64 = 1_000 * DOLLAR;

fn user(tier: u8, engine: Engine, engine_amount: u64) -> UserConfig {
    UserConfig {
        user: Default::default(),
        payer: Default::default(),
        tier,
        payment_tokens: 0b11,
        asset: 0,
        engine,
        engine_amount,
        income_rule: true,
        change_multiplier: 1,
        cushions: [20 * DOLLAR; 2],
        enrolled_at: MONDAY,
        goal_amount: 0,
        goal_label: [0; 32],
        bump: 255,
        week: 0,
        week_spent: 0,
        engine_ran_at: 0,
        pending: 0,
    }
}

/// Past the trial: the user enrolled two weeks before `MONDAY`.
fn veteran(tier: u8, engine: Engine, engine_amount: u64) -> UserConfig {
    UserConfig { enrolled_at: MONDAY - 2 * WEEK_SECONDS, ..user(tier, engine, engine_amount) }
}

#[test]
fn income_rule_invests_a_tenth_of_incomes_from_50_dollars() {
    let mut config = user(0, Engine::Daily, 0);
    assert_eq!(config.income_share(49_999_999), 0);
    assert_eq!(config.income_share(50 * DOLLAR), 5 * DOLLAR);
    assert_eq!(config.income_share(1_234_560_000), 123_456_000);
    config.income_rule = false;
    assert_eq!(config.income_share(1_000 * DOLLAR), 0);
}

#[test]
fn change_rounds_up_with_a_50_cent_floor_times_the_multiplier() {
    let mut config = user(0, Engine::Daily, 0);
    assert_eq!(config.change(4_200_000), 800_000);
    assert_eq!(config.change(4_990_000), 500_000);
    assert_eq!(config.change(5 * DOLLAR), 500_000);
    assert_eq!(config.change(1), 999_999);
    config.change_multiplier = 3;
    assert_eq!(config.change(4_200_000), 2_400_000);
    config.change_multiplier = 0;
    assert_eq!(config.change(4_200_000), 0);
}

#[test]
fn the_first_week_is_capped_at_the_trial_cap() {
    let config = user(1, Engine::Daily, 0);
    assert_eq!(config.weekly_cap(BETA_CAP, MONDAY), TRIAL_CAP);
    assert_eq!(config.weekly_cap(BETA_CAP, MONDAY + WEEK_SECONDS - 1), TRIAL_CAP);
    assert_eq!(config.weekly_cap(BETA_CAP, MONDAY + WEEK_SECONDS), TIERS[1]);
}

#[test]
fn the_beta_cap_bounds_every_tier() {
    let config = veteran(1, Engine::Daily, 0);
    assert_eq!(config.weekly_cap(10 * DOLLAR, MONDAY), 10 * DOLLAR);
    assert_eq!(config.weekly_cap(BETA_CAP, MONDAY), TIERS[1]);
}

#[test]
fn the_week_rolls_over_at_the_enrollment_time() {
    let market = nyse_market_calendar();
    let mut config = veteran(0, Engine::Daily, 0);
    config.pending = 100 * DOLLAR;
    let week_end = config.enrolled_at + 3 * WEEK_SECONDS;

    config.record(config.pull(0, RICH, BETA_CAP, &market, week_end - 1), week_end - 1);
    assert_eq!(config.spent_at(week_end - 1), TIERS[0]);
    assert_eq!(config.pull(0, RICH, BETA_CAP, &market, week_end - 1).total(), 0);

    assert_eq!(config.spent_at(week_end), 0);
    assert_eq!(config.pull(0, RICH, BETA_CAP, &market, week_end).total(), TIERS[0]);
    config.record(config.pull(0, RICH, BETA_CAP, &market, week_end), week_end);
    assert_eq!((config.week, config.week_spent), (3, TIERS[0]));
}

#[test]
fn the_cap_is_shared_by_both_payment_tokens() {
    let market = nyse_market_calendar();
    let mut config = veteran(0, Engine::Daily, 0);
    config.pending = 7 * DOLLAR;
    config.record(config.pull(0, RICH, BETA_CAP, &market, MONDAY), MONDAY);
    config.pending += 7 * DOLLAR;

    let usdt = config.pull(1, RICH, BETA_CAP, &market, MONDAY + 60);
    assert_eq!(usdt, Pull { engine: 0, pending: 3 * DOLLAR });
    config.record(usdt, MONDAY + 60);
    assert_eq!(config.pull(0, RICH, BETA_CAP, &market, MONDAY + 120).total(), 0);
    assert_eq!(config.pull(1, RICH, BETA_CAP, &market, MONDAY + 120).total(), 0);
    assert_eq!(config.pending, 4 * DOLLAR);
}

#[test]
fn the_cushion_is_never_pulled() {
    let market = nyse_market_calendar();
    let mut config = veteran(0, Engine::Daily, 5 * DOLLAR);
    assert_eq!(config.pull(0, 20 * DOLLAR, BETA_CAP, &market, MONDAY).total(), 0);
    assert_eq!(config.pull(0, 20_300_000, BETA_CAP, &market, MONDAY).total(), 300_000);
    config.cushions[1] = 0;
    assert_eq!(config.pull(1, 2 * DOLLAR, BETA_CAP, &market, MONDAY).total(), 2 * DOLLAR);
}

#[test]
fn an_unknown_payment_token_pulls_nothing() {
    let config = veteran(0, Engine::Daily, DOLLAR);
    assert_eq!(config.pull(2, RICH, BETA_CAP, &nyse_market_calendar(), MONDAY), Pull::default());
}

#[test]
fn the_daily_engine_buys_once_per_utc_day_without_catching_up() {
    let market = nyse_market_calendar();
    let mut config = veteran(0, Engine::Daily, DOLLAR);
    assert_eq!(config.pull(0, RICH, BETA_CAP, &market, MONDAY), Pull { engine: DOLLAR, pending: 0 });
    config.record(config.pull(0, RICH, BETA_CAP, &market, MONDAY), MONDAY);

    let midnight = (MONDAY / DAY_SECONDS + 1) * DAY_SECONDS;
    assert_eq!(config.pull(1, RICH, BETA_CAP, &market, midnight - 1).total(), 0);
    assert_eq!(config.pull(1, RICH, BETA_CAP, &market, midnight).engine, DOLLAR);
    assert_eq!(config.pull(1, RICH, BETA_CAP, &market, midnight + 3 * DAY_SECONDS).engine, DOLLAR);
}

#[test]
fn the_weekly_engine_buys_once_per_week_in_market_hours() {
    let market = nyse_market_calendar();
    let mut config = veteran(0, Engine::Weekly, 3 * DOLLAR);
    let saturday = MONDAY + 5 * DAY_SECONDS;
    assert_eq!(config.pull(0, RICH, BETA_CAP, &market, saturday - WEEK_SECONDS).engine, 0);

    config.record(config.pull(0, RICH, BETA_CAP, &market, MONDAY), MONDAY);
    assert_eq!(config.engine_ran_at, MONDAY);
    assert_eq!(config.pull(0, RICH, BETA_CAP, &market, MONDAY + DAY_SECONDS).engine, 0);
    assert_eq!(config.pull(0, RICH, BETA_CAP, &market, MONDAY + WEEK_SECONDS).engine, 3 * DOLLAR);
    assert_eq!(config.pull(0, RICH, BETA_CAP, &market, saturday + WEEK_SECONDS).engine, 0);
}

#[test]
fn the_weekly_engine_skips_nyse_holidays_and_early_closed_hours() {
    let market = nyse_market_calendar();
    let config = veteran(0, Engine::Weekly, 3 * DOLLAR);
    let thanksgiving = i64::from(day((2026, 11, 26))) * DAY_SECONDS;
    let friday = thanksgiving + DAY_SECONDS;
    assert_eq!(config.pull(0, RICH, BETA_CAP, &market, thanksgiving + 15 * HOUR).engine, 0);
    // 13:30 in New York, after the early close.
    assert_eq!(config.pull(0, RICH, BETA_CAP, &market, friday + 18 * HOUR + 1_800).engine, 0);
    assert_eq!(config.pull(0, RICH, BETA_CAP, &market, friday + 15 * HOUR).engine, 3 * DOLLAR);

    let daily = veteran(0, Engine::Daily, DOLLAR);
    assert_eq!(daily.pull(0, RICH, BETA_CAP, &market, thanksgiving + 15 * HOUR).engine, DOLLAR);
}

#[test]
fn the_weekly_engine_waits_for_a_loaded_calendar() {
    let config = veteran(0, Engine::Weekly, 3 * DOLLAR);
    assert_eq!(config.pull(0, RICH, BETA_CAP, &MarketCalendar::default(), MONDAY).engine, 0);
    let daily = veteran(0, Engine::Daily, DOLLAR);
    assert_eq!(daily.pull(0, RICH, BETA_CAP, &MarketCalendar::default(), MONDAY).engine, DOLLAR);
}

#[test]
fn the_engine_goes_first_and_is_cut_to_the_room_left() {
    let market = nyse_market_calendar();
    let mut config = veteran(0, Engine::Daily, 4 * DOLLAR);
    config.pending = 9 * DOLLAR;
    config.week_spent = 7 * DOLLAR;
    config.week = config.week_at(MONDAY);
    let pull = config.pull(0, RICH, BETA_CAP, &market, MONDAY);
    assert_eq!(pull, Pull { engine: 3 * DOLLAR, pending: 0 });
    config.record(pull, MONDAY);
    assert_eq!((config.engine_ran_at, config.pending, config.week_spent), (MONDAY, 9 * DOLLAR, TIERS[0]));
}

#[test]
fn pending_amounts_carry_over_until_the_cap_lets_them_through() {
    let market = nyse_market_calendar();
    let mut config = veteran(0, Engine::Daily, 0);
    config.pending = config.income_share(250 * DOLLAR);
    for week in 0..3 {
        let now = MONDAY + week * WEEK_SECONDS;
        let pull = config.pull(0, RICH, BETA_CAP, &market, now);
        config.record(pull, now);
    }
    assert_eq!(config.pending, 0);
    assert_eq!(config.week_spent, 5 * DOLLAR);
}

fn any_user() -> impl Strategy<Value = UserConfig> {
    (0u8..2, any::<bool>(), 0..=TIERS[1], 0..=100 * DOLLAR, [0..=50 * DOLLAR, 0..=50 * DOLLAR], 0..3 * WEEK_SECONDS)
        .prop_map(|(tier, weekly, engine_amount, pending, cushions, age)| UserConfig {
            enrolled_at: MONDAY - age,
            pending,
            cushions,
            ..user(tier, if weekly { Engine::Weekly } else { Engine::Daily }, engine_amount)
        })
}

proptest! {
    #[test]
    fn a_pull_never_breaks_a_bound(
        config in any_user(),
        token in 0usize..2,
        balance in 0..=200 * DOLLAR,
        beta_cap in 1..=BETA_CAP,
        later in 0..4 * WEEK_SECONDS,
    ) {
        let now = MONDAY + later;
        let pull = config.pull(token, balance, beta_cap, &nyse_market_calendar(), now);
        prop_assert!(pull.total() <= config.weekly_cap(beta_cap, now) - config.spent_at(now));
        prop_assert!(pull.total() <= balance.saturating_sub(config.cushions[token]));
        prop_assert!(pull.engine <= config.engine_amount && pull.pending <= config.pending);
    }

    #[test]
    fn sweeps_never_exceed_the_weekly_cap_across_both_tokens(
        mut config in any_user(),
        sweeps in prop::collection::vec((0usize..2, 0..=200 * DOLLAR, 0..DAY_SECONDS, 0..=10 * DOLLAR), 1..60),
    ) {
        let market = nyse_market_calendar();
        let mut now = MONDAY;
        let mut spent = std::collections::BTreeMap::<u32, u64>::new();
        for (token, balance, step, income) in sweeps {
            now += step;
            config.pending += config.income_share(income * 10);
            let pull = config.pull(token, balance, BETA_CAP, &market, now);
            config.record(pull, now);
            *spent.entry(config.week_at(now)).or_default() += pull.total();
            prop_assert!(spent[&config.week_at(now)] <= config.weekly_cap(BETA_CAP, now));
        }
    }
}

//! Conformance vectors for off-chain mirrors of the program: the amount engine, the NYSE session, Pyth Pro quotes,
//! the minimum output, the attestation message and the ed25519 instructions, computed here by the program's own code.
//! `UPDATE_VECTORS=1` rewrites `tests/vectors`; otherwise the committed files must equal what the program computes.

mod common;

use {
    anchor_lang::{
        prelude::{AccountInfo, Pubkey},
        AccountSerialize, AnchorSerialize,
    },
    common::*,
    laterite::{
        min_out, quote, subscription, us_market_open, Attestation, Engine, EventKind, MarketCalendar, Pull, Quote,
        UserConfig, UserStatus, CALENDAR_DAYS, CHANGE_MIN, CHANGE_STEP, DAY_SECONDS, INCOME_MIN, INCOME_SHARE_BPS,
        MAX_CONFIDENCE_BPS, MAX_PRICE_AGE_SECONDS, PLAN_PERIOD_HOURS, SLIPPAGE_BPS, TIERS, TRIAL_CAP, TRIAL_SECONDS,
        USD_DECIMALS, WEEK_SECONDS,
    },
    serde_json::{json, Value},
    solana_keypair::Keypair,
    solana_signer::Signer,
    subscriptions::{
        types::{Header, PlanTerms},
        SubscriptionDelegation, SUBSCRIPTIONS_ID,
    },
};

const HOUR: i64 = 3_600;
const DOLLAR: u64 = 1_000_000;
const CASES: usize = 256;

/// SplitMix64: the same sequence on every run.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn below(&mut self, bound: u64) -> u64 {
        self.next() % bound
    }

    fn between(&mut self, low: i64, high: i64) -> i64 {
        low + self.below((high - low + 1) as u64) as i64
    }

    fn pick<T: Copy>(&mut self, items: &[T]) -> T {
        items[self.below(items.len() as u64) as usize]
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn error_name(error: anchor_lang::error::Error) -> String {
    match error {
        anchor_lang::error::Error::AnchorError(error) => error.error_name,
        other => panic!("unexpected error {other:?}"),
    }
}

/// Compares `value` with the committed vector file, or rewrites it under `UPDATE_VECTORS`.
fn check(name: &str, value: Value) {
    let path = format!("{}/tests/vectors/{name}.json", env!("CARGO_MANIFEST_DIR"));
    let text = serde_json::to_string_pretty(&value).unwrap() + "\n";
    if std::env::var_os("UPDATE_VECTORS").is_some() {
        std::fs::create_dir_all(format!("{}/tests/vectors", env!("CARGO_MANIFEST_DIR"))).unwrap();
        std::fs::write(&path, text).unwrap();
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        committed == text,
        "{name}.json differs from what the program computes: run `just vectors` and review the diff"
    );
}

fn user_config(rng: &mut Rng, now: i64) -> UserConfig {
    let enrolled_at = now - rng.between(-DAY_SECONDS, 40 * DAY_SECONDS);
    let weeks = (now - enrolled_at).max(0) / WEEK_SECONDS;
    let engine_ran_at = match rng.below(4) {
        0 => enrolled_at - 1,
        1 => now - rng.between(0, 3 * HOUR),
        2 => now - rng.between(DAY_SECONDS - HOUR, DAY_SECONDS + HOUR),
        _ => now - rng.between(6 * DAY_SECONDS, 8 * DAY_SECONDS),
    };
    UserConfig {
        user: Pubkey::new_from_array([3; 32]),
        tier: rng.pick(&[0, 0, 1, 1, 2]),
        payment_tokens: rng.pick(&[0b01, 0b10, 0b11]),
        asset: rng.pick(&[0, 1]),
        engine: rng.pick(&[Engine::Daily, Engine::Weekly]),
        engine_amount: rng.pick(&[0, DOLLAR, 3 * DOLLAR, 10 * DOLLAR, 25 * DOLLAR]),
        income_rule: rng.below(2) == 1,
        change_multiplier: rng.below(4) as u8,
        cushions: [rng.pick(&[0, 20 * DOLLAR, 95 * DOLLAR]), rng.pick(&[0, 20 * DOLLAR, 95 * DOLLAR])],
        enrolled_at,
        goal_amount: 0,
        goal_label: [0; 32],
        bump: 254,
        week: (weeks as u32).saturating_sub(rng.below(2) as u32),
        week_spent: rng.pick(&[0, 0, DOLLAR, 4 * DOLLAR, 9 * DOLLAR, 24 * DOLLAR]),
        engine_ran_at,
        pending: rng.pick(&[0, 500_000, 7 * DOLLAR, 40 * DOLLAR, 40 * DOLLAR, u64::MAX]),
        status: match rng.below(10) {
            0 => UserStatus::Paused,
            1 => UserStatus::Exited,
            _ => UserStatus::Active,
        },
        attestable_from: enrolled_at,
        last_sweep_day: [0; 2],
    }
}

/// A subscription's account data: `amount` a period, `pulled` in the period that started at `started`.
fn subscription_bytes(amount: u64, pulled: u64, started: i64, expires_at_ts: i64) -> Vec<u8> {
    let state = SubscriptionDelegation {
        header: Header {
            discriminator: 2,
            version: 1,
            bump: 255,
            delegator: Pubkey::new_from_array([3; 32]),
            delegatee: Pubkey::new_from_array([4; 32]),
            payer: Pubkey::new_from_array([5; 32]),
            init_id: 1,
        },
        terms: PlanTerms { amount, period_hours: PLAN_PERIOD_HOURS, created_at: NOW - 90 * DAY_SECONDS },
        amount_pulled_in_period: pulled,
        current_period_start_ts: started,
        expires_at_ts,
    };
    let mut data = vec![];
    state.serialize(&mut data).unwrap();
    data
}

/// A random subscription at `now`, or `None` for a closed one.
fn random_subscription(rng: &mut Rng, now: i64, tier: u8) -> Option<Vec<u8>> {
    let amount = TIERS.get(usize::from(tier)).copied().unwrap_or(TIERS[0]);
    let expires_at_ts = match rng.below(6) {
        0 => return None,
        1 => now - rng.between(0, DAY_SECONDS),
        2 => now + rng.between(1, DAY_SECONDS),
        _ => 0,
    };
    let pulled = rng.pick(&[0, DOLLAR, amount / 2, amount]);
    let started = now - rng.between(0, PLAN_PERIOD_HOURS as i64 * HOUR + DAY_SECONDS);
    Some(subscription_bytes(amount, pulled, started, expires_at_ts))
}

fn remaining(data: Option<&[u8]>, now: i64) -> u64 {
    let key = Pubkey::new_unique();
    let (mut lamports, mut bytes, owner) = match data {
        Some(data) => (1, data.to_vec(), SUBSCRIPTIONS_ID),
        None => (0, vec![], anchor_lang::system_program::ID),
    };
    let account = AccountInfo::new(&key, false, true, &mut lamports, &mut bytes, &owner, false);
    subscription::remaining(&account, now)
}

fn pull_json(pull: Pull) -> Value {
    json!([pull.engine.to_string(), pull.pending.to_string()])
}

/// One pull the vectors record: the user's account and the sweep's inputs.
struct Case {
    name: String,
    config: UserConfig,
    token: usize,
    balance: u64,
    beta_cap: u64,
    calendar: &'static str,
    now: i64,
    subscription: Option<Vec<u8>>,
}

impl Case {
    /// The inputs, the program's pull and the pull capped by the subscription.
    fn vector(&self) -> Value {
        let market = if self.calendar == "nyse" { nyse_market_calendar() } else { MarketCalendar::default() };
        let pull = self.config.pull(self.token, self.balance, self.beta_cap, &market, self.now);
        let native = remaining(self.subscription.as_deref(), self.now);
        let mut data = vec![];
        self.config.try_serialize(&mut data).unwrap();
        json!({
            "name": self.name,
            "userConfig": hex(&data),
            "paymentToken": self.token,
            "balance": self.balance.to_string(),
            "betaCap": self.beta_cap.to_string(),
            "calendar": self.calendar,
            "now": self.now.to_string(),
            "subscription": self.subscription.as_deref().map(hex),
            "pull": pull_json(pull),
            "remaining": native.to_string(),
            "capped": pull_json(pull.capped(native)),
        })
    }
}

/// A USDC pull by a user with $1,000, the $25 beta cap and the NYSE calendar, their $25 subscription's period
/// started a day before, nothing pulled yet.
fn case(name: &str, config: UserConfig, now: i64) -> Case {
    Case {
        name: name.into(),
        config,
        token: 0,
        balance: 1_000 * DOLLAR,
        beta_cap: 25 * DOLLAR,
        calendar: "nyse",
        now,
        subscription: live(0, now - DAY_SECONDS),
    }
}

/// A session day's UTC instants for a date and New York time `(hours, minutes)`, given its offset.
fn at(date: (i64, i64, i64), hours: i64, minutes: i64, offset: i64) -> i64 {
    i64::from(day(date)) * DAY_SECONDS + (hours + offset) * HOUR + minutes * 60
}

/// A daily user on the $25 tier, $3 a day, $20 cushions, enrolled at `enrolled_at` and never swept, then `edit`ed.
fn user_at(enrolled_at: i64, edit: impl FnOnce(&mut UserConfig)) -> UserConfig {
    let mut config = user_config(&mut Rng(1), NOW);
    config.tier = 1;
    config.engine = Engine::Daily;
    config.engine_amount = 3 * DOLLAR;
    config.income_rule = false;
    config.change_multiplier = 0;
    config.cushions = [20 * DOLLAR; 2];
    config.enrolled_at = enrolled_at;
    config.engine_ran_at = enrolled_at - 1;
    config.attestable_from = enrolled_at;
    config.week = 0;
    config.week_spent = 0;
    config.pending = 0;
    config.status = UserStatus::Active;
    edit(&mut config);
    config
}

/// A $25 subscription with `pulled` taken in the period that started at `started`.
fn live(pulled: u64, started: i64) -> Option<Vec<u8>> {
    Some(subscription_bytes(TIERS[1], pulled, started, 0))
}

#[test]
fn amount_vectors() {
    let veteran = NOW - 2 * WEEK_SECONDS;
    let midnight = (NOW / DAY_SECONDS + 1) * DAY_SECONDS;
    // 2026-11-02 is the first weekday of standard time, Thanksgiving (the 26th) a holiday and the 27th an early close.
    let open = at((2026, 11, 2), 9, 30, 5);
    let close = at((2026, 11, 2), 16, 0, 5);
    let summer_open = at((2026, 10, 30), 9, 30, 4);
    let weekly = || user_at(NOW - 3 * WEEK_SECONDS, |c| c.engine = Engine::Weekly);
    let spent = |week, week_spent| user_at(veteran, |c| (c.week, c.week_spent) = (week, week_spent));
    let waiting = |pending| user_at(veteran, |c| (c.week, c.pending) = (2, pending));
    let ran = |at| user_at(veteran, |c| (c.engine_ran_at, c.week) = (at, 2));
    let named = [
        case("week rollover: last second of a week", spent(1, 25 * DOLLAR), veteran + 2 * WEEK_SECONDS - 1),
        case("week rollover: first second of the next", spent(1, 25 * DOLLAR), veteran + 2 * WEEK_SECONDS),
        case("trial: last second", user_at(NOW, |c| c.pending = 40 * DOLLAR), NOW + TRIAL_SECONDS - 1),
        case("trial: first second after", user_at(NOW, |c| c.pending = 40 * DOLLAR), NOW + TRIAL_SECONDS),
        Case {
            token: 1,
            ..case(
                "cap shared by both tokens",
                user_at(veteran, |c| (c.week, c.week_spent, c.pending) = (2, 23 * DOLLAR, 40 * DOLLAR)),
                NOW,
            )
        },
        Case { balance: 21 * DOLLAR, ..case("cushion: balance just above", waiting(40 * DOLLAR), NOW) },
        Case { balance: 20 * DOLLAR, ..case("cushion: balance at it", waiting(40 * DOLLAR), NOW) },
        case("daily engine: last second of the day it ran", ran(midnight - 10 * HOUR), midnight - 1),
        case("daily engine: first second of the next day", ran(midnight - 10 * HOUR), midnight),
        case("weekly engine: a second before the open", weekly(), open - 1),
        case("weekly engine: at the open", weekly(), open),
        case("weekly engine: last second of the session", weekly(), close - 1),
        case("weekly engine: at the close", weekly(), close),
        case("weekly engine: the open on the last weekday of daylight time", weekly(), summer_open),
        case("weekly engine: an hour before that open", weekly(), summer_open - HOUR),
        case("weekly engine: on an NYSE holiday", weekly(), at((2026, 11, 26), 10, 0, 5)),
        case("weekly engine: an early close at 12:59", weekly(), at((2026, 11, 27), 12, 59, 5)),
        case("weekly engine: an early close at 13:00", weekly(), at((2026, 11, 27), 13, 0, 5)),
        case("weekly engine: past the calendar", weekly(), at((2029, 1, 3), 10, 0, 5)),
        Case { calendar: "empty", ..case("weekly engine: an empty calendar", weekly(), open) },
        case("paused", user_at(veteran, |c| (c.status, c.pending) = (UserStatus::Paused, 7 * DOLLAR)), NOW),
        case("exited", user_at(veteran, |c| (c.status, c.pending) = (UserStatus::Exited, 7 * DOLLAR)), NOW),
        // After a tier change, an added token or a reactivation, the subscription's period no longer starts with the week.
        Case {
            subscription: live(20 * DOLLAR, NOW - 3 * DAY_SECONDS),
            ..case("native period: tier changed three days ago, partly pulled", waiting(40 * DOLLAR), NOW)
        },
        Case {
            token: 1,
            subscription: live(25 * DOLLAR, NOW - WEEK_SECONDS + 1),
            ..case("native period: token added, spent until the period ends", waiting(40 * DOLLAR), NOW)
        },
        Case {
            token: 1,
            subscription: live(25 * DOLLAR, NOW - WEEK_SECONDS),
            ..case("native period: reactivated, the period rolled over", waiting(40 * DOLLAR), NOW)
        },
        Case { subscription: None, ..case("native period: subscription closed", waiting(40 * DOLLAR), NOW) },
    ];
    let mut cases: Vec<Value> = named.iter().map(Case::vector).collect();
    let mut rng = Rng(0x1a7e_417e);
    for index in 0..CASES {
        let now = NOW
            + rng.between(0, 900 * DAY_SECONDS)
            + rng.pick(&[0, 13 * HOUR + 30 * 60, 14 * HOUR + 30 * 60, 19 * HOUR]);
        let config = user_config(&mut rng, now);
        let random = Case {
            name: format!("random {index}"),
            token: rng.pick(&[0, 0, 1, 1, 2]),
            balance: rng.pick(&[
                0,
                19 * DOLLAR,
                20 * DOLLAR + 1,
                23 * DOLLAR,
                1_000 * DOLLAR,
                1_000 * DOLLAR,
                1_000 * DOLLAR,
            ]),
            beta_cap: rng.pick(&[5 * DOLLAR, 10 * DOLLAR, 25 * DOLLAR, 25 * DOLLAR, 100 * DOLLAR]),
            calendar: rng.pick(&["nyse", "nyse", "nyse", "empty"]),
            now,
            subscription: random_subscription(&mut rng, now, config.tier),
            config,
        };
        cases.push(random.vector());
    }

    let rule = |income_rule: bool, change_multiplier: u8| {
        user_at(NOW, |c| (c.income_rule, c.change_multiplier) = (income_rule, change_multiplier))
    };
    let incomes = [0, 1, INCOME_MIN - 1, INCOME_MIN, INCOME_MIN + 9, 1_234_567_891, u64::MAX / 10_000];
    let payments = [0, 1, 499_999, 500_000, 999_999, 1_000_000, 1_000_001, 12_340_000, 12_500_001];
    let income_shares: Vec<Value> = [false, true]
        .iter()
        .flat_map(|&on| {
            incomes.map(|income| json!([on, income.to_string(), rule(on, 0).income_share(income).to_string()]))
        })
        .collect();
    let changes: Vec<Value> = (0..=3)
        .flat_map(|multiplier| {
            payments.map(|payment| {
                json!([multiplier, payment.to_string(), rule(false, multiplier).change(payment).to_string()])
            })
        })
        .collect();
    let tiers: Vec<String> = TIERS.iter().map(u64::to_string).collect();
    let mut calendar = vec![];
    nyse_market_calendar().serialize(&mut calendar).unwrap();
    check(
        "amount",
        json!({
            "constants": {
                "TIERS": tiers,
                "TRIAL_CAP": TRIAL_CAP.to_string(),
                "TRIAL_SECONDS": TRIAL_SECONDS.to_string(),
                "DAY_SECONDS": DAY_SECONDS.to_string(),
                "WEEK_SECONDS": WEEK_SECONDS.to_string(),
                "PLAN_PERIOD_HOURS": PLAN_PERIOD_HOURS.to_string(),
                "CALENDAR_DAYS": CALENDAR_DAYS,
                "INCOME_SHARE_BPS": INCOME_SHARE_BPS.to_string(),
                "INCOME_MIN": INCOME_MIN.to_string(),
                "CHANGE_STEP": CHANGE_STEP.to_string(),
                "CHANGE_MIN": CHANGE_MIN.to_string(),
                "MAX_PRICE_AGE_SECONDS": MAX_PRICE_AGE_SECONDS.to_string(),
                "MAX_CONFIDENCE_BPS": MAX_CONFIDENCE_BPS.to_string(),
                "SLIPPAGE_BPS": SLIPPAGE_BPS.to_string(),
                "USD_DECIMALS": USD_DECIMALS,
            },
            "calendars": { "nyse": hex(&calendar) },
            "pulls": cases,
            "incomeShares": income_shares,
            "changes": changes,
        }),
    );
}

#[test]
fn market_vectors() {
    // Each day from a week before the calendar's first day to a week past its last, at every instant where the
    // session could open or close in either offset, and a second before each.
    let calendar = nyse_market_calendar();
    let first = i64::from(calendar.first_day) - 7;
    let last = i64::from(calendar.valid_through) + 7;
    let seconds: Vec<i64> = [(9, 30), (13, 0), (16, 0)]
        .iter()
        .flat_map(|(hours, minutes)| [4, 5].map(|offset| (hours + offset) * HOUR + minutes * 60))
        .flat_map(|second| [second - 1, second])
        .collect();
    let open: String = (first..=last)
        .flat_map(|day| seconds.iter().map(move |second| day * DAY_SECONDS + second))
        .map(|now| if us_market_open(now, &calendar) { '1' } else { '0' })
        .collect();
    let mut data = vec![];
    calendar.serialize(&mut data).unwrap();
    check(
        "market",
        json!({ "calendar": hex(&data), "firstDay": first, "lastDay": last, "seconds": seconds, "open": open }),
    );
}

fn quote_json(result: anchor_lang::Result<Quote>) -> Value {
    match result {
        Ok(quote) => {
            json!({ "price": quote.price.to_string(), "confidence": quote.confidence.to_string(), "exponent": quote.exponent })
        }
        Err(error) => json!({ "error": error_name(error) }),
    }
}

/// A feed's properties: each an id and its encoded value.
type Properties = Vec<(u8, Vec<u8>)>;

/// A Solana-format update with a zero signature around `feeds`, each a feed id and its properties.
fn composed(feeds: &[(u32, Properties)]) -> Vec<u8> {
    let mut payload = 2_479_346_549u32.to_le_bytes().to_vec();
    payload.extend((PYTH_UPDATES_AT as u64 * 1_000_000).to_le_bytes());
    payload.extend([3, feeds.len() as u8]);
    for (id, properties) in feeds {
        payload.extend(id.to_le_bytes());
        payload.push(properties.len() as u8);
        for (property, value) in properties {
            payload.push(*property);
            payload.extend(value);
        }
    }
    let mut message = 2_182_742_457u32.to_le_bytes().to_vec();
    message.extend([0; 96]);
    message.extend((payload.len() as u16).to_le_bytes());
    message.extend(payload);
    message
}

/// Every property Pyth Pro defines for a feed, in id order, the ones the program reads set to `price`.
fn every_property(price: i64, confidence: i64) -> Properties {
    let some = |value: u64| [&[1][..], &value.to_le_bytes()].concat();
    vec![
        (0, price.to_le_bytes().to_vec()),
        (1, (price - 1).to_le_bytes().to_vec()),
        (2, (price + 1).to_le_bytes().to_vec()),
        (3, 7u16.to_le_bytes().to_vec()),
        (4, (-8i16).to_le_bytes().to_vec()),
        (5, confidence.to_le_bytes().to_vec()),
        (6, some(12)),
        (7, vec![0]),
        (8, some(3_600)),
        (9, 1u16.to_le_bytes().to_vec()),
        (10, price.to_le_bytes().to_vec()),
        (11, confidence.to_le_bytes().to_vec()),
        (12, some(PYTH_UPDATES_AT as u64 * 1_000_000)),
    ]
}

#[test]
fn price_vectors() {
    let updates = [("spyx_qqqx", PYTH_SPYX_QQQX), ("usdt", PYTH_USDT)];
    let mut quotes = vec![];
    for (name, update) in updates {
        for feed in [0, 8, 1837, 1843, 2419] {
            for now in [
                PYTH_UPDATES_AT - 1,
                PYTH_UPDATES_AT,
                PYTH_UPDATES_AT + MAX_PRICE_AGE_SECONDS,
                PYTH_UPDATES_AT + MAX_PRICE_AGE_SECONDS + 1,
            ] {
                quotes.push(json!({ "update": name, "feedId": feed, "now": now.to_string(), "result": quote_json(quote(update, feed, now)) }));
            }
        }
        quotes.push(json!({ "update": "empty", "feedId": 0, "now": PYTH_UPDATES_AT.to_string(), "result": quote_json(quote(&[], 0, PYTH_UPDATES_AT)) }));
        quotes.push(json!({ "update": "empty", "feedId": 1843, "now": PYTH_UPDATES_AT.to_string(), "result": quote_json(quote(&[], 1843, PYTH_UPDATES_AT)) }));
        // Every length cut and one flipped byte at every offset of the envelope and the first feeds.
        let mut rng = Rng(update.len() as u64);
        for cut in (0..update.len()).step_by(7) {
            let feed = rng.pick(&[8, 1843]);
            quotes.push(json!({ "update": name, "cut": cut, "feedId": feed, "now": PYTH_UPDATES_AT.to_string(), "result": quote_json(quote(&update[..cut], feed, PYTH_UPDATES_AT)) }));
        }
        for offset in (0..update.len().min(260)).step_by(2) {
            let mut mutated = update.to_vec();
            let value = rng.below(256) as u8;
            mutated[offset] = value;
            let feed = rng.pick(&[8, 1837, 1843]);
            quotes.push(json!({ "update": name, "set": [offset, value], "feedId": feed, "now": PYTH_UPDATES_AT.to_string(), "result": quote_json(quote(&mutated, feed, PYTH_UPDATES_AT)) }));
        }
    }

    let spyx = every_property(77_847_155_496, 30_532_893);
    let mut unknown = spyx.clone();
    unknown.push((13, vec![0]));
    let mut bad_flag = spyx.clone();
    bad_flag[6].1 = vec![2];
    let mut absent = spyx.clone();
    absent[0].1 = 0i64.to_le_bytes().to_vec();
    let variants = [
        ("every property", composed(&[(8, every_property(99_972_708, 7_028)), (1843, spyx.clone())])),
        ("an unknown property", composed(&[(1843, unknown)])),
        ("a presence flag of 2", composed(&[(1843, bad_flag)])),
        ("a price of 0", composed(&[(1843, absent)])),
        ("a negative price", composed(&[(1843, every_property(-5, 1))])),
        ("a confidence of 0", composed(&[(1843, every_property(77_847_155_496, 0))])),
        ("a wide confidence", composed(&[(1843, every_property(1_000_000, 5_001))])),
    ];
    for (name, message) in variants {
        for feed in [8, 1843] {
            let result = quote_json(quote(&message, feed, PYTH_UPDATES_AT));
            quotes.push(json!({ "name": name, "message": hex(&message), "feedId": feed, "now": PYTH_UPDATES_AT.to_string(), "result": result }));
        }
    }

    let mut rng = Rng(0x00e1_0017);
    let mut min_outs = vec![];
    let quote_of = |rng: &mut Rng| Quote {
        price: rng.pick(&[0, 1, 99_972_708, 77_847_155_496, 10u64.pow(18), u64::MAX]),
        confidence: rng.pick(&[0, 7_028, 30_532_893, 10u64.pow(9)]),
        exponent: rng.pick(&[-12, -8, -5, 0, 3, 40]),
    };
    let mut push = |amount: u64, payment: Quote, payment_decimals: u8, asset: Quote, asset_decimals: u8| {
        let result = match min_out(amount, payment, payment_decimals, asset, asset_decimals) {
            Ok(value) => json!({ "value": value.to_string() }),
            Err(error) => json!({ "error": error_name(error) }),
        };
        let q = |quote: Quote| json!([quote.price.to_string(), quote.confidence.to_string(), quote.exponent]);
        min_outs.push(json!({ "amount": amount.to_string(), "payment": q(payment), "paymentDecimals": payment_decimals, "asset": q(asset), "assetDecimals": asset_decimals, "result": result }));
    };
    for amount in [0, 1, 5 * DOLLAR, 25 * DOLLAR] {
        push(amount, Quote::DOLLAR, 6, PYTH_SPYX_QUOTE, 8);
        push(amount, PYTH_USDT_QUOTE, 6, PYTH_SPYX_QUOTE, 8);
        push(amount, PYTH_USDT_QUOTE, 6, PYTH_QQQX_QUOTE, 8);
    }
    for _ in 0..CASES {
        let amount = rng.pick(&[0, 1, 999, DOLLAR, 25 * DOLLAR, u64::MAX]);
        let (payment, asset) = (quote_of(&mut rng), quote_of(&mut rng));
        push(amount, payment, rng.pick(&[0, 6, 9]), asset, rng.pick(&[0, 6, 8, 18]));
    }
    check("price", json!({ "quotes": quotes, "minOuts": min_outs }));
}

#[test]
fn attestation_vectors() {
    let attestor = attestor();
    let mut rng = Rng(0x00a7_7e57);
    let mut cases = vec![];
    for (index, genesis_hash) in
        [DEVNET_GENESIS_HASH, MAINNET_GENESIS_HASH, DEVNET_GENESIS_HASH, DEVNET_GENESIS_HASH].iter().enumerate()
    {
        let attestation = Attestation {
            kind: if index % 2 == 0 { EventKind::Income } else { EventKind::Payment },
            user: Keypair::new_from_array([index as u8 + 20; 32]).pubkey(),
            payment_token: (index % 2) as u8,
            amount: rng.below(1_000_000 * DOLLAR),
            event_time: NOW + rng.between(0, 7 * DAY_SECONDS),
            signature: [index as u8 + 1; 64],
            transfer_index: rng.below(4) as u16,
        };
        let message = attestation_message(&laterite::ID, genesis_hash, &attestation);
        let instruction = signature_ix(&message, &attestor);
        cases.push(json!({
            "attestation": {
                "kind": attestation.kind as u8,
                "user": attestation.user.to_string(),
                "paymentToken": attestation.payment_token,
                "amount": attestation.amount.to_string(),
                "eventTime": attestation.event_time.to_string(),
                "signature": hex(&attestation.signature),
                "transferIndex": attestation.transfer_index,
            },
            "genesisHash": hex(genesis_hash),
            "message": hex(&message),
            "ed25519": hex(&instruction.data),
            "record": attestation_record_address(&attestation).to_string(),
        }));
    }
    let sweep = |payment: &[u8]| hex(&sweep_ed25519_ix(PYTH_SPYX_QQQX, payment).data);
    check(
        "attestation",
        json!({
            "attestor": hex(&[8; 32]),
            "cases": cases,
            "sweepEd25519": { "usdc": sweep(&[]), "usdt": sweep(PYTH_USDT) },
        }),
    );
}

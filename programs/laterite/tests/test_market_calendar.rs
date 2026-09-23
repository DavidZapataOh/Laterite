mod common;

use {
    anchor_lang::Event,
    base64::{engine::general_purpose::STANDARD, Engine},
    common::*,
    laterite::{events::MarketCalendarSet, us_market_open, LateriteError, MarketCalendar, DAY_SECONDS},
    solana_signer::Signer,
};

type Calendar = (Vec<u16>, Vec<u16>, u16);

fn today() -> u16 {
    (NOW / DAY_SECONDS) as u16
}

fn ones(bits: &[u8]) -> u32 {
    bits.iter().map(|byte| byte.count_ones()).sum()
}

fn at(date: (i64, i64, i64), seconds: i64) -> i64 {
    i64::from(day(date)) * DAY_SECONDS + seconds
}

#[test]
fn the_admin_loads_the_nyse_calendar() {
    let mut env = initialized();
    let calendar = fetch_config(&env.svm).market_calendar;
    assert_eq!((calendar.first_day, calendar.valid_through), (today(), day(nyse_valid_through())));
    // Only the closures from the loading day on are kept: two of 2026's holidays, all of 2027's and 2028's.
    assert_eq!((ones(&calendar.holidays), ones(&calendar.early_closes)), (21, 5));
    for holiday in nyse_holidays().into_iter().filter(|date| day(*date) >= today()) {
        assert!(!us_market_open(at(holiday, 15 * 3600), &calendar), "{holiday:?}");
    }
    for early_close in nyse_early_closes() {
        assert!(us_market_open(at(early_close, 15 * 3600), &calendar), "{early_close:?}");
        assert!(!us_market_open(at(early_close, 18 * 3600 + 1800), &calendar), "{early_close:?}");
    }

    // A later load replaces the whole calendar: here, from 2027.
    let admin = env.authority.insecure_clone();
    let (holidays, early_closes, valid_through) = nyse_calendar();
    let (holidays, early_closes) = (holidays[10..].to_vec(), early_closes[2..].to_vec());
    let reload = set_market_calendar_ix(admin.pubkey(), holidays.clone(), early_closes.clone(), valid_through);
    let metadata = send(&mut env.svm, &admin, reload, &[]).unwrap();
    println!("set_market_calendar: {} compute units", metadata.compute_units_consumed);
    let event = MarketCalendarSet { holidays, early_closes, valid_through };
    assert!(metadata.logs.contains(&format!("Program data: {}", STANDARD.encode(event.data()))));
    let calendar = fetch_config(&env.svm).market_calendar;
    assert_eq!((ones(&calendar.holidays), ones(&calendar.early_closes)), (19, 3));
    assert!(us_market_open(at((2026, 11, 26), 15 * 3600), &calendar));
}

#[test]
fn a_new_config_has_no_market_days() {
    let mut env = setup();
    let authority = env.authority.insecure_clone();
    send(&mut env.svm, &authority, initialize_ix(authority.pubkey(), valid_params()), &[]).unwrap();
    let calendar = fetch_config(&env.svm).market_calendar;
    assert_eq!(calendar, MarketCalendar::default());
    assert!(!us_market_open(NOW, &calendar));
}

type Mutation = fn(&mut Calendar);

#[test]
fn invalid_calendars_are_rejected() {
    let cases: [(Mutation, LateriteError); 9] = [
        (|c| c.0.swap(3, 4), LateriteError::CalendarNotAscending),
        (|c| c.0.insert(4, c.0[4]), LateriteError::CalendarNotAscending),
        (|c| c.1.swap(0, 1), LateriteError::CalendarNotAscending),
        // Independence Day 2026 falls on a Saturday; the NYSE closes on Friday, July 3.
        (|c| c.0[6] = day((2026, 7, 4)), LateriteError::ImplausibleMarketDay),
        (|c| c.0.insert(9, day((2026, 11, 27))), LateriteError::ImplausibleMarketDay),
        (|c| c.2 = day((2027, 12, 31)), LateriteError::ImplausibleMarketDay),
        (|c| *c = (vec![], vec![], today() - 1), LateriteError::ImplausibleMarketDay),
        (|c| c.2 = today() + 1_464, LateriteError::ImplausibleMarketDay),
        // The 2025 national day of mourning is more than a year old.
        (|c| c.0.insert(0, day((2025, 1, 9))), LateriteError::ImplausibleMarketDay),
    ];
    let mut env = initialized();
    let admin = env.authority.insecure_clone();
    for (mutate, expected) in cases {
        let mut calendar = nyse_calendar();
        mutate(&mut calendar);
        let (holidays, early_closes, valid_through) = calendar;
        let load = set_market_calendar_ix(admin.pubkey(), holidays, early_closes, valid_through);
        let failure = send(&mut env.svm, &admin, load, &[]).unwrap_err();
        assert_eq!(custom_code(&failure), Some(expected.into()), "{expected:?}");
    }
    let (holidays, early_closes, _) = nyse_calendar();
    let longest = set_market_calendar_ix(admin.pubkey(), holidays, early_closes, today() + 1_463);
    send(&mut env.svm, &admin, longest, &[]).unwrap();
}

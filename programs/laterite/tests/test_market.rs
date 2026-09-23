mod common;

use {
    common::*,
    laterite::{us_market_open, MarketCalendar, DAY_SECONDS},
};

const HOUR: i64 = 3_600;

/// US daylight saving time by year: the March day it starts, the November day it ends.
const DAYLIGHT_TIME: [(i64, i64, i64); 21] = [
    (2020, 8, 1),
    (2021, 14, 7),
    (2022, 13, 6),
    (2023, 12, 5),
    (2024, 10, 3),
    (2025, 9, 2),
    (2026, 8, 1),
    (2027, 14, 7),
    (2028, 12, 5),
    (2029, 11, 4),
    (2030, 10, 3),
    (2031, 9, 2),
    (2032, 14, 7),
    (2033, 13, 6),
    (2034, 12, 5),
    (2035, 11, 4),
    (2036, 9, 2),
    (2037, 8, 1),
    (2038, 14, 7),
    (2039, 13, 6),
    (2040, 11, 4),
];

/// A calendar without closures covering `days` alone: the clock decides.
fn clock_only(days: i64) -> MarketCalendar {
    MarketCalendar::new(&[], &[], days as u16, days).unwrap()
}

fn at(date: (i64, i64, i64), seconds: i64) -> i64 {
    i64::from(day(date)) * DAY_SECONDS + seconds
}

#[test]
fn market_hours_follow_new_york_time_every_day_from_2020_to_2040() {
    let mut days = 18_262; // 2020-01-01, a Wednesday
    for (year, march, november) in DAYLIGHT_TIME {
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
        let lengths = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        for (month, length) in (1..=12).zip(lengths) {
            for day in 1..=length {
                let weekday = (days + 4) % 7;
                let daylight = (month, day) >= (3, march) && (month, day) < (11, november);
                let open = days * DAY_SECONDS + if daylight { 13 * HOUR + 1800 } else { 14 * HOUR + 1800 };
                let close = open + 6 * HOUR + 1800;
                let session = (1..=5).contains(&weekday);
                let calendar = clock_only(days);
                for (now, expected) in [(open - 1, false), (open, session), (close - 1, session), (close, false)] {
                    assert_eq!(us_market_open(now, &calendar), expected, "{year}-{month}-{day} at {now}");
                }
                days += 1;
            }
        }
    }
}

#[test]
fn the_market_is_closed_all_day_on_nyse_holidays() {
    let nyse = nyse_market_calendar();
    for holiday in nyse_holidays() {
        let midday = at(holiday, 17 * HOUR);
        assert!(us_market_open(midday, &clock_only(day(holiday).into())), "{holiday:?} is a session by the clock");
        for now in (at(holiday, 0)..at(holiday, DAY_SECONDS)).step_by(60) {
            assert!(!us_market_open(now, &nyse), "{holiday:?} at {now}");
        }
    }
}

#[test]
fn the_market_closes_at_13_00_new_york_time_on_early_closes() {
    let nyse = nyse_market_calendar();
    for (year, month, date) in nyse_early_closes() {
        // July is in daylight time (UTC-4); late November and December are not (UTC-5).
        let offset = if month == 7 { 4 * HOUR } else { 5 * HOUR };
        let (open, close) =
            (at((year, month, date), 9 * HOUR + 1800 + offset), at((year, month, date), 13 * HOUR + offset));
        for (now, expected) in [(open - 1, false), (open, true), (close - 1, true), (close, false)] {
            assert_eq!(us_market_open(now, &nyse), expected, "{year}-{month}-{date} at {now}");
        }
    }
    // The Monday after the 2026 early close keeps its full session.
    assert!(us_market_open(at((2026, 11, 30), 20 * HOUR + 59 * 60), &nyse));
}

#[test]
fn the_market_counts_as_closed_past_the_calendar() {
    let nyse = nyse_market_calendar();
    assert!(us_market_open(at((2028, 12, 29), 15 * HOUR), &nyse));
    assert!(!us_market_open(at((2029, 1, 2), 15 * HOUR), &nyse));
    assert!(!us_market_open(at((2026, 9, 21), 15 * HOUR), &MarketCalendar::default()));
}

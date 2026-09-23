//! The regular NYSE session, derived independently of the program's `us_market_open`: New York time from the IANA
//! database, and the closures from the calendar file the harness loads.

use std::collections::HashSet;

use chrono::{Datelike, NaiveDate, NaiveTime, TimeZone, Weekday};
use chrono_tz::America::New_York;

use crate::constants::NYSE_CALENDAR;

/// A calendar as the harness last loaded it: the days it covers and its closures.
#[derive(Clone, Debug)]
pub struct Calendar {
    pub first_day: NaiveDate,
    pub valid_through: NaiveDate,
    pub holidays: HashSet<NaiveDate>,
    pub early_closes: HashSet<NaiveDate>,
}

impl Calendar {
    /// The NYSE calendar file, loaded at `ts`.
    pub fn nyse(ts: i64) -> Self {
        let file: crucible_fuzzer::serde_json::Value =
            crucible_fuzzer::serde_json::from_str(&std::fs::read_to_string(NYSE_CALENDAR).unwrap()).unwrap();
        let dates =
            |key: &str| file[key].as_array().unwrap().iter().map(|date| parse(date.as_str().unwrap())).collect();
        Self {
            first_day: utc_date(ts),
            valid_through: parse(file["validThrough"].as_str().unwrap()),
            holidays: dates("holidays"),
            early_closes: dates("earlyCloses"),
        }
    }

    /// No closures, covering only the day of `ts`.
    pub fn today_only(ts: i64) -> Self {
        let today = utc_date(ts);
        Self { first_day: today, valid_through: today, holidays: HashSet::new(), early_closes: HashSet::new() }
    }

    /// Whether `ts` falls in a regular session: a weekday the calendar covers, not a holiday, from 9:30 to 16:00 New
    /// York time, or to 13:00 on an early close.
    pub fn open(&self, ts: i64) -> bool {
        let local = New_York.timestamp_opt(ts, 0).unwrap();
        let date = local.date_naive();
        let close = if self.early_closes.contains(&date) { (13, 0) } else { (16, 0) };
        let time = local.time();
        (self.first_day..=self.valid_through).contains(&date)
            && !matches!(date.weekday(), Weekday::Sat | Weekday::Sun)
            && !self.holidays.contains(&date)
            && time >= NaiveTime::from_hms_opt(9, 30, 0).unwrap()
            && time < NaiveTime::from_hms_opt(close.0, close.1, 0).unwrap()
    }
}

fn parse(date: &str) -> NaiveDate {
    NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap()
}

fn utc_date(ts: i64) -> NaiveDate {
    chrono::DateTime::from_timestamp(ts, 0).unwrap().date_naive()
}

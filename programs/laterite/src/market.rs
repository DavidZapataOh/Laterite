//! The regular US equity session, from the clock and the NYSE calendar kept in `Config`.

use anchor_lang::prelude::*;

use crate::{errors::LateriteError, MarketCalendar, CALENDAR_DAYS, CALENDAR_MAX_AGE_DAYS, DAY_SECONDS};

const HOUR: i64 = 60 * 60;

/// The session's open, regular close and early close, in seconds after midnight New York time.
const OPEN: i64 = 9 * HOUR + 30 * 60;
const CLOSE: i64 = 16 * HOUR;
const EARLY_CLOSE: i64 = 13 * HOUR;

/// Whether `now` falls in a regular NYSE session: Monday to Friday, 9:30 to 16:00 New York time with US daylight
/// saving time, except the calendar's holidays, until 13:00 on its early closes, and never outside its span.
pub fn us_market_open(now: i64, calendar: &MarketCalendar) -> bool {
    let days = now.div_euclid(DAY_SECONDS);
    let weekday = weekday(days);
    let Some(index) = calendar.index(days) else {
        return false;
    };
    if weekday == 0 || weekday == 6 || is_set(&calendar.holidays, index) {
        return false;
    }
    // New York is UTC-4 in daylight time and UTC-5 otherwise, so the session lies within one UTC day.
    let offset = if us_daylight_time(days, weekday) { 4 * HOUR } else { 5 * HOUR };
    let close = if is_set(&calendar.early_closes, index) { EARLY_CLOSE } else { CLOSE };
    (OPEN + offset..close + offset).contains(&now.rem_euclid(DAY_SECONDS))
}

impl MarketCalendar {
    /// Loads ascending closures, in days since 1970-01-01, on `today`: each is a weekday on one list only, at most
    /// `CALENDAR_MAX_AGE_DAYS` old and not after `valid_through`, which lies within `CALENDAR_DAYS` from today.
    /// Closures before today are checked but not kept.
    pub fn new(holidays: &[u16], early_closes: &[u16], valid_through: u16, today: i64) -> Result<Self> {
        let end = i64::from(valid_through);
        require!(
            (today..today.saturating_add(CALENDAR_DAYS as i64)).contains(&end),
            LateriteError::ImplausibleMarketDay
        );
        let mut calendar = Self { first_day: today as u16, valid_through, ..Self::default() };
        for (days, bits) in [(holidays, &mut calendar.holidays), (early_closes, &mut calendar.early_closes)] {
            require!(days.windows(2).all(|pair| pair[0] < pair[1]), LateriteError::CalendarNotAscending);
            for &day in days {
                let day = i64::from(day);
                require!(
                    (today.saturating_sub(CALENDAR_MAX_AGE_DAYS)..=end).contains(&day)
                        && (1..=5).contains(&weekday(day)),
                    LateriteError::ImplausibleMarketDay
                );
                if let Ok(index) = usize::try_from(day - today) {
                    bits[index / 8] |= 1 << (index % 8);
                }
            }
        }
        require!(
            !early_closes.iter().any(|day| holidays.binary_search(day).is_ok()),
            LateriteError::ImplausibleMarketDay
        );
        Ok(calendar)
    }

    /// The bit of `day`, when the calendar covers it.
    fn index(&self, day: i64) -> Option<usize> {
        let covered = (i64::from(self.first_day)..=i64::from(self.valid_through)).contains(&day);
        covered.then(|| (day - i64::from(self.first_day)) as usize)
    }
}

fn is_set(bits: &[u8], index: usize) -> bool {
    bits.get(index / 8).is_some_and(|byte| byte & (1 << (index % 8)) != 0)
}

/// Day of the week of a day count since 1970-01-01, a Thursday; 0 is Sunday.
fn weekday(days: i64) -> i64 {
    (days + 4).rem_euclid(7)
}

/// Daylight saving time runs from the second Sunday in March to the first Sunday in November. It switches at 2:00
/// on a Sunday, so a weekday is on one side of it all day.
fn us_daylight_time(days: i64, weekday: i64) -> bool {
    let (month, day) = month_day(days);
    let first_weekday = (weekday - (day - 1)).rem_euclid(7);
    let first_sunday = 1 + (7 - first_weekday) % 7;
    match month {
        4..=10 => true,
        3 => day >= first_sunday + 7,
        11 => day < first_sunday,
        _ => false,
    }
}

/// Month and day of a day count since 1970-01-01, from Howard Hinnant's `civil_from_days`.
fn month_day(days: i64) -> (i64, i64) {
    let z = days + 719_468;
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (month, day)
}

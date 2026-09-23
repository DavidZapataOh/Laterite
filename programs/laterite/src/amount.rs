//! The amount engine: how much a sweep may pull, derived only from the user's signed rules, the events attested for
//! them, the clock, the market calendar and the token balance. Amounts are payment-token raw units, one dollar being
//! 1,000,000.

use crate::{
    us_market_open, Engine, MarketCalendar, UserConfig, UserStatus, DAY_SECONDS, TIERS, TRIAL_CAP, TRIAL_SECONDS,
    WEEK_SECONDS,
};

/// Income rule: the share of each incoming payment invested, in basis points (10%).
pub const INCOME_SHARE_BPS: u64 = 1_000;

/// Income rule: smaller incoming payments are ignored ($50).
pub const INCOME_MIN: u64 = 50_000_000;

/// Change per payment rounds each outgoing payment up to the next dollar...
pub const CHANGE_STEP: u64 = 1_000_000;

/// ...and invests at least $0.50 per payment, before the multiplier.
pub const CHANGE_MIN: u64 = 500_000;

/// What one sweep pulls, by source.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Pull {
    pub engine: u64,
    pub pending: u64,
}

impl Pull {
    pub fn total(&self) -> u64 {
        self.engine + self.pending
    }

    /// The pull within `limit`, the engine kept first.
    pub fn capped(self, limit: u64) -> Pull {
        let engine = self.engine.min(limit);
        Pull { engine, pending: self.pending.min(limit - engine) }
    }
}

impl UserConfig {
    /// What the income rule adds for an incoming payment.
    pub fn income_share(&self, income: u64) -> u64 {
        if !self.income_rule || income < INCOME_MIN {
            return 0;
        }
        (u128::from(income) * u128::from(INCOME_SHARE_BPS) / 10_000) as u64
    }

    /// What change per payment adds for an outgoing payment: max(round-up to the next dollar, $0.50) times the
    /// multiplier.
    pub fn change(&self, payment: u64) -> u64 {
        let round_up = (CHANGE_STEP - payment % CHANGE_STEP) % CHANGE_STEP;
        round_up.max(CHANGE_MIN) * u64::from(self.change_multiplier)
    }

    /// Index of the user's week at `now`, counted from enrollment.
    pub fn week_at(&self, now: i64) -> u32 {
        (now.saturating_sub(self.enrolled_at).max(0) / WEEK_SECONDS) as u32
    }

    /// The combined cap across both payment tokens for the week of `now`: the trial cap in the first week, the tier
    /// afterwards, never above the beta's cap per user.
    pub fn weekly_cap(&self, beta_cap: u64, now: i64) -> u64 {
        let cap = if now < self.enrolled_at.saturating_add(TRIAL_SECONDS) {
            TRIAL_CAP
        } else {
            TIERS.get(usize::from(self.tier)).copied().unwrap_or(0)
        };
        cap.min(beta_cap)
    }

    /// Pulled so far in the week of `now`, across both payment tokens.
    pub fn spent_at(&self, now: i64) -> u64 {
        if self.week_at(now) == self.week {
            self.week_spent
        } else {
            0
        }
    }

    /// The daily engine buys once per UTC day, at any hour; the weekly engine once per week, during a regular NYSE
    /// session. A missed day or week is skipped, not made up.
    pub fn engine_due(&self, calendar: &MarketCalendar, now: i64) -> bool {
        let ran = self.engine_ran_at >= self.enrolled_at;
        match self.engine {
            Engine::Daily => !ran || now.div_euclid(DAY_SECONDS) > self.engine_ran_at.div_euclid(DAY_SECONDS),
            Engine::Weekly => {
                (!ran || self.week_at(now) > self.week_at(self.engine_ran_at)) && us_market_open(now, calendar)
            }
        }
    }

    /// What a sweep of `payment_token` may pull at `now` from a `balance` in that token: the engine if due, then
    /// pending variable amounts, within the week's remaining cap and above the token's cushion. Nothing unless the
    /// user is active.
    pub fn pull(&self, payment_token: usize, balance: u64, beta_cap: u64, calendar: &MarketCalendar, now: i64) -> Pull {
        if self.status != UserStatus::Active {
            return Pull::default();
        }
        let cushion = self.cushions.get(payment_token).copied().unwrap_or(u64::MAX);
        let room =
            self.weekly_cap(beta_cap, now).saturating_sub(self.spent_at(now)).min(balance.saturating_sub(cushion));
        let engine = if self.engine_due(calendar, now) { self.engine_amount.min(room) } else { 0 };
        Pull { engine, pending: self.pending.min(room - engine) }
    }

    /// Records a completed pull: rolls the week over, counts the pull against it, consumes the pending amount and
    /// marks the engine as run.
    pub fn record(&mut self, pull: Pull, now: i64) {
        let week = self.week_at(now);
        if week != self.week {
            self.week = week;
            self.week_spent = 0;
        }
        self.week_spent = self.week_spent.saturating_add(pull.total());
        self.pending = self.pending.saturating_sub(pull.pending);
        if pull.engine > 0 {
            self.engine_ran_at = now;
        }
    }
}

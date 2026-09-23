use anchor_lang::prelude::*;
use subscriptions::SUBSCRIPTIONS_ID;

use crate::{
    errors::LateriteError,
    events::{Exited, PaymentTokensChanged, PendingLowered, Reactivated, TierChanged, UserPaused, UserSettingsUpdated},
    subscription, Config, EnrollParams, UserConfig, UserStatus, CONFIG, PAYMENT_TOKEN_COUNT, PLANS,
    SUBSCRIPTIONS_EVENT_AUTHORITY, TIERS, USER_CONFIG_SEED, VAULT,
};

#[derive(Accounts)]
pub struct UserOnly<'info> {
    pub user: Signer<'info>,
    #[account(
        mut,
        seeds = [USER_CONFIG_SEED, user.key().as_ref()],
        bump = user_config.bump,
        constraint = user_config.status != UserStatus::Exited @ LateriteError::UserNotActive
    )]
    pub user_config: Account<'info, UserConfig>,
}

impl UserOnly<'_> {
    pub fn update_settings(&mut self, params: EnrollParams) -> Result<()> {
        let user_config = &mut self.user_config;
        require!(
            params.tier == user_config.tier && params.payment_tokens == user_config.payment_tokens,
            LateriteError::PlanChangeRequired
        );
        params.validate_rules()?;
        // A change that makes an attestation count more applies only to transfers from now on: no backfill.
        let counts_more = (params.income_rule && !user_config.income_rule)
            || params.change_multiplier > user_config.change_multiplier;
        if counts_more {
            user_config.raise_attestable_from(Clock::get()?.unix_timestamp);
        }
        user_config.set_settings(&params);
        emit!(UserSettingsUpdated { user: user_config.user, params });
        Ok(())
    }

    pub fn set_user_paused(&mut self, paused: bool) -> Result<()> {
        let user_config = &mut self.user_config;
        if paused {
            require!(user_config.status == UserStatus::Active, LateriteError::UserNotActive);
            user_config.status = UserStatus::Paused;
        } else {
            require!(user_config.status == UserStatus::Paused, LateriteError::UserNotPaused);
            user_config.status = UserStatus::Active;
            user_config.raise_attestable_from(Clock::get()?.unix_timestamp);
        }
        emit!(UserPaused { user: user_config.user, paused });
        Ok(())
    }

    pub fn lower_pending(&mut self, pending: u64) -> Result<()> {
        require_gte!(self.user_config.pending, pending, LateriteError::PendingIncrease);
        self.user_config.pending = pending;
        emit!(PendingLowered { user: self.user_config.user, pending });
        Ok(())
    }
}

/// The signers and programs that end a user's subscriptions: the user and the vault, the plans' owner.
#[derive(Accounts)]
pub struct Cancellation<'info> {
    pub user: Signer<'info>,
    /// CHECK: the vault authority, checked by address.
    #[account(address = VAULT)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: checked by address.
    #[account(address = SUBSCRIPTIONS_ID)]
    pub subscriptions_program: UncheckedAccount<'info>,
    /// CHECK: checked by address.
    #[account(address = SUBSCRIPTIONS_EVENT_AUTHORITY)]
    pub subscriptions_event_authority: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct TierChange<'info> {
    pub cancellation: Cancellation<'info>,
    #[account(address = CONFIG)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [USER_CONFIG_SEED, cancellation.user.key().as_ref()],
        bump = user_config.bump,
        constraint = user_config.status != UserStatus::Exited @ LateriteError::UserNotActive
    )]
    pub user_config: Account<'info, UserConfig>,
}

impl<'info> TierChange<'info> {
    /// Remaining accounts, per enabled payment token in order: the current tier's plan and the user's subscription to
    /// it, then the user's subscription to the new tier's plan.
    pub fn change_tier(&mut self, tier: u8, accounts: &[AccountInfo<'info>]) -> Result<()> {
        let user_config = &self.user_config;
        let current = usize::from(user_config.tier);
        let cap = *TIERS.get(usize::from(tier)).ok_or(LateriteError::InvalidTier)?;
        require_neq!(usize::from(tier), current, LateriteError::InvalidTier);
        require_gte!(self.config.user_weekly_cap, cap, LateriteError::CapAboveBetaLimit);
        require_gte!(cap, user_config.engine_amount, LateriteError::InvalidRules);

        let now = Clock::get()?.unix_timestamp;
        let user = self.cancellation.user.key();
        let mut accounts = accounts.chunks_exact(3);
        for payment_token in (0..PAYMENT_TOKEN_COUNT).filter(|i| user_config.payment_tokens & (1 << i) != 0) {
            let Some([plan, old, new]) = accounts.next() else {
                return err!(LateriteError::SubscriptionMismatch);
            };
            self.cancellation.cancel(PLANS[payment_token][current], plan, old, now)?;
            let new_plan = PLANS[payment_token][usize::from(tier)];
            require!(subscription::is_live(new, new_plan, user), LateriteError::SubscriptionMismatch);
        }

        self.user_config.tier = tier;
        emit!(TierChanged { user, tier });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct PaymentTokensChange<'info> {
    pub cancellation: Cancellation<'info>,
    #[account(
        mut,
        seeds = [USER_CONFIG_SEED, cancellation.user.key().as_ref()],
        bump = user_config.bump,
        constraint = user_config.status != UserStatus::Exited @ LateriteError::UserNotActive
    )]
    pub user_config: Account<'info, UserConfig>,
}

impl<'info> PaymentTokensChange<'info> {
    /// Remaining accounts, per payment token whose bit changes, in token order: for a dropped token the tier's plan
    /// and the user's subscription to it, for an added token the user's subscription to the tier's plan.
    pub fn change_payment_tokens(&mut self, payment_tokens: u8, accounts: &[AccountInfo<'info>]) -> Result<()> {
        require!(payment_tokens != 0, LateriteError::NoPaymentToken);
        require!(payment_tokens >> PAYMENT_TOKEN_COUNT == 0, LateriteError::UnknownPaymentToken);
        let user_config = &self.user_config;
        let tier = usize::from(user_config.tier);
        let enabled = user_config.payment_tokens;

        let now = Clock::get()?.unix_timestamp;
        let user = self.cancellation.user.key();
        let mut accounts = accounts.iter();
        let mut next = || accounts.next().ok_or(LateriteError::SubscriptionMismatch);
        for (payment_token, plans) in PLANS.iter().enumerate() {
            let bit = 1 << payment_token;
            let plan = plans[tier];
            if enabled & bit != 0 && payment_tokens & bit == 0 {
                let (plan_account, subscription) = (next()?, next()?);
                self.cancellation.cancel(plan, plan_account, subscription, now)?;
            } else if enabled & bit == 0 && payment_tokens & bit != 0 {
                require!(subscription::is_live(next()?, plan, user), LateriteError::SubscriptionMismatch);
            }
        }

        let user_config = &mut self.user_config;
        // A token turned on credits only transfers from now on: no backfill.
        if payment_tokens & !enabled != 0 {
            user_config.raise_attestable_from(now);
        }
        user_config.payment_tokens = payment_tokens;
        emit!(PaymentTokensChanged { user, payment_tokens });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Exit<'info> {
    pub cancellation: Cancellation<'info>,
    #[account(mut, address = CONFIG)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [USER_CONFIG_SEED, cancellation.user.key().as_ref()],
        bump = user_config.bump,
        constraint = user_config.status != UserStatus::Exited @ LateriteError::UserNotActive
    )]
    pub user_config: Account<'info, UserConfig>,
}

impl<'info> Exit<'info> {
    /// Remaining accounts, per enabled payment token in order: the tier's plan and the user's subscription to it.
    pub fn exit(&mut self, accounts: &[AccountInfo<'info>]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let user_config = &self.user_config;
        let tier = usize::from(user_config.tier);
        let mut accounts = accounts.chunks_exact(2);
        for payment_token in (0..PAYMENT_TOKEN_COUNT).filter(|i| user_config.payment_tokens & (1 << i) != 0) {
            let Some([plan, subscription]) = accounts.next() else {
                return err!(LateriteError::SubscriptionMismatch);
            };
            self.cancellation.cancel(PLANS[payment_token][tier], plan, subscription, now)?;
        }

        self.config.user_count = self.config.user_count.saturating_sub(1);
        let user_config = &mut self.user_config;
        user_config.set_settings(&EnrollParams::default());
        user_config.pending = 0;
        user_config.status = UserStatus::Exited;
        emit!(Exited { user: user_config.user });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Reactivate<'info> {
    pub user: Signer<'info>,
    pub sponsor: Signer<'info>,
    #[account(
        mut,
        address = CONFIG,
        constraint = config.sponsor == sponsor.key() @ LateriteError::NotSponsor
    )]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [USER_CONFIG_SEED, user.key().as_ref()],
        bump = user_config.bump,
        constraint = user_config.status == UserStatus::Exited @ LateriteError::UserNotExited
    )]
    pub user_config: Account<'info, UserConfig>,
}

impl Reactivate<'_> {
    pub fn reactivate(&mut self, params: EnrollParams, subscriptions: &[AccountInfo]) -> Result<()> {
        require!(!self.config.paused, LateriteError::ProgramPaused);
        require_gt!(self.config.max_users, self.config.user_count, LateriteError::BetaFull);
        params.validate(&self.config)?;
        subscription::require_live(subscriptions, params.payment_tokens, params.tier, self.user.key())?;

        let user_config = &mut self.user_config;
        user_config.set_settings(&params);
        user_config.status = UserStatus::Active;
        user_config.raise_attestable_from(Clock::get()?.unix_timestamp);
        self.config.user_count += 1;
        emit!(Reactivated {
            user: user_config.user,
            tier: params.tier,
            payment_tokens: params.payment_tokens,
            asset: params.asset,
        });
        Ok(())
    }
}

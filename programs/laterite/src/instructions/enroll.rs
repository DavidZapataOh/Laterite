use anchor_lang::prelude::*;
use subscriptions::{SubscriptionDelegation, SUBSCRIPTIONS_ID};

use crate::{
    errors::LateriteError, events::Enrolled, Config, EnrollParams, UserConfig, UserStatus, CONFIG_SEED,
    PAYMENT_TOKEN_COUNT, PLANS, USER_CONFIG_SEED,
};

#[derive(Accounts)]
pub struct Enroll<'info> {
    pub user: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = config.sponsor == payer.key() @ LateriteError::NotSponsor
    )]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = payer,
        space = 8 + UserConfig::INIT_SPACE,
        seeds = [USER_CONFIG_SEED, user.key().as_ref()],
        bump
    )]
    pub user_config: Account<'info, UserConfig>,
    pub system_program: Program<'info, System>,
}

impl Enroll<'_> {
    pub fn enroll(&mut self, params: EnrollParams, bumps: &EnrollBumps, subscriptions: &[AccountInfo]) -> Result<()> {
        require!(!self.config.paused, LateriteError::ProgramPaused);
        require_gt!(self.config.max_users, self.config.user_count, LateriteError::BetaFull);
        params.validate(&self.config)?;

        let mut accounts = subscriptions.iter();
        for payment_token in (0..PAYMENT_TOKEN_COUNT).filter(|i| params.payment_tokens & (1 << i) != 0) {
            let account = accounts.next().ok_or(LateriteError::SubscriptionMismatch)?;
            let plan = PLANS[payment_token][params.tier as usize];
            require!(is_subscription(account, plan, self.user.key()), LateriteError::SubscriptionMismatch);
        }

        let now = Clock::get()?.unix_timestamp;
        self.user_config.set_inner(UserConfig {
            user: self.user.key(),
            payer: self.payer.key(),
            tier: params.tier,
            payment_tokens: params.payment_tokens,
            asset: params.asset,
            engine: params.engine,
            engine_amount: params.engine_amount,
            income_rule: params.income_rule,
            change_multiplier: params.change_multiplier,
            cushions: params.cushions,
            enrolled_at: now,
            goal_amount: params.goal_amount,
            goal_label: params.goal_label,
            bump: bumps.user_config,
            week: 0,
            week_spent: 0,
            engine_ran_at: 0,
            pending: 0,
            status: UserStatus::Active,
            attestable_from: now,
        });
        self.config.user_count += 1;

        emit!(Enrolled {
            user: self.user.key(),
            tier: params.tier,
            payment_tokens: params.payment_tokens,
            asset: params.asset,
        });
        Ok(())
    }
}

/// The account is `user`'s live subscription to `plan`: owned by Subscriptions, at the address its stored bump
/// derives, and not yet cancelled.
fn is_subscription(account: &AccountInfo, plan: Pubkey, user: Pubkey) -> bool {
    if *account.owner != SUBSCRIPTIONS_ID {
        return false;
    }
    let Ok(data) = account.try_borrow_data() else {
        return false;
    };
    let Ok(subscription) = SubscriptionDelegation::from_bytes(&data) else {
        return false;
    };
    subscription.expires_at_ts == 0
        && SubscriptionDelegation::create_pda(plan, user, subscription.header.bump)
            .is_ok_and(|address| address == *account.key)
}

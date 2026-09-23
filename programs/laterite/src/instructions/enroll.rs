use anchor_lang::prelude::*;

use crate::{
    errors::LateriteError, events::Enrolled, subscription, Config, EnrollParams, UserConfig, UserStatus, CONFIG,
    PAYMENT_TOKEN_COUNT, USER_CONFIG_SEED,
};

#[derive(Accounts)]
pub struct Enroll<'info> {
    pub user: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        mut,
        address = CONFIG,
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
        subscription::require_live(subscriptions, params.payment_tokens, params.tier, self.user.key())?;

        let now = Clock::get()?.unix_timestamp;
        self.user_config.set_inner(UserConfig {
            user: self.user.key(),
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
            last_sweep_day: [0; PAYMENT_TOKEN_COUNT],
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

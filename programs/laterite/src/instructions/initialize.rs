use anchor_lang::prelude::*;

use crate::{
    errors::LateriteError, events::ConfigInitialized, program::Laterite, Config, ConfigParams, MarketCalendar,
    CONFIG_SEED, VAULT_SEED,
};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    #[account(constraint = program.programdata_address()? == Some(program_data.key()))]
    pub program: Program<'info, Laterite>,
    #[account(
        constraint = program_data.upgrade_authority_address == Some(authority.key()) @ LateriteError::NotUpgradeAuthority
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

impl Initialize<'_> {
    pub fn initialize(&mut self, params: ConfigParams, bumps: &InitializeBumps, mints: &[AccountInfo]) -> Result<()> {
        params.validate(mints)?;
        let (_, vault_bump) = Pubkey::find_program_address(&[VAULT_SEED], &crate::ID);
        self.config.set_inner(Config {
            admin: self.authority.key(),
            pending_admin: Pubkey::default(),
            paused: false,
            router: params.settings.router,
            attestor: params.settings.attestor,
            sponsor: params.settings.sponsor,
            user_weekly_cap: params.settings.user_weekly_cap,
            max_users: params.settings.max_users,
            user_count: 0,
            assets: params.assets,
            payment_tokens: params.payment_tokens,
            bump: bumps.config,
            vault_bump,
            market_calendar: MarketCalendar::default(),
        });
        emit!(ConfigInitialized { params });
        Ok(())
    }
}

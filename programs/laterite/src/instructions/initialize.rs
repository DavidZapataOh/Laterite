use anchor_lang::prelude::*;
use solana_sdk_ids::bpf_loader_upgradeable;

use crate::{
    errors::LateriteError, events::ConfigInitialized, Config, ConfigParams, MarketCalendar, CONFIG_SEED, PROGRAM_DATA,
};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(init, payer = authority, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Account<'info, Config>,
    /// CHECK: this program's data account, by address and owner; its upgrade authority is read in `initialize`.
    #[account(address = PROGRAM_DATA, owner = bpf_loader_upgradeable::ID)]
    pub program_data: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

impl Initialize<'_> {
    pub fn initialize(&mut self, params: ConfigParams, mints: &[AccountInfo]) -> Result<()> {
        require!(
            upgrade_authority(&self.program_data.try_borrow_data()?) == Some(self.authority.key()),
            LateriteError::NotUpgradeAuthority
        );
        params.validate(mints)?;
        self.config.set_inner(Config {
            admin: self.authority.key(),
            pending_admin: Pubkey::default(),
            paused: false,
            router: params.router,
            attestor: params.settings.attestor,
            sponsor: params.settings.sponsor,
            user_weekly_cap: params.settings.user_weekly_cap,
            max_users: params.settings.max_users,
            user_count: 0,
            assets: params.assets,
            payment_tokens: params.payment_tokens,
            market_calendar: MarketCalendar::default(),
            genesis_hash: params.genesis_hash,
        });
        emit!(ConfigInitialized { params });
        Ok(())
    }
}

/// The upgrade authority a `ProgramData` account holds: the loader's state tag 3, the deployment slot, then an optional
/// key, in bincode.
fn upgrade_authority(data: &[u8]) -> Option<Pubkey> {
    let (tag, rest) = data.split_first_chunk::<4>()?;
    let (option, key) = rest.get(8..41)?.split_first()?;
    (*tag == 3u32.to_le_bytes() && *option == 1).then(|| Pubkey::try_from(key).ok()).flatten()
}

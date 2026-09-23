use anchor_lang::prelude::*;

use crate::{
    errors::LateriteError,
    events::{AdminProposed, MarketCalendarSet, PausedSet, SettingsUpdated},
    Config, MarketCalendar, Settings, CONFIG_SEED, DAY_SECONDS,
};

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ LateriteError::Unauthorized)]
    pub config: Account<'info, Config>,
}

impl AdminOnly<'_> {
    pub fn update_config(&mut self, settings: Settings) -> Result<()> {
        settings.validate()?;
        self.config.apply(&settings);
        emit!(SettingsUpdated { settings });
        Ok(())
    }

    pub fn set_paused(&mut self, paused: bool) -> Result<()> {
        self.config.paused = paused;
        emit!(PausedSet { paused });
        Ok(())
    }

    pub fn set_market_calendar(
        &mut self,
        holidays: Vec<u16>,
        early_closes: Vec<u16>,
        valid_through: u16,
    ) -> Result<()> {
        let today = Clock::get()?.unix_timestamp.div_euclid(DAY_SECONDS);
        self.config.market_calendar = MarketCalendar::new(&holidays, &early_closes, valid_through, today)?;
        emit!(MarketCalendarSet { holidays, early_closes, valid_through });
        Ok(())
    }

    pub fn propose_admin(&mut self, new_admin: Pubkey) -> Result<()> {
        self.config.pending_admin = new_admin;
        emit!(AdminProposed { pending_admin: new_admin });
        Ok(())
    }
}

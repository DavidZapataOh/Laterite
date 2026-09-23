use anchor_lang::prelude::*;

use crate::{errors::LateriteError, events::AdminAccepted, Config, CONFIG};

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    pub pending_admin: Signer<'info>,
    #[account(mut, address = CONFIG, has_one = pending_admin @ LateriteError::NotPendingAdmin)]
    pub config: Account<'info, Config>,
}

impl AcceptAdmin<'_> {
    pub fn accept_admin(&mut self) -> Result<()> {
        self.config.admin = self.pending_admin.key();
        self.config.pending_admin = Pubkey::default();
        emit!(AdminAccepted { admin: self.config.admin });
        Ok(())
    }
}

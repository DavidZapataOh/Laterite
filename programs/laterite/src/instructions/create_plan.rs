use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};
use subscriptions::{
    instructions::CreatePlanCpiBuilder,
    types::{PlanData, PlanTerms},
    SUBSCRIPTIONS_ID,
};

use crate::{
    errors::LateriteError, events::PlanCreated, plan_id, Config, CONFIG_SEED, PLAN_PERIOD_HOURS, TIERS, VAULT_SEED,
};

#[derive(Accounts)]
pub struct CreatePlan<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ LateriteError::Unauthorized)]
    pub config: Account<'info, Config>,
    /// CHECK: the vault authority; it owns the plan and signs for it.
    #[account(mut, seeds = [VAULT_SEED], bump = config.vault_bump)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: created and validated by the Subscriptions program.
    #[account(mut)]
    pub plan: UncheckedAccount<'info>,
    pub mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    /// CHECK: address-constrained.
    #[account(address = SUBSCRIPTIONS_ID)]
    pub subscriptions_program: UncheckedAccount<'info>,
}

impl CreatePlan<'_> {
    pub fn create_plan(&mut self, payment_token: u8, tier: u8) -> Result<()> {
        let token = self.config.payment_tokens.get(payment_token as usize).ok_or(LateriteError::UnknownPaymentToken)?;
        let amount = *TIERS.get(tier as usize).ok_or(LateriteError::InvalidTier)?;
        require_keys_eq!(self.mint.key(), token.mint, LateriteError::UnknownPaymentToken);
        require_keys_eq!(self.token_program.key(), token.token_program, LateriteError::UnknownPaymentToken);

        let mut destinations = [Pubkey::default(); 4];
        destinations[0] = self.vault.key();
        let subscriptions_program = self.subscriptions_program.to_account_info();
        let vault = self.vault.to_account_info();
        let plan = self.plan.to_account_info();
        let mint = self.mint.to_account_info();
        let system_program = self.system_program.to_account_info();
        let token_program = self.token_program.to_account_info();
        let admin = self.admin.to_account_info();

        CreatePlanCpiBuilder::new(&subscriptions_program)
            .merchant(&vault)
            .plan_pda(&plan)
            .token_mint(&mint)
            .system_program(&system_program)
            .token_program(&token_program)
            .payer(Some(&admin))
            .plan_data(PlanData {
                plan_id: plan_id(payment_token as usize, tier as usize),
                mint: token.mint,
                terms: PlanTerms { amount, period_hours: PLAN_PERIOD_HOURS, created_at: 0 },
                end_ts: 0,
                destinations,
                pullers: [Pubkey::default(); 4],
                metadata_uri: [0; 128],
            })
            .invoke_signed(&[&[VAULT_SEED, &[self.config.vault_bump]]])?;

        emit!(PlanCreated { payment_token, tier, plan: self.plan.key() });
        Ok(())
    }
}

use anchor_lang::{
    prelude::*,
    solana_program::{
        instruction::Instruction,
        program::{invoke, invoke_signed},
    },
    InstructionData,
};
use anchor_spl::{
    token,
    token_2022::{
        self,
        spl_token_2022::{generic_token_account::GenericTokenAccount, state::Account as TokenAccount},
    },
};
use solana_sdk_ids::sysvar;
use subscriptions::{instructions::TransferSubscriptionCpiBuilder, types::TransferData, SUBSCRIPTIONS_ID};

use crate::{
    errors::LateriteError,
    events::Swept,
    min_out,
    pyth_lazer_solana_contract::{client as pyth, program::PythLazerSolanaContract},
    quote, subscription, us_market_open, Config, Engine, UserConfig, CONFIG, DAY_SECONDS, PLANS,
    SUBSCRIPTIONS_EVENT_AUTHORITY, SWAP_AUTHORITY, SWAP_AUTHORITY_BUMP, SWAP_SEED, USD_DECIMALS, VAULT, VAULT_BUMP,
    VAULT_SEED,
};

#[event_cpi]
#[derive(Accounts)]
pub struct Sweep<'info> {
    /// Pays the fees and Pyth Pro's verification fee.
    #[account(mut)]
    pub crank: Signer<'info>,
    #[account(address = CONFIG)]
    pub config: Box<Account<'info, Config>>,
    /// The swept user's settings. Only `enroll` creates one, at its user's address, so the account type alone identifies
    /// it; the accounts below are checked against the user it names.
    #[account(mut)]
    pub user_config: Box<Account<'info, UserConfig>>,
    /// CHECK: the vault authority, checked by address; it owns the plan and signs the pull.
    #[account(address = VAULT)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: Subscriptions checks it belongs to the plan and the user.
    #[account(mut)]
    pub subscription: UncheckedAccount<'info>,
    /// CHECK: compared with the plan the user's tier and the payment token derive.
    pub plan: UncheckedAccount<'info>,
    /// CHECK: Subscriptions checks it.
    pub subscription_authority: UncheckedAccount<'info>,
    /// CHECK: the user's account in the payment token; Subscriptions checks it is the canonical one.
    #[account(mut)]
    pub user_payment_account: UncheckedAccount<'info>,
    /// CHECK: the swap authority's account in the payment token, checked by program, mint and owner.
    #[account(mut)]
    pub swap_payment_account: UncheckedAccount<'info>,
    /// CHECK: the user's account in the asset, checked by program, mint and owner.
    #[account(mut)]
    pub user_asset_account: UncheckedAccount<'info>,
    /// CHECK: checked against the payment-token table.
    pub payment_mint: UncheckedAccount<'info>,
    /// CHECK: checked against the payment-token table.
    pub payment_token_program: UncheckedAccount<'info>,
    /// CHECK: checked by address.
    #[account(address = SUBSCRIPTIONS_ID)]
    pub subscriptions_program: UncheckedAccount<'info>,
    /// CHECK: checked by address.
    #[account(address = SUBSCRIPTIONS_EVENT_AUTHORITY)]
    pub subscriptions_event_authority: UncheckedAccount<'info>,
    /// CHECK: the swap authority, which receives the pull and alone signs the route.
    #[account(address = SWAP_AUTHORITY)]
    pub swap_authority: UncheckedAccount<'info>,
    /// CHECK: the only program the swap may call.
    #[account(address = config.router @ LateriteError::InvalidRouter)]
    pub router: UncheckedAccount<'info>,
    pub pyth_program: Program<'info, PythLazerSolanaContract>,
    /// CHECK: Pyth Pro checks its storage account and that the treasury is the stored one.
    pub pyth_storage: UncheckedAccount<'info>,
    /// CHECK: Pyth Pro checks it.
    #[account(mut)]
    pub pyth_treasury: UncheckedAccount<'info>,
    /// CHECK: checked by address; Pyth Pro reads the ed25519 instruction from it.
    #[account(address = sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

impl<'info> Sweep<'info> {
    pub fn sweep(
        &mut self,
        asset_message: Vec<u8>,
        payment_message: Vec<u8>,
        ed25519_index: u16,
        payment_token: u8,
        route: Vec<u8>,
        route_accounts: &[AccountInfo<'info>],
    ) -> Result<Swept> {
        let config = &self.config;
        require!(!config.paused, LateriteError::ProgramPaused);
        let index = usize::from(payment_token);
        let token = *config.payment_tokens.get(index).ok_or(LateriteError::UnknownPaymentToken)?;
        let user_config = &self.user_config;
        let now = Clock::get()?.unix_timestamp;
        let today = now.div_euclid(DAY_SECONDS) as u32;
        require_gt!(today, user_config.last_sweep_day[index], LateriteError::AlreadySwept);
        // A weekly user buys only during a regular NYSE session, pending amounts included.
        require!(
            user_config.engine != Engine::Weekly || us_market_open(now, &config.market_calendar),
            LateriteError::NothingToSweep
        );
        let balance = amount(&self.user_payment_account)?;
        let pull = user_config.pull(index, balance, config.user_weekly_cap, &config.market_calendar, now);
        require_gt!(pull.total(), 0, LateriteError::NothingToSweep);

        require!(user_config.payment_tokens & (1 << index) != 0, LateriteError::UnknownPaymentToken);
        require_keys_eq!(self.payment_mint.key(), token.mint, LateriteError::UnknownPaymentToken);
        require_keys_eq!(self.payment_token_program.key(), token.token_program, LateriteError::UnknownPaymentToken);
        require_keys_eq!(
            self.plan.key(),
            PLANS[index][usize::from(user_config.tier)],
            LateriteError::SubscriptionMismatch
        );
        // After a tier change, a reactivation or an added token, the subscription's period no longer starts with the
        // user's week, so it can allow less than the week does.
        let pull = pull.capped(subscription::remaining(&self.subscription, now));
        let total = pull.total();
        require_gt!(total, 0, LateriteError::NothingToSweep);
        let asset = *config.assets.get(usize::from(user_config.asset)).ok_or(LateriteError::UnknownAsset)?;
        let user = user_config.user;
        require!(
            is_token_account(&self.user_asset_account, &asset.token_program, &asset.mint, &user)
                && is_token_account(&self.swap_payment_account, &token.token_program, &token.mint, &SWAP_AUTHORITY),
            LateriteError::InvalidTokenAccount
        );

        let asset_quote = quote(&asset_message, asset.pyth_feed_id, now)?;
        let payment_quote = quote(&payment_message, token.usd_feed_id, now)?;
        let minimum = min_out(total, payment_quote, USD_DECIMALS, asset_quote, asset.decimals)?;
        self.verify_price(asset_message, ed25519_index, 0)?;
        // `quote` accepts an empty payment update only for a token counted at one dollar.
        if !payment_message.is_empty() {
            self.verify_price(payment_message, ed25519_index, 1)?;
        }

        // The route is the caller's and only the swap authority signs it, never the plans' owner, so only its outcome
        // is trusted: every swap-authority token account it can write, and the payment account the pull fills, must
        // end the sweep exactly as it started, data and length.
        let swap_accounts: Vec<_> = core::iter::once(self.swap_payment_account.as_ref())
            .chain(route_accounts.iter().filter(|account| account.is_writable && is_swap_token_account(account)))
            .map(|account| Ok((account, account.try_borrow_data()?.to_vec())))
            .collect::<Result<_>>()?;
        let asset_before = amount(&self.user_asset_account)?;
        TransferSubscriptionCpiBuilder::new(&self.subscriptions_program)
            .subscription_pda(&self.subscription)
            .plan_pda(&self.plan)
            .subscription_authority(&self.subscription_authority)
            .delegator_ata(&self.user_payment_account)
            .receiver_ata(&self.swap_payment_account)
            .caller(&self.vault)
            .token_mint(&self.payment_mint)
            .token_program(&self.payment_token_program)
            .event_authority(&self.subscriptions_event_authority)
            .self_program(&self.subscriptions_program)
            .transfer_data(TransferData { amount: total, delegator: user, mint: token.mint })
            .invoke_signed(&[&[VAULT_SEED, &[VAULT_BUMP]]])?;

        let accounts = route_accounts
            .iter()
            .map(|account| AccountMeta {
                pubkey: account.key(),
                is_signer: account.key() == SWAP_AUTHORITY,
                is_writable: account.is_writable,
            })
            .collect();
        let swap = Instruction { program_id: self.router.key(), accounts, data: route };
        invoke_signed(&swap, route_accounts, &[&[SWAP_SEED, &[SWAP_AUTHORITY_BUMP]]])?;

        for (account, before) in &swap_accounts {
            require!(account.try_borrow_data()?[..] == before[..], LateriteError::SwapAccountChanged);
        }
        // Nor may the route leave a new token account under the swap authority.
        require!(
            route_accounts
                .iter()
                .filter(|account| account.is_writable && is_swap_token_account(account))
                .all(|account| swap_accounts.iter().any(|(watched, _)| watched.key == account.key)),
            LateriteError::SwapAccountChanged
        );
        let received = amount(&self.user_asset_account)?.saturating_sub(asset_before);
        require_gte!(received, minimum, LateriteError::SlippageExceeded);

        let user_config = &mut self.user_config;
        user_config.record(pull, now);
        user_config.last_sweep_day[index] = today;
        Ok(Swept {
            user,
            payment_token,
            asset: user_config.asset,
            engine: pull.engine,
            pending: pull.pending,
            asset_price: asset_quote.price,
            asset_exponent: asset_quote.exponent,
            received,
            min_out: minimum,
        })
    }

    /// Pyth Pro's `verify_message` for an update in this instruction's data, signature entry `signature_index` of
    /// the ed25519 instruction at `ed25519_index`.
    fn verify_price(&self, message: Vec<u8>, ed25519_index: u16, signature_index: u8) -> Result<()> {
        // Built by hand: the generated `cpi::verify_message` also copies the returned message into a buffer the sweep
        // never reads.
        let verify = Instruction {
            program_id: self.pyth_program.key(),
            accounts: pyth::accounts::VerifyMessage {
                payer: self.crank.key(),
                storage: self.pyth_storage.key(),
                treasury: self.pyth_treasury.key(),
                system_program: self.system_program.key(),
                instructions_sysvar: self.instructions.key(),
            }
            .to_account_metas(None),
            data: pyth::args::VerifyMessage {
                message_data: message,
                ed25519_instruction_index: ed25519_index,
                signature_index,
            }
            .data(),
        };
        let accounts = [
            self.crank.to_account_info(),
            self.pyth_storage.to_account_info(),
            self.pyth_treasury.to_account_info(),
            self.system_program.to_account_info(),
            self.instructions.to_account_info(),
        ];
        invoke(&verify, &accounts)?;
        Ok(())
    }
}

/// The account is a Token or Token-2022 account that the swap authority owns.
fn is_swap_token_account(account: &AccountInfo) -> bool {
    (*account.owner == token::ID || *account.owner == token_2022::ID)
        && account
            .try_borrow_data()
            .is_ok_and(|data| TokenAccount::unpack_account_owner(&data) == Some(&SWAP_AUTHORITY))
}

/// A token account's raw `amount`, at the same offset under Token and Token-2022.
fn amount(account: &AccountInfo) -> Result<u64> {
    let data = account.try_borrow_data()?;
    let bytes = data.get(64..72).and_then(|bytes| bytes.first_chunk()).ok_or(LateriteError::InvalidTokenAccount)?;
    Ok(u64::from_le_bytes(*bytes))
}

/// The account is an initialized `token_program` account in `mint` that `owner` owns.
fn is_token_account(account: &AccountInfo, token_program: &Pubkey, mint: &Pubkey, owner: &Pubkey) -> bool {
    account.owner == token_program
        && account.try_borrow_data().is_ok_and(|data| {
            TokenAccount::unpack_account_mint(&data) == Some(mint)
                && TokenAccount::unpack_account_owner(&data) == Some(owner)
        })
}

//! Users' subscriptions to the vault's plans: whether one is live, what its current period still allows, and ending
//! one at once.

use anchor_lang::prelude::*;
use subscriptions::{
    instructions::CancelSubscriptionNowCpiBuilder, types::CancelSubscriptionNowData, SubscriptionDelegation,
    SUBSCRIPTIONS_ID,
};

use crate::{errors::LateriteError, Cancellation, PAYMENT_TOKEN_COUNT, PLANS, VAULT_BUMP, VAULT_SEED};

fn read(account: &AccountInfo) -> Option<SubscriptionDelegation> {
    if *account.owner != SUBSCRIPTIONS_ID {
        return None;
    }
    SubscriptionDelegation::from_bytes(&account.try_borrow_data().ok()?).ok()
}

/// The account is `user`'s live subscription to `plan`: owned by Subscriptions, at the address its stored bump
/// derives, and not cancelled.
pub fn is_live(account: &AccountInfo, plan: Pubkey, user: Pubkey) -> bool {
    read(account).is_some_and(|subscription| {
        subscription.expires_at_ts == 0
            && SubscriptionDelegation::create_pda(plan, user, subscription.header.bump)
                .is_ok_and(|address| address == *account.key)
    })
}

/// `subscriptions` holds `user`'s live subscription to the tier's plan for each payment token in `payment_tokens`, in
/// token order.
pub fn require_live(subscriptions: &[AccountInfo], payment_tokens: u8, tier: u8, user: Pubkey) -> Result<()> {
    let mut accounts = subscriptions.iter();
    for payment_token in (0..PAYMENT_TOKEN_COUNT).filter(|i| payment_tokens & (1 << i) != 0) {
        let account = accounts.next().ok_or(LateriteError::SubscriptionMismatch)?;
        let plan = PLANS[payment_token][usize::from(tier)];
        require!(is_live(account, plan, user), LateriteError::SubscriptionMismatch);
    }
    Ok(())
}

/// What the subscription account still lets its plan's owner pull in the current period at `now`: 0 once it has
/// expired, or when the account is not a subscription.
pub fn remaining(account: &AccountInfo, now: i64) -> u64 {
    let Some(subscription) = read(account) else {
        return 0;
    };
    let expired = subscription.expires_at_ts != 0 && now >= subscription.expires_at_ts;
    let period = subscription.terms.period_hours.saturating_mul(3_600);
    let elapsed = now.saturating_sub(subscription.current_period_start_ts);
    if expired {
        0
    } else if u64::try_from(elapsed).is_ok_and(|elapsed| elapsed >= period) {
        subscription.terms.amount
    } else {
        subscription.terms.amount.saturating_sub(subscription.amount_pulled_in_period)
    }
}

impl<'info> Cancellation<'info> {
    /// Ends the user's subscription to `plan` now, the vault signing as the plans' owner. `plan_account` and
    /// `subscription` must be that plan and the subscription's derived address, so no other subscription can be named.
    /// One already closed or expired is left alone, so a user who ended it through Subscriptions can still exit or
    /// change plans.
    pub fn cancel(
        &self,
        plan: Pubkey,
        plan_account: &AccountInfo<'info>,
        subscription: &AccountInfo<'info>,
        now: i64,
    ) -> Result<()> {
        require_keys_eq!(plan_account.key(), plan, LateriteError::SubscriptionMismatch);
        let user = self.user.key();
        let state = read(subscription);
        // Subscriptions creates every subscription at its canonical address, so a live one's stored bump proves the
        // address; an account it does not hold is proven by the search before it is skipped.
        let at_address = match &state {
            Some(state) => SubscriptionDelegation::create_pda(plan, user, state.header.bump)
                .is_ok_and(|address| address == *subscription.key),
            None => SubscriptionDelegation::find_pda(&plan, &user).0 == *subscription.key,
        };
        require!(at_address, LateriteError::SubscriptionMismatch);
        let Some(state) = state else {
            return Ok(());
        };
        if state.expires_at_ts != 0 && state.expires_at_ts <= now {
            return Ok(());
        }
        CancelSubscriptionNowCpiBuilder::new(&self.subscriptions_program)
            .subscriber(&self.user)
            .merchant(&self.vault)
            .plan_pda(plan_account)
            .subscription_pda(subscription)
            .event_authority(&self.subscriptions_event_authority)
            .self_program(&self.subscriptions_program)
            .cancel_subscription_now_data(CancelSubscriptionNowData {
                expected_current_period_start_ts: state.current_period_start_ts,
            })
            .invoke_signed(&[&[VAULT_SEED, &[VAULT_BUMP]]])?;
        Ok(())
    }
}

mod common;

use {
    anchor_lang::solana_program::pubkey::Pubkey,
    common::*,
    laterite::{plan_id, LateriteError, PLANS, PLAN_PERIOD_HOURS, TIERS, VAULT},
    solana_signer::Signer,
    subscriptions::Plan,
};

#[test]
fn the_four_plans_belong_to_and_pay_into_the_vault() {
    let env = with_plans();
    let params = valid_params();
    assert_eq!(VAULT, vault_address());
    for (payment_token, plans) in PLANS.iter().enumerate() {
        for (tier, &amount) in TIERS.iter().enumerate() {
            assert_eq!(plans[tier], plan_address(payment_token, tier));
            let account = env.svm.get_account(&plan_address(payment_token, tier)).unwrap();
            let plan = Plan::from_bytes(&account.data).unwrap();
            assert_eq!(plan.owner, vault_address());
            assert_eq!(plan.data.plan_id, plan_id(payment_token, tier));
            assert_eq!(plan.data.mint, params.payment_tokens[payment_token].mint);
            assert_eq!(plan.data.terms.amount, amount);
            assert_eq!(plan.data.terms.period_hours, PLAN_PERIOD_HOURS);
            assert_eq!(plan.data.destinations[0], vault_address());
            assert_eq!(plan.data.destinations[1..], [Pubkey::default(); 3]);
            assert_eq!(plan.data.pullers, [Pubkey::default(); 4]);
            assert_eq!(plan.data.end_ts, 0);
        }
    }
}

#[test]
fn only_the_admin_creates_plans() {
    let mut env = initialized();
    let intruder = funded(&mut env.svm);
    let failure = send(&mut env.svm, &intruder, create_plan_ix(intruder.pubkey(), 0, 0), &[]).unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::Unauthorized.into()));
}

#[test]
fn the_mint_must_be_the_payment_tokens() {
    let mut env = initialized();
    let admin = env.authority.insecure_clone();
    let mut instruction = create_plan_ix(admin.pubkey(), 0, 0);
    // Swap in USDT's mint for the USDC plan.
    instruction.accounts[4].pubkey = valid_params().payment_tokens[1].mint;
    let failure = send(&mut env.svm, &admin, instruction, &[]).unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::UnknownPaymentToken.into()));

    // Swap in Token-2022 for the USDC plan's token program.
    let mut instruction = create_plan_ix(admin.pubkey(), 0, 0);
    instruction.accounts[5].pubkey = anchor_spl::token_2022::ID;
    let failure = send(&mut env.svm, &admin, instruction, &[]).unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::UnknownPaymentToken.into()));
}

#[test]
fn unknown_indices_are_rejected() {
    let mut env = initialized();
    let admin = env.authority.insecure_clone();
    let failure = send(&mut env.svm, &admin, create_plan_ix(admin.pubkey(), 2, 0), &[]).unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::UnknownPaymentToken.into()));
    let failure = send(&mut env.svm, &admin, create_plan_ix(admin.pubkey(), 0, 2), &[]).unwrap_err();
    assert_eq!(custom_code(&failure), Some(LateriteError::InvalidTier.into()));
}

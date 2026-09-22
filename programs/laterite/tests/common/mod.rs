#![allow(dead_code, clippy::result_large_err)]

use {
    anchor_lang::{
        solana_program::{
            bpf_loader_upgradeable,
            instruction::{AccountMeta, Instruction},
            pubkey::Pubkey,
        },
        system_program, AccountDeserialize, InstructionData, ToAccountMetas,
    },
    laterite::{Asset, Config, ConfigParams, PaymentToken, Settings, CONFIG_SEED},
    litesvm::{
        types::{FailedTransactionMetadata, TransactionMetadata},
        LiteSVM,
    },
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::{versioned::VersionedTransaction, InstructionError, TransactionError},
};

pub const PROGRAM: &[u8] = include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/laterite.so"));

const TOKEN: Pubkey = anchor_spl::token::ID;
const TOKEN_2022: Pubkey = anchor_spl::token_2022::ID;

pub struct Env {
    pub svm: LiteSVM,
    pub authority: Keypair,
}

/// The program deployed as upgradeable with `authority` as its upgrade authority.
pub fn setup() -> Env {
    let mut svm = LiteSVM::new();
    let authority = Keypair::new();
    svm.airdrop(&authority.pubkey(), 10_000_000_000).unwrap();
    svm.airdrop(&sponsor().pubkey(), 10_000_000_000).unwrap();
    deploy_with_authority(&mut svm, laterite::ID, authority.pubkey());

    let params = valid_params();
    for asset in params.assets {
        write_mint(&mut svm, asset.mint, asset.token_program, asset.decimals);
    }
    for token in params.payment_tokens {
        write_mint(&mut svm, token.mint, token.token_program, token.decimals);
    }

    Env { svm, authority }
}

/// A token mint without extensions; its layout is the same under Token and Token-2022.
pub fn write_mint(svm: &mut LiteSVM, mint: Pubkey, token_program: Pubkey, decimals: u8) {
    svm.airdrop(&mint, 1_000_000_000).unwrap();
    let mut account = svm.get_account(&mint).unwrap();
    // Mint: mint authority (36) | supply (8) | decimals | is_initialized | freeze authority (36)
    let mut data = vec![0; 82];
    data[44] = decimals;
    data[45] = 1;
    account.data = data;
    account.owner = token_program;
    svm.set_account(mint, account).unwrap();
}

/// The sponsor key `valid_params()` configures; fixed, so every test knows it.
pub fn sponsor() -> Keypair {
    Keypair::new_from_array([7; 32])
}

pub fn funded(svm: &mut LiteSVM) -> Keypair {
    let keypair = Keypair::new();
    svm.airdrop(&keypair.pubkey(), 10_000_000_000).unwrap();
    keypair
}

pub fn send(
    svm: &mut LiteSVM,
    payer: &Keypair,
    instruction: Instruction,
    signers: &[&Keypair],
) -> Result<TransactionMetadata, FailedTransactionMetadata> {
    let message = Message::new_with_blockhash(&[instruction], Some(&payer.pubkey()), &svm.latest_blockhash());
    let mut all = vec![payer];
    all.extend_from_slice(signers);
    let transaction = VersionedTransaction::try_new(VersionedMessage::Legacy(message), &all).unwrap();
    let result = svm.send_transaction(transaction);
    svm.expire_blockhash();
    result
}

pub fn config_address() -> Pubkey {
    Pubkey::find_program_address(&[CONFIG_SEED], &laterite::ID).0
}

pub fn program_data_address() -> Pubkey {
    program_data_address_for(laterite::ID)
}

pub fn program_data_address_for(program_id: Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[program_id.as_ref()], &bpf_loader_upgradeable::ID).0
}

/// Deploys `PROGRAM` under `program_id` with `authority` as its upgrade authority; returns its ProgramData address.
pub fn deploy_with_authority(svm: &mut LiteSVM, program_id: Pubkey, authority: Pubkey) -> Pubkey {
    svm.add_program(program_id, PROGRAM).unwrap();
    let program_data = program_data_address_for(program_id);
    let mut account = svm.get_account(&program_data).unwrap();
    // ProgramData metadata: u32 tag | u64 slot | Option<Pubkey> at offset 12.
    account.data[12] = 1;
    account.data[13..45].copy_from_slice(authority.as_ref());
    svm.set_account(program_data, account).unwrap();
    program_data
}

/// Mainnet SPYx and QQQx, USDC and USDT, Pyth Pro ids, Jupiter as router.
pub fn valid_params() -> ConfigParams {
    let asset = |mint: &str, pyth_feed_id| Asset {
        mint: mint.parse().unwrap(),
        token_program: TOKEN_2022,
        decimals: 8,
        pyth_feed_id,
    };
    let payment = |mint: &str, usd_feed_id| PaymentToken {
        mint: mint.parse().unwrap(),
        token_program: TOKEN,
        decimals: 6,
        usd_feed_id,
    };
    ConfigParams {
        settings: Settings {
            router: "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4".parse().unwrap(),
            attestor: Keypair::new().pubkey(),
            sponsor: sponsor().pubkey(),
            user_weekly_cap: 25_000_000,
            max_users: 100,
        },
        assets: [
            asset("XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W", 1843),
            asset("Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ", 1837),
        ],
        payment_tokens: [
            payment("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", 0),
            payment("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", 8),
        ],
    }
}

pub fn initialize_ix(authority: Pubkey, params: ConfigParams) -> Instruction {
    let mut accounts = laterite::accounts::Initialize {
        authority,
        config: config_address(),
        program: laterite::ID,
        program_data: program_data_address(),
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    let mints = params.assets.iter().map(|a| a.mint).chain(params.payment_tokens.iter().map(|t| t.mint));
    accounts.extend(mints.map(|mint| AccountMeta::new_readonly(mint, false)));
    Instruction { program_id: laterite::ID, accounts, data: laterite::instruction::Initialize { params }.data() }
}

/// `setup()` plus an initialized config.
pub fn initialized() -> Env {
    let mut env = setup();
    let authority = env.authority.insecure_clone();
    send(&mut env.svm, &authority, initialize_ix(authority.pubkey(), valid_params()), &[]).unwrap();
    env
}

pub fn fetch_config(svm: &LiteSVM) -> Config {
    let account = svm.get_account(&config_address()).unwrap();
    Config::try_deserialize(&mut account.data.as_slice()).unwrap()
}

pub fn custom_code(failure: &FailedTransactionMetadata) -> Option<u32> {
    match failure.err {
        TransactionError::InstructionError(_, InstructionError::Custom(code)) => Some(code),
        _ => None,
    }
}

fn admin_accounts(admin: Pubkey) -> Vec<anchor_lang::solana_program::instruction::AccountMeta> {
    laterite::accounts::AdminOnly { admin, config: config_address() }.to_account_metas(None)
}

pub fn update_config_ix(admin: Pubkey, settings: Settings) -> Instruction {
    Instruction {
        program_id: laterite::ID,
        accounts: admin_accounts(admin),
        data: laterite::instruction::UpdateConfig { settings }.data(),
    }
}

pub fn set_paused_ix(admin: Pubkey, paused: bool) -> Instruction {
    Instruction {
        program_id: laterite::ID,
        accounts: admin_accounts(admin),
        data: laterite::instruction::SetPaused { paused }.data(),
    }
}

pub fn propose_admin_ix(admin: Pubkey, new_admin: Pubkey) -> Instruction {
    Instruction {
        program_id: laterite::ID,
        accounts: admin_accounts(admin),
        data: laterite::instruction::ProposeAdmin { new_admin }.data(),
    }
}

pub fn accept_admin_ix(pending_admin: Pubkey) -> Instruction {
    Instruction {
        program_id: laterite::ID,
        accounts: laterite::accounts::AcceptAdmin { pending_admin, config: config_address() }.to_account_metas(None),
        data: laterite::instruction::AcceptAdmin {}.data(),
    }
}

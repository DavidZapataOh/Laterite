use laterite::Quote;
use solana_pubkey::Pubkey;

pub const FIXTURES: &str = "../../programs/laterite/tests/fixtures";
pub const PROGRAM: &str = "../../target/deploy/laterite.so";
/// The program tests' router, which runs the instructions its data encodes: every fuzzed route goes through it, so a
/// route can be an honest swap or a swap with anything a hostile venue could add.
pub const ROUTER_PROGRAM: &str = "../../target/deploy/test_router.so";
pub const ROUTER: Pubkey = Pubkey::new_from_array([42; 32]);
pub const NYSE_CALENDAR: &str = "../../programs/laterite/data/nyse-calendar.json";

pub const TOKEN: Pubkey = crucible_fuzzer::anchor_spl::token::ID;
pub const TOKEN_2022: Pubkey = crucible_fuzzer::anchor_spl::token_2022::ID;
pub const ATA_PROGRAM: Pubkey = Pubkey::from_str_const("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
pub const ED25519_PROGRAM: Pubkey = Pubkey::from_str_const("Ed25519SigVerify111111111111111111111111111");
pub const INSTRUCTIONS_SYSVAR: Pubkey = Pubkey::from_str_const("Sysvar1nstructions1111111111111111111111111");

/// Our devnet Raydium CPMM and the devnet accounts copied from `tests/fixtures/devnet`.
pub const CPMM: Pubkey = Pubkey::from_str_const("GVSWUkxEj83o4xmcNRDc4p6wSTE7mB3g8BXZRXq8Wcx3");
pub const CPMM_CONFIG: Pubkey = Pubkey::from_str_const("8zfcVMo8dgJZUECxJELLrPNjAfK7CeC8o9hYgYGPsyQQ");
pub const SPYX: Pubkey = Pubkey::from_str_const("Av85xasqSyE6KfyW85h1RJXBs631sExR5ncFoHhtEDnU");
pub const QQQX: Pubkey = Pubkey::from_str_const("8zYS2UR5aFM6PxDWsEjyRWHsco1PSxHubDC8pSetwxcN");
pub const USDC: Pubkey = Pubkey::from_str_const("GHxn9udETkoqKzXgeqk24gT2RzptcjTo2p9WtWxo618c");
pub const USDT: Pubkey = Pubkey::from_str_const("J2jptCQwMHYw6PK5qdGVmd85SYU4FxUGk1tViJ18WG4x");
pub const ASSETS: [Pubkey; 2] = [SPYX, QQQX];
pub const PAYMENT_MINTS: [Pubkey; 2] = [USDC, USDT];
pub const FEEDS: [u32; 2] = [1843, 1837];
pub const USDT_FEED: u32 = 8;

/// A CPMM pool: token 0 is the asset, token 1 the payment token.
pub struct Pool {
    pub address: Pubkey,
    pub observation: Pubkey,
    pub asset_vault: Pubkey,
    pub payment_vault: Pubkey,
    pub asset_mint: Pubkey,
    pub payment_mint: Pubkey,
}

pub const POOLS: [Pool; 3] = [
    Pool {
        address: Pubkey::from_str_const("DgyosfpJ2cxnm1mAoB4mgE2XSwKCJJR6jjD9stsCaLTP"),
        observation: Pubkey::from_str_const("4XxfjDUvQxQ5zUk42B23hJFN9fx4baCDC2gAMLrwGxmz"),
        asset_vault: Pubkey::from_str_const("9kxJhx8xjATHKznRdtn3k9NJNqUkCMgrWw7Lh2iunYUZ"),
        payment_vault: Pubkey::from_str_const("E54M3Mnyk9sxuNz8SQ4ddhjj48kUwZYrnwioPFmgTTF3"),
        asset_mint: SPYX,
        payment_mint: USDC,
    },
    Pool {
        address: Pubkey::from_str_const("DVksHcPfMUttsUtoT8EwSHHVmNYyM6Lr9EHr8oQbRMkm"),
        observation: Pubkey::from_str_const("5DwKvikLgTsAC44gMbvPib29A1W8CzY1x14CM4n1jnFc"),
        asset_vault: Pubkey::from_str_const("CRarcATyPyjGkBnpNBW1agwsTcYQKPFGSM2kPQBQoQ5k"),
        payment_vault: Pubkey::from_str_const("9w91fL95LatF9L8seod2fJxp2Kw5PCje2ShNGpnAXUkf"),
        asset_mint: SPYX,
        payment_mint: USDT,
    },
    Pool {
        address: Pubkey::from_str_const("5YQMCKnFmVxiNhnJvPJFjecFtUvF4dx9oRz9r7gmNZXP"),
        observation: Pubkey::from_str_const("8xndDN7YyqZsVnbJ94Ap9Y3vRrKiCqrKAKNT5ic1e7sB"),
        asset_vault: Pubkey::from_str_const("7BM6mfhSVjFjjmqr7YKaqhhiaL4up7CPxxKNhLYShrbk"),
        payment_vault: Pubkey::from_str_const("5ttnh7ZizzBYiS46Ngjq4yL7TJXEdxQcMFaTNznXMcCd"),
        asset_mint: QQQX,
        payment_mint: USDC,
    },
];

/// Devnet's Pyth Pro, its storage account and the treasury the storage names; the fuzz trusts one more signer for the
/// updates it composes.
pub const PYTH_PRO: Pubkey = Pubkey::from_str_const("pytd2yyk641x7ak7mkaasSJVXh6YYZnC7wTmtgAyxPt");
pub const PYTH_STORAGE: Pubkey = Pubkey::from_str_const("3rdJbqfnagQ4yx9HXJViD4zc4xpiSqmFsKpPuSCQVyQL");
pub const PYTH_TREASURY: Pubkey = Pubkey::from_str_const("opsLibxVY7Vz5eYMmSfX8cLFCFVYTtH6fr6MiifMpA7");
/// The real updates' SPYX/USD and QQQX/USD quotes, and USDT/USD's.
pub const QUOTES: [Quote; 2] = [
    Quote { price: 77_847_155_496, confidence: 30_532_893, exponent: -8 },
    Quote { price: 74_597_430_644, confidence: 40_282_152, exponent: -8 },
];
pub const USDT_QUOTE: Quote = Quote { price: 99_972_708, confidence: 7_028, exponent: -8 };

/// Devnet's genesis hash, which the deployment signs attestations for, and mainnet's, which it must refuse.
pub const DEVNET_GENESIS_HASH: [u8; 32] =
    Pubkey::from_str_const("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG").to_bytes();
pub const MAINNET_GENESIS_HASH: [u8; 32] =
    Pubkey::from_str_const("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d").to_bytes();

/// When the setup deploys: the real updates' time, Tuesday 2026-09-22 at 02:26 UTC, after the devnet pools opened.
pub const SETUP_TS: i64 = 1_790_043_964;
/// When the fuzzing starts, Wednesday 2026-09-30 at 00:26 UTC: the last user's week has rolled over, while the
/// subscription it added a day after enrolling is in its first period until 02:26 UTC that day.
pub const START_TS: i64 = SETUP_TS + 7 * 86_400 + 22 * 3_600;
pub const SLOTS_PER_SECOND: i64 = 2;
pub const LAMPORTS: u64 = 100_000_000_000;
/// Each payment-token account starts with $100.
pub const INITIAL_BALANCE: u64 = 100_000_000;
/// Asset held by each pool: 1,000 whole tokens.
pub const POOL_DEPTH: u64 = 1_000 * 100_000_000;

pub const USERS: usize = 5;
pub const ATTESTOR_SEEDS: [u8; 2] = [9, 10];
pub const SPONSOR_SEEDS: [u8; 2] = [7, 8];
pub const ADMIN_SEED: u8 = 1;
pub const STRANGER_SEED: u8 = 2;
pub const CRANK_SEED: u8 = 3;
pub const PYTH_SIGNER_SEED: u8 = 5;
pub const USER_SEEDS: [u8; USERS] = [11, 12, 13, 15, 16];
/// An empty token-program account a hostile route may initialize for the swap authority.
pub const FRESH: Pubkey = Pubkey::new_from_array([14; 32]);

/// Subscriptions' error when a pull exceeds what the period still allows.
pub const AMOUNT_EXCEEDS_PERIOD_LIMIT: u32 = 400;
/// Subscriptions' sentinel for an authority created in the same slot as the subscription.
pub const UNKNOWN_INIT_ID: i64 = i64::MIN;

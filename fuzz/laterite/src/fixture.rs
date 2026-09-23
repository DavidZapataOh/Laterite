use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use crucible_fuzzer::anchor_lang::{solana_program::instruction::Instruction, AccountDeserialize, InstructionData};
use crucible_fuzzer::anchor_spl::token_2022::spl_token_2022::instruction as token_instruction;
use crucible_fuzzer::*;
use crucible_test_context::TxOutcome;
use laterite::{
    min_out, quote, Attestation, Config, ConfigParams, Engine, EnrollParams, EventKind, Pull, Quote, Settings,
    UserConfig, UserStatus, CONFIG, PLANS, SWAP_AUTHORITY, TIERS, VAULT,
};
use solana_account::Account;
use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;
use subscriptions::SUBSCRIPTIONS_ID;

use crate::constants::*;
use crate::helpers::*;
use crate::session::Calendar;

/// What the invariants read after each action.
#[derive(Clone)]
pub struct State {
    pub now: i64,
    pub config: Config,
    pub config_data: Vec<u8>,
    pub users: [UserConfig; USERS],
    pub user_data: [Vec<u8>; USERS],
    /// Per user: USDC and USDT, then SPYx and QQQx.
    pub balances: [[u64; 4]; USERS],
    /// The swap authority's token accounts and the account a route could initialize for it (`swap_accounts`).
    pub swap: [Option<Vec<u8>>; 5],
    /// Each payment token's plans by tier.
    pub plans: [[Option<Vec<u8>>; 2]; 2],
    /// Per user, payment token and tier.
    pub subscriptions: [[[Option<Vec<u8>>; 2]; 2]; USERS],
}

/// A transfer as its attestation record identifies it: user, transaction signature, transfer index.
pub type Transfer = (usize, [u8; 64], u16);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Control {
    /// `counts_more`: the rule turned on or the multiplier raised, which raises `attestable_from`.
    UpdateSettings {
        counts_more: bool,
    },
    Pause(bool),
    LowerPending(u64),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Admin {
    UpdateConfig,
    SetPaused,
    Propose,
    Accept,
    SetCalendar,
}

/// The last action and what it expected, for the invariants to judge the state change.
#[derive(Clone, Debug, Default)]
pub enum Last {
    #[default]
    Other,
    Enroll {
        ok: bool,
    },
    Attest {
        user: usize,
        attestation: Attestation,
        mutated: bool,
        ok: bool,
    },
    CloseAttestation {
        expires_at: Option<i64>,
        to_payer: bool,
        gain: u64,
        rent: u64,
        ok: bool,
    },
    Sweep {
        user: usize,
        token: usize,
        /// What the amount engine gives, within what the subscription's current period allows.
        pull: Pull,
        native: u64,
        /// The minimum the two updates' quotes allow, when both are usable.
        minimum: Option<u64>,
        /// Every update the sweep needs is present, trusted and pointed at by its own signature entry.
        honest_updates: bool,
        code: Option<u32>,
        ok: bool,
    },
    Control {
        signer: usize,
        target: usize,
        control: Control,
        ok: bool,
    },
    TierChange {
        user: usize,
        ok: bool,
    },
    TokensChange {
        user: usize,
        ok: bool,
    },
    Exit {
        user: usize,
        ok: bool,
    },
    Reactivate {
        user: usize,
        /// The configured sponsor named and signing.
        sponsored: bool,
        ok: bool,
    },
    Subscriptions {
        user: usize,
    },
    Admin {
        signer: Pubkey,
        admin: Admin,
        ok: bool,
    },
}

#[derive(Clone)]
pub struct Fixture {
    pub ctx: TestContext,
    pub admin: Rc<Keypair>,
    pub stranger: Rc<Keypair>,
    pub crank: Rc<Keypair>,
    pub pyth_signer: Rc<Keypair>,
    pub users: Vec<Rc<Keypair>>,
    pub attestors: Vec<Rc<Keypair>>,
    pub sponsors: Vec<Rc<Keypair>>,
    pub params: ConfigParams,
    pub before: State,
    pub after: State,
    pub last: Last,
    /// Every transfer the attestor has observed, as it attests it.
    pub transfers: HashMap<Transfer, Attestation>,
    /// Transfers that added to a user's pending amount.
    pub counted: HashSet<Transfer>,
    /// Attestation records created, with their payer.
    pub records: Vec<(Pubkey, Pubkey)>,
    /// Pulled per (user, week from enrollment).
    pub week_pulls: HashMap<(usize, u32), u64>,
    /// Successful sweeps per (user, payment token, UTC day).
    pub sweep_days: HashSet<(usize, usize, u32)>,
    /// The market calendar as the harness last loaded it.
    pub calendar: Calendar,
}

/// Sends `instructions` as one transaction; the first signer pays the fee.
fn send(ctx: &mut TestContext, instructions: Vec<Instruction>, signers: &[Rc<Keypair>]) -> TxOutcome {
    let signers: Vec<&Keypair> = signers.iter().map(|k| &**k).collect();
    for (i, ix) in instructions.into_iter().enumerate() {
        let call = ctx.raw_call(ix);
        let call = if i == 0 { call.signers(&signers) } else { call };
        call.add_transaction().unwrap();
    }
    ctx.send_batch().unwrap().expect("a transaction was queued")
}

fn data(ctx: &TestContext, address: &Pubkey) -> Option<Vec<u8>> {
    ctx.get_account(address).ok().filter(|account| account.lamports > 0).map(|account| account.data)
}

fn observe(ctx: &TestContext, users: &[Rc<Keypair>]) -> State {
    let config_data = data(ctx, &CONFIG).unwrap();
    let user_data: [Vec<u8>; USERS] =
        std::array::from_fn(|u| data(ctx, &user_config_address(&users[u].pubkey())).unwrap());
    State {
        now: now(ctx),
        config: Config::try_deserialize(&mut config_data.as_slice()).unwrap(),
        config_data,
        users: std::array::from_fn(|u| UserConfig::try_deserialize(&mut user_data[u].as_slice()).unwrap()),
        user_data,
        balances: std::array::from_fn(|u| {
            let user = users[u].pubkey();
            let accounts = [
                payment_account(&user, 0),
                payment_account(&user, 1),
                asset_account(&user, 0),
                asset_account(&user, 1),
            ];
            accounts.map(|account| token_amount(ctx, &account))
        }),
        swap: swap_accounts().map(|account| data(ctx, &account)),
        plans: PLANS.map(|plans| plans.map(|plan| data(ctx, &plan))),
        subscriptions: std::array::from_fn(|u| {
            let user = users[u].pubkey();
            std::array::from_fn(|token| {
                std::array::from_fn(|tier| data(ctx, &subscription_address(token, tier, &user)))
            })
        }),
    }
}

/// Instructions that leave `user` with a live subscription to the tier's plan for `token`: an existing live one is
/// kept, an ended one is closed first, as the app does.
fn subscribe_ixs(ctx: &TestContext, user: &Pubkey, payer: &Pubkey, token: usize, tier: usize) -> Vec<Instruction> {
    let mut ixs = vec![];
    if data(ctx, &authority_address(user, token)).is_none() {
        ixs.push(init_authority_ix(*user, *payer, token));
    }
    match data(ctx, &subscription_address(token, tier, user)) {
        Some(data) if data.get(147..155) == Some(&[0u8; 8][..]) => return ixs,
        Some(_) => ixs.extend(close_subscription_ix(ctx, *user, token, tier)),
        None => {}
    }
    ixs.push(subscribe_ix(ctx, *user, *payer, token, tier));
    ixs
}

/// The asset account for each asset, then a subscription for each enabled token: what enrollment and reactivation
/// need in place.
fn onboarding_ixs(ctx: &TestContext, user: &Pubkey, payer: &Pubkey, params: &EnrollParams) -> Vec<Instruction> {
    let mut ixs: Vec<Instruction> = ASSETS.iter().map(|mint| create_ata_ix(*payer, *user, *mint, TOKEN_2022)).collect();
    for token in enabled(params.payment_tokens) {
        ixs.extend(subscribe_ixs(ctx, user, payer, token, usize::from(params.tier) % TIERS.len()));
    }
    ixs
}

#[allow(clippy::too_many_arguments)]
fn enroll_params(
    tier: u8,
    payment_tokens: u8,
    asset: u8,
    weekly: bool,
    engine_dollars: u64,
    income_rule: bool,
    change_multiplier: u8,
    cushion_dollars: u64,
) -> EnrollParams {
    EnrollParams {
        tier,
        payment_tokens,
        asset,
        engine: if weekly { Engine::Weekly } else { Engine::Daily },
        engine_amount: engine_dollars * 1_000_000,
        income_rule,
        change_multiplier,
        cushions: [cushion_dollars * 1_000_000; 2],
        goal_amount: 1_000_000_000,
        goal_label: [0; 32],
    }
}

impl Fixture {
    fn send(&mut self, instructions: Vec<Instruction>, signers: &[Rc<Keypair>]) -> TxOutcome {
        send(&mut self.ctx, instructions, signers)
    }

    fn lamports(&self, address: &Pubkey) -> u64 {
        self.ctx.get_account(address).map_or(0, |account| account.lamports)
    }

    fn data(&self, address: &Pubkey) -> Option<Vec<u8>> {
        data(&self.ctx, address)
    }

    pub fn observe(&self) -> State {
        observe(&self.ctx, &self.users)
    }

    fn attestor(&self) -> Rc<Keypair> {
        let current = self.after.config.attestor;
        self.attestors.iter().find(|k| k.pubkey() == current).unwrap_or(&self.attestors[0]).clone()
    }

    fn sponsor(&self, choice: usize) -> Rc<Keypair> {
        self.sponsors[choice % self.sponsors.len()].clone()
    }

    fn admin_signer(&self, choice: usize) -> Rc<Keypair> {
        [self.admin.clone(), self.stranger.clone(), self.users[0].clone()][choice % 3].clone()
    }
}

#[fuzz_fixture]
impl Fixture {
    pub fn setup() -> Self {
        let mut ctx = TestContext::new();
        ctx.add_program(&laterite::ID, PROGRAM).unwrap();
        ctx.add_program(&SUBSCRIPTIONS_ID, &format!("{FIXTURES}/subscriptions.so")).unwrap();
        ctx.add_program(&PYTH_PRO, &format!("{FIXTURES}/pyth_pro_devnet.so")).unwrap();
        ctx.add_program(&CPMM, &format!("{FIXTURES}/cpmm.so")).unwrap();
        ctx.add_program(&ROUTER, ROUTER_PROGRAM).unwrap();
        set_clock(&mut ctx, SETUP_TS);

        for (address, owner) in
            [(CPMM_CONFIG, CPMM), (SPYX, TOKEN_2022), (QQQX, TOKEN_2022), (USDC, TOKEN), (USDT, TOKEN)]
        {
            load_devnet_account(&mut ctx, address, owner);
        }
        for pool in &POOLS {
            load_devnet_account(&mut ctx, pool.address, CPMM);
            load_devnet_account(&mut ctx, pool.observation, CPMM);
            load_devnet_account(&mut ctx, pool.asset_vault, TOKEN_2022);
            load_devnet_account(&mut ctx, pool.payment_vault, TOKEN);
        }
        let storage = std::fs::read(format!("{FIXTURES}/pyth_storage_devnet.bin")).unwrap();
        ctx.create_account().pubkey(PYTH_STORAGE).lamports(3_542_640).owner(PYTH_PRO).data(&storage).create().unwrap();
        fund(&mut ctx, &PYTH_TREASURY);

        let key = |seed| Rc::new(keypair(seed));
        let admin = key(ADMIN_SEED);
        let pyth_signer = key(PYTH_SIGNER_SEED);
        trust(&mut ctx, &pyth_signer.pubkey());
        let users: Vec<_> = USER_SEEDS.iter().map(|&seed| key(seed)).collect();
        let attestors: Vec<_> = ATTESTOR_SEEDS.iter().map(|&seed| key(seed)).collect();
        let sponsors: Vec<_> = SPONSOR_SEEDS.iter().map(|&seed| key(seed)).collect();
        let (stranger, crank) = (key(STRANGER_SEED), key(CRANK_SEED));
        for k in [&admin, &stranger, &crank].into_iter().chain(&users).chain(&sponsors) {
            fund(&mut ctx, &k.pubkey());
        }
        for (u, user) in users.iter().enumerate() {
            for (token, mint) in PAYMENT_MINTS.iter().enumerate() {
                let address = payment_account(&user.pubkey(), token);
                write_token_account(&mut ctx, address, *mint, user.pubkey(), INITIAL_BALANCE);
            }
            // The third user starts with an empty USDT account, below any cushion.
            if u == 2 {
                write_amount(&mut ctx, &payment_account(&user.pubkey(), 1), 0);
            }
        }
        // An empty account of the token program, which a hostile route could initialize for the swap authority.
        let rent = ctx.svm.minimum_balance_for_rent_exemption(165);
        ctx.write_account(
            &FRESH,
            Account { lamports: rent, data: vec![0; 165], owner: TOKEN, executable: false, rent_epoch: 0 },
        )
        .unwrap();

        // The program's upgrade authority is the admin.
        ctx.update_account(&program_data_address(), |data| {
            data[12] = 1;
            data[13..45].copy_from_slice(admin.pubkey().as_ref());
        })
        .unwrap();

        let params = params(attestors[0].pubkey(), sponsors[0].pubkey());
        let (holidays, early_closes, valid_through) = nyse_calendar();
        let calendar = laterite::instruction::SetMarketCalendar { holidays, early_closes, valid_through }.data();
        let admin_ixs = vec![initialize_ix(admin.pubkey(), params.clone()), admin_ix(admin.pubkey(), calendar)];
        assert!(send(&mut ctx, admin_ixs, std::slice::from_ref(&admin)).is_success(), "initialize");
        let mut setup: Vec<Instruction> =
            (0..4).map(|plan| create_plan_ix(admin.pubkey(), plan / 2, plan % 2)).collect();
        // The swap authority's accounts, as the deployment creates them, and the stranger's, to receive what a
        // hostile route takes.
        for owner in [SWAP_AUTHORITY, stranger.pubkey()] {
            setup.extend(PAYMENT_MINTS.iter().map(|mint| create_ata_ix(admin.pubkey(), owner, *mint, TOKEN)));
            setup.extend(ASSETS.iter().map(|mint| create_ata_ix(admin.pubkey(), owner, *mint, TOKEN_2022)));
        }
        assert!(send(&mut ctx, setup, std::slice::from_ref(&admin)).is_success(), "plans and token accounts");
        // A unit in every swap-authority account, so a route that takes one shows.
        for (account, amount) in swap_accounts().iter().take(4).zip([1_000_000, 1_000_000, 1_000, 1_000]) {
            write_amount(&mut ctx, account, amount);
        }
        for (pool, asset) in POOLS.iter().zip([0, 0, 1]) {
            peg(&mut ctx, pool, QUOTES[asset], 0);
        }

        // The last user enrolls with USDC, adds USDT a day later and sweeps it at once, so at `START_TS` its new week
        // allows more than the USDT subscription's current period still does.
        let sponsor = sponsors[0].clone();
        let shifted = users[4].clone();
        let usdc_only = enroll_params(0, 0b01, 0, false, 1, true, 0, 0);
        let mut ixs = onboarding_ixs(&ctx, &shifted.pubkey(), &sponsor.pubkey(), &usdc_only);
        ixs.push(enroll_ix(shifted.pubkey(), sponsor.pubkey(), usdc_only));
        assert!(send(&mut ctx, ixs, &[sponsor.clone(), shifted.clone()]).is_success(), "the last enrollment");
        let added = SETUP_TS + 86_400;
        set_clock(&mut ctx, added);
        let mut ixs = subscribe_ixs(&ctx, &shifted.pubkey(), &sponsor.pubkey(), 1, 0);
        ixs.push(change_payment_tokens_ix(shifted.pubkey(), 0, 0b01, 0b11));
        assert!(send(&mut ctx, ixs, &[sponsor.clone(), shifted.clone()]).is_success(), "the added token");
        let shifted_income = income(shifted.pubkey(), added, 40);
        let attest = attestation_ixs(&shifted_income, &attestors[0], crank.pubkey());
        assert!(send(&mut ctx, attest, std::slice::from_ref(&crank)).is_success(), "the last user's attestation");
        let sweep = crank_sweep(&ctx, &pyth_signer, crank.pubkey(), shifted.pubkey(), 1).unwrap();
        let landed = send(&mut ctx, sweep.instructions, std::slice::from_ref(&crank)).is_success();
        assert!(sweep.pull.total() > 0 && landed, "the last user's sweep");
        set_clock(&mut ctx, START_TS);

        // Four more users: both tokens and every rule; USDC only on the weekly engine; USDT only, change only; both
        // tokens, exited, so a return is one action away.
        for (u, params) in [
            enroll_params(0, 0b11, 0, false, 1, true, 2, 20),
            enroll_params(1, 0b01, 1, true, 5, true, 0, 0),
            enroll_params(0, 0b10, 0, false, 0, false, 3, 50),
            enroll_params(0, 0b11, 0, false, 2, true, 1, 10),
        ]
        .into_iter()
        .enumerate()
        {
            let user = users[u].clone();
            let mut ixs = onboarding_ixs(&ctx, &user.pubkey(), &sponsor.pubkey(), &params);
            ixs.push(enroll_ix(user.pubkey(), sponsor.pubkey(), params));
            assert!(send(&mut ctx, ixs, &[sponsor.clone(), user]).is_success(), "enrollment {u}");
        }
        let exited = users[3].clone();
        assert!(send(&mut ctx, vec![exit_ix(exited.pubkey(), 0, 0b11)], &[exited]).is_success(), "exit");

        // An income credited to the weekly user, so it has something pending outside a session from the start.
        let weekly_income = income(users[1].pubkey(), START_TS, 41);
        let attest = attestation_ixs(&weekly_income, &attestors[0], crank.pubkey());
        assert!(send(&mut ctx, attest, std::slice::from_ref(&crank)).is_success(), "the setup's attestation must land");
        let credited = [(1, weekly_income), (4, shifted_income)];
        let transfer =
            |(user, attestation): &(usize, Attestation)| (*user, attestation.signature, attestation.transfer_index);

        let state = observe(&ctx, &users);
        let mut fixture = Self {
            ctx,
            admin,
            stranger,
            crank: crank.clone(),
            pyth_signer,
            users,
            attestors,
            sponsors,
            params,
            before: state.clone(),
            after: state,
            last: Last::Other,
            transfers: credited.iter().map(|credit| (transfer(credit), credit.1.clone())).collect(),
            counted: credited.iter().map(transfer).collect(),
            records: credited.iter().map(|(_, attestation)| (record_address(attestation), crank.pubkey())).collect(),
            week_pulls: HashMap::new(),
            sweep_days: HashSet::new(),
            calendar: Calendar::nyse(SETUP_TS),
        };
        fixture.check_harness();
        fixture
    }

    /// Advances the clock by `count` minutes, hours, quarter days, days, weeks or quarters.
    pub fn action_warp(&mut self, #[range(0..6)] unit: usize, #[range(1..8)] count: i64) {
        let seconds = [60, 3_600, 21_600, 86_400, 604_800, 7_776_000][unit];
        let ts = now(&self.ctx) + seconds * count;
        set_clock(&mut self.ctx, ts);
        self.last = Last::Other;
    }

    /// Moves the clock to the next hour inside, or outside, a regular NYSE session of the loaded calendar.
    pub fn action_to_session(&mut self, open: bool) {
        let mut ts = now(&self.ctx);
        for _ in 0..24 * 7 {
            ts += 3_600;
            if self.calendar.open(ts) == open {
                break;
            }
        }
        set_clock(&mut self.ctx, ts);
        self.last = Last::Other;
    }

    pub fn action_set_balance(
        &mut self,
        #[range(0..USERS)] user: usize,
        #[range(0..2)] token: usize,
        #[range(0..200)] dollars: u64,
    ) {
        let account = payment_account(&self.users[user].pubkey(), token);
        write_amount(&mut self.ctx, &account, dollars * 1_000_000 + dollars % 7);
        self.last = Last::Other;
    }

    /// The market moves: a pool trades up to 3% away from the real updates' price.
    pub fn action_move_pool(&mut self, #[range(0..3)] pool: usize, #[range(0..601)] bps: i64) {
        let asset = if POOLS[pool].asset_mint == SPYX { 0 } else { 1 };
        peg(&mut self.ctx, &POOLS[pool], QUOTES[asset], bps - 300);
        self.last = Last::Other;
    }

    /// Enrolls a user again, which the account kept since their first enrollment must refuse.
    pub fn action_enroll(&mut self, #[range(0..USERS)] user: usize, #[range(0..2)] sponsor: usize) {
        let key = self.users[user].clone();
        let sponsor = self.sponsor(sponsor);
        let params = enroll_params(0, 0b01, 0, false, 1, false, 0, 0);
        let mut ixs = onboarding_ixs(&self.ctx, &key.pubkey(), &sponsor.pubkey(), &params);
        ixs.push(enroll_ix(key.pubkey(), sponsor.pubkey(), params));
        let ok = self.send(ixs, &[sponsor, key]).is_success();
        self.last = Last::Enroll { ok };
    }

    /// An attestation for `user`, valid or with one mutation: 0 valid; 1 public key offset; 2 message size;
    /// 3 instruction index; 4 signature count; 5 trailing byte; 6 another key signs; 7 the attestor signs a message
    /// differing in one byte; 8 another instruction in between; 9 the precompile after `attest`; 10 a forged
    /// signature; 11 signed for mainnet; 12 signed for another program; 13 signed without the deployment binding.
    #[allow(clippy::too_many_arguments)]
    pub fn action_attest(
        &mut self,
        #[range(0..USERS)] user: usize,
        income: bool,
        #[range(0..2)] token: u8,
        #[range(0..300_000_000)] amount: u64,
        #[range(0..200)] age_hours: i64,
        #[range(0..6)] signature: u8,
        #[range(0..3)] transfer_index: u16,
        #[range(0..14)] mutation: u8,
        position: u16,
        #[range(0..2)] payer: usize,
    ) {
        // The attestor is honest: a transfer, once observed, is always attested with the same fields. Hour 0 lands in
        // the future, and ages past a week are expired.
        let event_time = now(&self.ctx) - (age_hours - 1) * 3_600;
        let attestation = self
            .transfers
            .entry((user, [signature; 64], transfer_index))
            .or_insert_with(|| Attestation {
                kind: if income { EventKind::Income } else { EventKind::Payment },
                user: self.users[user].pubkey(),
                payment_token: token,
                amount,
                event_time,
                signature: [signature; 64],
                transfer_index,
            })
            .clone();
        let (program, genesis_hash) = match mutation {
            11 => (laterite::ID, MAINNET_GENESIS_HASH),
            12 => (Pubkey::new_from_array([position as u8; 32]), DEVNET_GENESIS_HASH),
            _ => (laterite::ID, DEVNET_GENESIS_HASH),
        };
        let message = if mutation == 13 {
            let mut message = laterite::ATTESTATION_DOMAIN.to_vec();
            crucible_fuzzer::anchor_lang::AnchorSerialize::serialize(&attestation, &mut message).unwrap();
            message
        } else {
            attestation_message(&program, &genesis_hash, &attestation)
        };
        let attestor = self.attestor();
        let payer = if payer == 0 { self.crank.clone() } else { self.stranger.clone() };
        let mut ed25519 = signature_ix(&message, &attestor);
        let attest = attest_ix(payer.pubkey(), &attestation);
        let data = &mut ed25519.data;
        match mutation {
            1 => data[6..8].copy_from_slice(&15u16.to_le_bytes()),
            2 => data[12..14].copy_from_slice(&(message.len() as u16 - 1).to_le_bytes()),
            3 => data[4..6].copy_from_slice(&(position % 3).to_le_bytes()),
            4 => data[0] = if position.is_multiple_of(2) { 0 } else { 2 },
            5 => data.push(position as u8),
            10 => data[48 + usize::from(position) % 64] ^= 1,
            6 => {
                let other = self.attestors.iter().find(|k| k.pubkey() != attestor.pubkey()).unwrap();
                ed25519 = signature_ix(&message, other);
            }
            7 => {
                let mut changed = message.clone();
                changed[usize::from(position) % message.len()] ^= 1;
                ed25519 = signature_ix(&changed, &attestor);
            }
            _ => {}
        }
        let ixs = match mutation {
            8 => vec![ed25519, set_compute_unit_limit_ix(), attest],
            9 => vec![attest, ed25519],
            _ => vec![ed25519, attest],
        };
        let ok = self.send(ixs, std::slice::from_ref(&payer)).is_success();
        if ok {
            self.records.push((record_address(&attestation), payer.pubkey()));
        }
        self.last = Last::Attest { user, attestation, mutated: mutation != 0, ok };
    }

    pub fn action_close_attestation(&mut self, #[range(0..8)] which: usize, to_payer: bool) {
        let Some(&(record, payer)) = self.records.get(which % self.records.len().max(1)) else {
            self.last = Last::Other;
            return;
        };
        let other = if payer == self.stranger.pubkey() { self.crank.pubkey() } else { self.stranger.pubkey() };
        let destination = if to_payer { payer } else { other };
        let expires_at =
            self.data(&record).and_then(|data| Some(i64::from_le_bytes(data.get(40..48)?.try_into().ok()?)));
        let (rent, before) = (self.lamports(&record), self.lamports(&destination));
        // The admin pays the fee: it is never a record's payer, so the destination's gain is the rent alone.
        let admin = self.admin.clone();
        let ok = self.send(vec![close_attestation_ix(record, destination)], &[admin]).is_success();
        let gain = self.lamports(&destination).saturating_sub(before);
        self.last = Last::CloseAttestation { expires_at, to_payer, gain, rent, ok };
    }

    /// A sweep of `user`'s `token` with composed updates at the clock and the real quotes, through the router, honest
    /// but for one `mutation`: the route 1 asks one unit more; 2 one unit less; 3 `amount`; 4 another pool; 5 another swap-authority account
    /// as input; 6 the swap authority's asset account as output; 7 swap account `slot` replaced by candidate `with`;
    /// the exact swap and then 8 a unit taken from a swap-authority account, 9 an approval on one, 10 an account
    /// initialized for the swap authority, 11 a pull from another subscriber, 12 a plan update or 13 a plan deletion,
    /// each signed as the swap authority or named as the vault; 14 the exact swap with a swap-authority account passed
    /// untouched; the updates 15 without the payment update; 16 with a payment update for USDC too; 17 the signature
    /// entries swapped; 18 the payment update signed by an untrusted key; 19 the asset entry one byte off; the prices
    /// 20 the asset update `asset_age` seconds old; 21 the payment update `payment_age` seconds old; 22 the asset's
    /// confidence `asset_confidence_bps`; 23 the payment's `payment_confidence_bps`; 24 the asset priced `price_bps` -
    /// 200 basis points off. Mutations 25 to 49 are honest, as 0 is, so half the sweeps are.
    #[allow(clippy::too_many_arguments)]
    pub fn action_sweep(
        &mut self,
        #[range(0..USERS)] user: usize,
        #[range(0..2)] token: usize,
        #[range(0..50)] mutation: u8,
        amount: u64,
        #[range(0..13)] slot: usize,
        #[range(0..16)] with: usize,
        #[range(0..91)] asset_age: i64,
        #[range(0..91)] payment_age: i64,
        #[range(0..401)] price_bps: u64,
        #[range(0..71)] asset_confidence_bps: u64,
        #[range(0..71)] payment_confidence_bps: u64,
    ) {
        let (route_kind, updates) = match mutation {
            0..15 => (mutation, 0),
            15..20 => (0, mutation - 14),
            _ => (0, 0),
        };
        let asset_age = if mutation == 20 { asset_age } else { 0 };
        let payment_age = if mutation == 21 { payment_age } else { 0 };
        let asset_confidence_bps = if mutation == 22 { asset_confidence_bps } else { 4 };
        let payment_confidence_bps = if mutation == 23 { payment_confidence_bps } else { 1 };
        let price_bps = if mutation == 24 { price_bps } else { 200 };
        let now = now(&self.ctx);
        let key = self.users[user].pubkey();
        let user_config = &self.after.users[user];
        let (tier, asset) = (usize::from(user_config.tier) % 2, usize::from(user_config.asset) % 2);
        let native = native_remaining(self.after.subscriptions[user][token][tier].as_deref(), now);
        let config = &self.after.config;
        let balance = self.after.balances[user][token];
        let pull =
            user_config.pull(token, balance, config.user_weekly_cap, &config.market_calendar, now).capped(native);
        let total = pull.total();

        let base = QUOTES[asset];
        let price = u64::try_from(i128::from(base.price) * (9_800 + i128::from(price_bps)) / 10_000).unwrap();
        let asset_quote = Quote { price, confidence: price * asset_confidence_bps / 10_000, exponent: base.exponent };
        let asset_message = pyth_update(
            &self.pyth_signer,
            now - asset_age,
            &[(FEEDS[asset], asset_quote), (FEEDS[1 - asset], QUOTES[1 - asset])],
        );
        let usdt_quote = Quote { confidence: USDT_QUOTE.price * payment_confidence_bps / 10_000, ..USDT_QUOTE };
        let signer = if updates == 4 { keypair(PYTH_SIGNER_SEED + 100) } else { keypair(PYTH_SIGNER_SEED) };
        let usdt_message = pyth_update(&signer, now - payment_age, &[(USDT_FEED, usdt_quote)]);
        let payment_message = match (token, updates) {
            (1, 1) | (0, 0 | 1 | 3 | 4 | 5) => vec![],
            _ => usdt_message,
        };
        let honest_updates = match token {
            0 => updates != 2 && updates != 5,
            _ => updates == 0 || updates == 2,
        };
        let asset_entry = (asset_message.as_slice(), if updates == 5 { 13 } else { 12 });
        let payment_entry = (payment_message.as_slice(), 16 + asset_message.len() as u16);
        let entries = match (payment_message.is_empty(), updates) {
            (true, _) => vec![asset_entry],
            (false, 3) => vec![payment_entry, asset_entry],
            (false, _) => vec![asset_entry, payment_entry],
        };
        let ed25519 = pyth_ed25519_ix(&entries);
        let payment_quote = if token == 0 { Ok(Quote::DOLLAR) } else { quote(&payment_message, USDT_FEED, now) };
        let minimum = quote(&asset_message, FEEDS[asset], now)
            .and_then(|asset_quote| min_out(total, payment_quote?, 6, asset_quote, 8))
            .ok();

        // QQQx has no USDT pool, so that pair only ever routes through another pool.
        let exact = POOLS.iter().position(|p| p.asset_mint == ASSETS[asset] && p.payment_mint == PAYMENT_MINTS[token]);
        let pool = match exact {
            Some(i) if route_kind != 4 => &POOLS[i],
            _ => &POOLS[(exact.unwrap_or(0) + 1) % POOLS.len()],
        };
        let swap = swap_accounts();
        let (mut input, mut output) = (payment_account(&SWAP_AUTHORITY, token), asset_account(&key, asset));
        let amount_in = match route_kind {
            1 => total + 1,
            2 => total.saturating_sub(1),
            3 => amount,
            _ => total,
        };
        match route_kind {
            5 => input = swap[with % 4],
            6 => output = asset_account(&SWAP_AUTHORITY, asset),
            _ => {}
        }
        let mut cpmm = cpmm_swap_ix(pool, input, output, amount_in);
        if route_kind == 7 {
            let other = self.users[(user + 1) % USERS].pubkey();
            let candidates = [
                swap[0],
                swap[1],
                swap[2],
                swap[3],
                VAULT,
                asset_account(&key, 1 - asset),
                asset_account(&other, asset),
                payment_account(&key, token),
                payment_account(&other, token),
                POOLS[0].payment_vault,
                POOLS[1].payment_vault,
                POOLS[2].asset_vault,
                POOLS[0].address,
                POOLS[2].address,
                CPMM_CONFIG,
                key,
            ];
            cpmm.accounts[slot].pubkey = candidates[with];
        }
        let as_owner = if with % 2 == 0 { SWAP_AUTHORITY } else { VAULT };
        let mut steps = vec![cpmm];
        match route_kind {
            8 => {
                let (account, mint, program) = [
                    (swap[0], USDC, TOKEN),
                    (swap[1], USDT, TOKEN),
                    (swap[2], SPYX, TOKEN_2022),
                    (swap[3], QQQX, TOKEN_2022),
                ][with % 4];
                let to = ata(&self.stranger.pubkey(), &mint, &program);
                let decimals = if program == TOKEN { 6 } else { 8 };
                let take = token_instruction::transfer_checked(
                    &program,
                    &account,
                    &mint,
                    &to,
                    &SWAP_AUTHORITY,
                    &[],
                    1,
                    decimals,
                );
                steps.push(take.unwrap());
            }
            9 => {
                let program = if with % 4 < 2 { TOKEN } else { TOKEN_2022 };
                let stranger = self.stranger.pubkey();
                let approve = token_instruction::approve(&program, &swap[with % 4], &stranger, &SWAP_AUTHORITY, &[], 1);
                steps.push(approve.unwrap());
            }
            10 => steps.push(token_instruction::initialize_account3(&TOKEN, &FRESH, &USDC, &SWAP_AUTHORITY).unwrap()),
            11 => {
                let other = self.users[(user + 1 + with % 2) % USERS].pubkey();
                steps.push(transfer_subscription_ix(other, as_owner, 1_000_000));
            }
            12 => steps.push(update_plan_ix(&self.ctx, as_owner, self.stranger.pubkey())),
            13 => steps.push(delete_plan_ix(as_owner)),
            _ => {}
        }
        let (data, mut accounts) = route(&steps);
        if route_kind == 14 {
            accounts.push(solana_instruction::AccountMeta::new(swap[2 + asset], false));
        }
        let sweep =
            sweep_ix(self.crank.pubkey(), key, token, tier, asset, &asset_message, &payment_message, data, accounts);
        let crank = self.crank.clone();
        let outcome = self.send(vec![ed25519, sweep], &[crank]);
        let (ok, code) = (outcome.is_success(), outcome.error_code());
        self.last = Last::Sweep { user, token, pull, native, minimum, honest_updates, code, ok };
    }

    /// The crank's sweep of `user`'s `token`, as it sends one: the exact pull, honest updates and the exact swap.
    pub fn action_crank_sweep(&mut self, #[range(0..USERS)] user: usize, #[range(0..2)] token: usize) {
        let key = self.users[user].pubkey();
        let Some(sweep) = crank_sweep(&self.ctx, &self.pyth_signer, self.crank.pubkey(), key, token) else {
            self.last = Last::Other;
            return;
        };
        let crank = self.crank.clone();
        let outcome = self.send(sweep.instructions, &[crank]);
        let (ok, code) = (outcome.is_success(), outcome.error_code());
        let (pull, native, minimum) = (sweep.pull, sweep.native, sweep.minimum);
        self.last = Last::Sweep { user, token, pull, native, minimum, honest_updates: true, code, ok };
    }

    /// `update_settings` of `target`'s settings, signed by `target`, valid but for one `mutation`: 1 another user
    /// signs; 2 the tier changes; 3 an asset that does not exist; 4 a multiplier above 3; 5 an engine above the tier.
    /// Mutations 6 to 9 are honest, as 0 is, so half the changes are.
    #[allow(clippy::too_many_arguments)]
    pub fn action_update_settings(
        &mut self,
        #[range(0..USERS)] target: usize,
        #[range(0..2)] asset: u8,
        weekly: bool,
        #[range(1..11)] engine_dollars: u64,
        income_rule: bool,
        #[range(0..4)] change_multiplier: u8,
        #[range(0..60)] cushion_dollars: u64,
        #[range(0..10)] mutation: u8,
    ) {
        let current = &self.after.users[target];
        let signer = if mutation == 1 { (target + 1) % USERS } else { target };
        let tier = if mutation == 2 { current.tier ^ 1 } else { current.tier };
        let asset = if mutation == 3 { 2 } else { asset };
        let change_multiplier = if mutation == 4 { 4 } else { change_multiplier };
        let engine_dollars = if mutation == 5 { 26 } else { engine_dollars };
        let counts_more = (income_rule && !current.income_rule) || change_multiplier > current.change_multiplier;
        let params = enroll_params(
            tier,
            current.payment_tokens,
            asset,
            weekly,
            engine_dollars,
            income_rule,
            change_multiplier,
            cushion_dollars,
        );
        let data = laterite::instruction::UpdateSettings { params }.data();
        self.control(signer, target, data, Control::UpdateSettings { counts_more });
    }

    pub fn action_set_user_paused(
        &mut self,
        #[range(0..USERS)] signer: usize,
        #[range(0..USERS)] target: usize,
        paused: bool,
    ) {
        let data = laterite::instruction::SetUserPaused { paused }.data();
        self.control(signer, target, data, Control::Pause(paused));
    }

    /// Lowers `target`'s pending amount to 0, one unit less, the same, or `value`.
    pub fn action_lower_pending(
        &mut self,
        #[range(0..USERS)] signer: usize,
        #[range(0..USERS)] target: usize,
        #[range(0..4)] how: u8,
        value: u64,
    ) {
        let pending = self.after.users[target].pending;
        let pending = [0, pending.saturating_sub(1), pending, value][usize::from(how)];
        let data = laterite::instruction::LowerPending { pending }.data();
        self.control(signer, target, data, Control::LowerPending(pending));
    }

    /// Moves `user` to `tier` (2 is not a tier), subscribing to the new plans first or not.
    pub fn action_change_tier(&mut self, #[range(0..USERS)] user: usize, #[range(0..3)] tier: usize, subscribe: bool) {
        let signer = self.users[user].clone();
        let (from, tokens) = (usize::from(self.after.users[user].tier) % 2, self.after.users[user].payment_tokens);
        let sponsor = self.sponsors[0].clone();
        let mut ixs = vec![];
        if subscribe && tier < TIERS.len() {
            for token in enabled(tokens) {
                ixs.extend(subscribe_ixs(&self.ctx, &signer.pubkey(), &sponsor.pubkey(), token, tier));
            }
        }
        ixs.push(change_tier_ix(signer.pubkey(), from, tier, tokens));
        let ok = self.send(ixs, &[sponsor, signer]).is_success();
        self.last = Last::TierChange { user, ok };
    }

    /// Changes `user`'s payment tokens to `tokens` (0 and 4 are refused), subscribing to added ones first or not.
    pub fn action_change_payment_tokens(
        &mut self,
        #[range(0..USERS)] user: usize,
        #[range(0..5)] tokens: u8,
        subscribe: bool,
    ) {
        let signer = self.users[user].clone();
        let (tier, from) = (usize::from(self.after.users[user].tier) % 2, self.after.users[user].payment_tokens);
        let sponsor = self.sponsors[0].clone();
        let mut ixs = vec![];
        if subscribe {
            for token in enabled(tokens & !from) {
                ixs.extend(subscribe_ixs(&self.ctx, &signer.pubkey(), &sponsor.pubkey(), token, tier));
            }
        }
        ixs.push(change_payment_tokens_ix(signer.pubkey(), tier, from, tokens));
        let ok = self.send(ixs, &[sponsor, signer]).is_success();
        self.last = Last::TokensChange { user, ok };
    }

    pub fn action_exit(&mut self, #[range(0..USERS)] user: usize) {
        let signer = self.users[user].clone();
        let (tier, tokens) = (usize::from(self.after.users[user].tier) % 2, self.after.users[user].payment_tokens);
        let ok = self.send(vec![exit_ix(signer.pubkey(), tier, tokens)], &[signer]).is_success();
        self.last = Last::Exit { user, ok };
    }

    /// Returns a user who exited (the `user`-th, counting from `user` among those who have) with new settings, honestly
    /// (the configured sponsor signing, valid settings) but for one `mutation`: 4 the other sponsor signs; 5 the
    /// configured sponsor is named but does not sign; 6 a tier that does not exist; 7 no payment token; 8 `user`
    /// itself, whether or not it exited. Mutations 0 to 3 are honest, so almost half the returns are.
    #[allow(clippy::too_many_arguments)]
    pub fn action_reactivate(
        &mut self,
        #[range(0..USERS)] user: usize,
        #[range(0..2)] tier: u8,
        #[range(1..4)] payment_tokens: u8,
        #[range(0..2)] asset: u8,
        weekly: bool,
        #[range(1..11)] engine_dollars: u64,
        income_rule: bool,
        #[range(0..4)] change_multiplier: u8,
        #[range(0..9)] mutation: u8,
    ) {
        let exited = (0..USERS).map(|u| (user + u) % USERS).find(|&u| self.after.users[u].status == UserStatus::Exited);
        let user = if mutation == 8 { user } else { exited.unwrap_or(user) };
        let key = self.users[user].clone();
        let configured = self.after.config.sponsor;
        let (ours, other): (Vec<_>, Vec<_>) = self.sponsors.iter().cloned().partition(|k| k.pubkey() == configured);
        let named = if mutation == 4 { other[0].clone() } else { ours[0].clone() };
        let (tier, payment_tokens) = match mutation {
            6 => (2, payment_tokens),
            7 => (tier, 0),
            _ => (tier, payment_tokens),
        };
        let params =
            enroll_params(tier, payment_tokens, asset, weekly, engine_dollars, income_rule, change_multiplier, 10);
        // Without the sponsor's signature, someone else pays the fees.
        let signs = mutation != 5;
        let payer = if signs { named.clone() } else { self.stranger.clone() };
        let mut ixs = onboarding_ixs(&self.ctx, &key.pubkey(), &payer.pubkey(), &params);
        ixs.push(reactivate_ix(key.pubkey(), named.pubkey(), signs, params));
        let ok = self.send(ixs, &[payer, key]).is_success();
        let sponsored = signs && named.pubkey() == configured;
        self.last = Last::Reactivate { user, sponsored, ok };
    }

    /// The user acts on a subscription through Subscriptions directly: cancels it at the end of the period, or
    /// closes an ended one.
    pub fn action_subscriptions(&mut self, #[range(0..USERS)] user: usize, #[range(0..2)] token: usize, close: bool) {
        let signer = self.users[user].clone();
        let tier = usize::from(self.after.users[user].tier) % 2;
        let ix = if close {
            close_subscription_ix(&self.ctx, signer.pubkey(), token, tier)
        } else {
            Some(cancel_subscription_ix(signer.pubkey(), token, tier))
        };
        if let Some(ix) = ix {
            self.send(vec![ix], &[signer]);
        }
        self.last = Last::Subscriptions { user };
    }

    /// `update_config` with an attestor and a sponsor (2: unset), and beta caps from small tables.
    pub fn action_update_config(
        &mut self,
        #[range(0..3)] signer: usize,
        #[range(0..3)] attestor: usize,
        #[range(0..3)] sponsor: usize,
        #[range(0..5)] cap: usize,
        #[range(0..4)] max_users: usize,
    ) {
        let key = |keys: &[Rc<Keypair>], i: usize| keys.get(i).map_or(Pubkey::default(), |k| k.pubkey());
        let settings = Settings {
            attestor: key(&self.attestors, attestor),
            sponsor: key(&self.sponsors, sponsor),
            user_weekly_cap: [0, 5_000_000, 10_000_000, 25_000_000, 50_000_000][cap],
            max_users: [0, 1, 3, 100][max_users],
        };
        self.admin_call(signer, laterite::instruction::UpdateConfig { settings }.data(), Admin::UpdateConfig);
    }

    pub fn action_set_paused(&mut self, #[range(0..3)] signer: usize, paused: bool) {
        self.admin_call(signer, laterite::instruction::SetPaused { paused }.data(), Admin::SetPaused);
    }

    /// Loads the NYSE calendar, one that ends today, or one out of order.
    pub fn action_set_market_calendar(&mut self, #[range(0..3)] signer: usize, #[range(0..3)] which: u8) {
        let today = (now(&self.ctx).div_euclid(laterite::DAY_SECONDS)) as u16;
        let (holidays, early_closes, valid_through) = match which {
            0 => nyse_calendar(),
            1 => (vec![], vec![], today),
            _ => {
                let (mut holidays, early_closes, valid_through) = nyse_calendar();
                holidays.reverse();
                (holidays, early_closes, valid_through)
            }
        };
        let data = laterite::instruction::SetMarketCalendar { holidays, early_closes, valid_through }.data();
        self.admin_call(signer, data, Admin::SetCalendar);
        if matches!(self.last, Last::Admin { ok: true, .. }) {
            let now = now(&self.ctx);
            self.calendar = if which == 0 { Calendar::nyse(now) } else { Calendar::today_only(now) };
        }
    }

    pub fn action_propose_admin(&mut self, #[range(0..3)] signer: usize, #[range(0..3)] candidate: usize) {
        let new_admin = [self.stranger.pubkey(), self.admin.pubkey(), Pubkey::default()][candidate];
        self.admin_call(signer, laterite::instruction::ProposeAdmin { new_admin }.data(), Admin::Propose);
    }

    pub fn action_accept_admin(&mut self, #[range(0..3)] signer: usize) {
        let signer = self.admin_signer(signer);
        let ok = self.send(vec![accept_admin_ix(signer.pubkey())], std::slice::from_ref(&signer)).is_success();
        self.last = Last::Admin { signer: signer.pubkey(), admin: Admin::Accept, ok };
    }

    pub fn after_action(&mut self) {
        let state = self.observe();
        self.before = std::mem::replace(&mut self.after, state);
    }
}

impl Fixture {
    fn control(&mut self, signer: usize, target: usize, data: Vec<u8>, control: Control) {
        let key = self.users[signer].clone();
        let ix = user_only_ix(key.pubkey(), user_config_address(&self.users[target].pubkey()), data);
        let ok = self.send(vec![ix], &[key]).is_success();
        self.last = Last::Control { signer, target, control, ok };
    }

    fn admin_call(&mut self, signer: usize, data: Vec<u8>, admin: Admin) {
        let signer = self.admin_signer(signer);
        let ok = self.send(vec![admin_ix(signer.pubkey(), data)], std::slice::from_ref(&signer)).is_success();
        self.last = Last::Admin { signer: signer.pubkey(), admin, ok };
    }

    /// Fails fast when the harness itself is broken: a forged precompile signature and signatures for another
    /// deployment must fail, and a valid attestation and USDC and USDT sweeps must land, so no invariant holds only
    /// because every action fails.
    fn check_harness(&mut self) {
        let user = self.users[0].pubkey();
        let now = now(&self.ctx);
        let attestation = Attestation {
            kind: EventKind::Income,
            user,
            payment_token: 0,
            amount: 100_000_000,
            event_time: now,
            signature: [42; 64],
            transfer_index: 0,
        };
        let message = attestation_message(&laterite::ID, &DEVNET_GENESIS_HASH, &attestation);
        let mut ed25519 = signature_ix(&message, &self.attestors[0]);
        let attest = attest_ix(self.crank.pubkey(), &attestation);
        assert!(self.simulate(vec![ed25519.clone(), attest.clone()]), "a valid attestation must land");
        ed25519.data[48] ^= 1;
        assert!(!self.simulate(vec![ed25519, attest.clone()]), "the ed25519 precompile must reject a forged signature");
        let mut unbound = laterite::ATTESTATION_DOMAIN.to_vec();
        crucible_fuzzer::anchor_lang::AnchorSerialize::serialize(&attestation, &mut unbound).unwrap();
        for foreign in [attestation_message(&laterite::ID, &MAINNET_GENESIS_HASH, &attestation), unbound] {
            let signature = signature_ix(&foreign, &self.attestors[0]);
            assert!(!self.simulate(vec![signature, attest.clone()]), "an attestation for another deployment must fail");
        }

        for token in 0..2 {
            let sweep = crank_sweep(&self.ctx, &self.pyth_signer, self.crank.pubkey(), user, token).unwrap();
            let total = sweep.pull.total();
            assert!(total > 0 && self.simulate(sweep.instructions), "a valid sweep of token {token} must land");
        }
    }

    fn simulate(&self, instructions: Vec<Instruction>) -> bool {
        let payer = &self.crank;
        let blockhash = self.ctx.svm.latest_blockhash();
        let message = solana_message::Message::new_with_blockhash(&instructions, Some(&payer.pubkey()), &blockhash);
        let tx = solana_transaction::versioned::VersionedTransaction::try_new(
            solana_message::VersionedMessage::Legacy(message),
            &[&**payer],
        )
        .unwrap();
        self.ctx.svm.simulate_transaction(tx).is_ok()
    }
}

/// An income of $100 to `user` at `event_time`, told apart by `tag`.
fn income(user: Pubkey, event_time: i64, tag: u8) -> Attestation {
    Attestation {
        kind: EventKind::Income,
        user,
        payment_token: 0,
        amount: 100_000_000,
        event_time,
        signature: [tag; 64],
        transfer_index: 0,
    }
}

/// The attestor's signature over `attestation` for this deployment, then `attest`.
fn attestation_ixs(attestation: &Attestation, attestor: &Keypair, payer: Pubkey) -> Vec<Instruction> {
    let message = attestation_message(&laterite::ID, &DEVNET_GENESIS_HASH, attestation);
    vec![signature_ix(&message, attestor), attest_ix(payer, attestation)]
}

/// The crank's sweep of a user's token now, and what it expects.
struct CrankSweep {
    /// What the amount engine gives, within what the subscription's current period allows.
    pull: Pull,
    native: u64,
    /// The minimum the honest updates allow.
    minimum: Option<u64>,
    instructions: Vec<Instruction>,
}

/// What the crank sends to sweep `user`'s `token` now: the amount engine's pull within the subscription's current
/// period, honest updates and the exact CPMM swap through the router. `None` for a pair with no pool.
fn crank_sweep(
    ctx: &TestContext,
    pyth_signer: &Keypair,
    crank: Pubkey,
    user: Pubkey,
    token: usize,
) -> Option<CrankSweep> {
    let now = now(ctx);
    let config = Config::try_deserialize(&mut data(ctx, &CONFIG).unwrap().as_slice()).unwrap();
    let settings =
        UserConfig::try_deserialize(&mut data(ctx, &user_config_address(&user)).unwrap().as_slice()).unwrap();
    let (tier, asset) = (usize::from(settings.tier) % 2, usize::from(settings.asset) % 2);
    let pool = POOLS.iter().find(|p| p.asset_mint == ASSETS[asset] && p.payment_mint == PAYMENT_MINTS[token])?;
    let native = native_remaining(data(ctx, &subscription_address(token, tier, &user)).as_deref(), now);
    let balance = token_amount(ctx, &payment_account(&user, token));
    let pull = settings.pull(token, balance, config.user_weekly_cap, &config.market_calendar, now).capped(native);
    let payment_quote = if token == 1 { USDT_QUOTE } else { Quote::DOLLAR };
    let minimum = min_out(pull.total(), payment_quote, 6, QUOTES[asset], 8).ok();
    let asset_update = pyth_update(pyth_signer, now, &[(FEEDS[asset], QUOTES[asset])]);
    let payment = if token == 1 { pyth_update(pyth_signer, now, &[(USDT_FEED, USDT_QUOTE)]) } else { vec![] };
    let mut entries = vec![(asset_update.as_slice(), 12)];
    if token == 1 {
        entries.push((payment.as_slice(), 16 + asset_update.len() as u16));
    }
    let swap = cpmm_swap_ix(pool, payment_account(&SWAP_AUTHORITY, token), asset_account(&user, asset), pull.total());
    let (data, accounts) = route(&[swap]);
    let sweep = sweep_ix(crank, user, token, tier, asset, &asset_update, &payment, data, accounts);
    Some(CrankSweep { pull, native, minimum, instructions: vec![pyth_ed25519_ix(&entries), sweep] })
}

fn set_compute_unit_limit_ix() -> Instruction {
    let mut data = vec![2];
    data.extend(400_000u32.to_le_bytes());
    Instruction {
        program_id: Pubkey::from_str_const("ComputeBudget111111111111111111111111111111"),
        accounts: vec![],
        data,
    }
}

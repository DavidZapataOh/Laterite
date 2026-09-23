mod common;

use {
    common::{PYTH_SPYX_QQQX, PYTH_UPDATES_AT, PYTH_USDT},
    laterite::{min_out, quote, LateriteError, Quote, MAX_PRICE_AGE_SECONDS, USD_DECIMALS},
    proptest::prelude::*,
};

const SPYX: u32 = 1843;
const QQQX: u32 = 1837;
const USDT_FEED: u32 = 8;
const STRC: u32 = 2419;
const ASSET_DECIMALS: u8 = 8;

const SPYX_QUOTE: Quote = Quote { price: 77_847_155_496, confidence: 30_532_893, exponent: -8 };
const QQQX_QUOTE: Quote = Quote { price: 74_597_430_644, confidence: 40_282_152, exponent: -8 };
const USDT_QUOTE: Quote = Quote { price: 99_972_708, confidence: 7_028, exponent: -8 };

/// A feed id and its `(property id, encoded value)` pairs.
type Feed<'a> = (u32, &'a [(u8, &'a [u8])]);

/// A Solana-format message with a zero signature around a payload of `feeds`.
fn message(feeds: &[Feed]) -> Vec<u8> {
    let mut payload = 2_479_346_549u32.to_le_bytes().to_vec();
    payload.extend((PYTH_UPDATES_AT as u64 * 1_000_000).to_le_bytes());
    payload.push(3);
    payload.push(feeds.len() as u8);
    for (id, properties) in feeds {
        payload.extend(id.to_le_bytes());
        payload.push(properties.len() as u8);
        for (property, value) in *properties {
            payload.push(*property);
            payload.extend(*value);
        }
    }
    let mut message = 2_182_742_457u32.to_le_bytes().to_vec();
    message.extend([0; 96]);
    message.extend((payload.len() as u16).to_le_bytes());
    message.extend(payload);
    message
}

fn updated(seconds: i64) -> Vec<u8> {
    [&[1][..], &(seconds as u64 * 1_000_000).to_le_bytes()].concat()
}

/// SPYX's real values as a synthetic feed, with `confidence` in place of the real one.
fn spyx_with_confidence(confidence: i64) -> Vec<u8> {
    let price = SPYX_QUOTE.price.to_le_bytes();
    let confidence = confidence.to_le_bytes();
    let exponent = (-8i16).to_le_bytes();
    let updated = updated(PYTH_UPDATES_AT);
    message(&[(SPYX, &[(0, &price), (5, &confidence), (4, &exponent), (12, &updated)])])
}

#[test]
fn real_updates_give_their_feeds_quotes_at_the_same_time() {
    assert_eq!(quote(PYTH_SPYX_QQQX, SPYX, PYTH_UPDATES_AT).unwrap(), SPYX_QUOTE);
    assert_eq!(quote(PYTH_SPYX_QQQX, QQQX, PYTH_UPDATES_AT).unwrap(), QQQX_QUOTE);
    assert_eq!(quote(PYTH_USDT, USDT_FEED, PYTH_UPDATES_AT).unwrap(), USDT_QUOTE);
}

#[test]
fn feed_zero_is_the_dollar_and_takes_no_update() {
    assert_eq!(quote(&[], 0, 0).unwrap(), Quote::DOLLAR);
    assert_eq!(quote(PYTH_USDT, 0, PYTH_UPDATES_AT).unwrap_err(), LateriteError::InvalidPriceUpdate.into());
}

#[test]
fn a_feed_is_read_only_from_the_update_given_for_it() {
    for (update, feed) in [(PYTH_SPYX_QQQX, USDT_FEED), (PYTH_USDT, SPYX)] {
        assert_eq!(quote(update, feed, PYTH_UPDATES_AT).unwrap_err(), LateriteError::PriceUnavailable.into());
    }
    assert_eq!(quote(&[], USDT_FEED, PYTH_UPDATES_AT).unwrap_err(), LateriteError::InvalidPriceUpdate.into());
}

#[test]
fn a_price_older_than_the_limit_is_stale() {
    for (update, feed) in [(PYTH_SPYX_QQQX, SPYX), (PYTH_USDT, USDT_FEED)] {
        assert!(quote(update, feed, PYTH_UPDATES_AT + MAX_PRICE_AGE_SECONDS).is_ok());
        assert_eq!(
            quote(update, feed, PYTH_UPDATES_AT + MAX_PRICE_AGE_SECONDS + 1).unwrap_err(),
            LateriteError::StalePrice.into()
        );
    }
}

#[test]
fn a_carried_forward_feed_is_stale_in_a_fresh_update() {
    // STRC's last trade was at the previous close, although the update itself is current.
    assert_eq!(quote(PYTH_SPYX_QQQX, STRC, PYTH_UPDATES_AT).unwrap_err(), LateriteError::StalePrice.into());
}

#[test]
fn confidence_wider_than_the_bound_is_refused() {
    let at_bound = (SPYX_QUOTE.price / 200) as i64;
    assert!(quote(&spyx_with_confidence(at_bound), SPYX, PYTH_UPDATES_AT).is_ok());
    assert_eq!(
        quote(&spyx_with_confidence(at_bound + 1), SPYX, PYTH_UPDATES_AT).unwrap_err(),
        LateriteError::PriceUncertain.into()
    );
}

#[test]
fn properties_are_read_by_id_in_any_order() {
    let price = SPYX_QUOTE.price.to_le_bytes();
    let confidence = SPYX_QUOTE.confidence.to_le_bytes();
    let exponent = (-8i16).to_le_bytes();
    let updated = updated(PYTH_UPDATES_AT);
    let publishers = 3u16.to_le_bytes();
    let reordered = message(&[(
        SPYX,
        &[(12, &updated), (3, &publishers), (4, &exponent), (5, &confidence), (1, &price), (0, &price)],
    )]);
    assert_eq!(quote(&reordered, SPYX, PYTH_UPDATES_AT).unwrap(), SPYX_QUOTE);
}

#[test]
fn a_feed_without_price_confidence_exponent_or_update_time_is_unavailable() {
    let price = SPYX_QUOTE.price.to_le_bytes();
    let negative = (-1i64).to_le_bytes();
    let zero = 0i64.to_le_bytes();
    let confidence = SPYX_QUOTE.confidence.to_le_bytes();
    let exponent = (-8i16).to_le_bytes();
    let updated = updated(PYTH_UPDATES_AT);
    let absent = [0u8];
    let cases: [&[(u8, &[u8])]; 6] = [
        &[(5, &confidence), (4, &exponent), (12, &updated)],
        &[(0, &zero), (5, &confidence), (4, &exponent), (12, &updated)],
        &[(0, &negative), (5, &confidence), (4, &exponent), (12, &updated)],
        &[(0, &price), (4, &exponent), (12, &updated)],
        &[(0, &price), (5, &confidence), (12, &updated)],
        &[(0, &price), (5, &confidence), (4, &exponent), (12, &absent)],
    ];
    for properties in cases {
        assert_eq!(
            quote(&message(&[(SPYX, properties)]), SPYX, PYTH_UPDATES_AT).unwrap_err(),
            LateriteError::PriceUnavailable.into()
        );
    }
}

#[test]
fn a_malformed_update_is_refused() {
    let mut bad_envelope = PYTH_SPYX_QQQX.to_vec();
    bad_envelope[0] ^= 1;
    let mut bad_payload = PYTH_SPYX_QQQX.to_vec();
    bad_payload[102] ^= 1;
    let mut longer = PYTH_SPYX_QQQX.to_vec();
    longer.push(0);
    let unknown_property = message(&[(SPYX, &[(13, &[0; 8])])]);
    let bad_flag = message(&[(SPYX, &[(12, &[2; 9])])]);
    for update in [
        &bad_envelope,
        &bad_payload,
        &longer,
        &PYTH_SPYX_QQQX[..PYTH_SPYX_QQQX.len() - 1].to_vec(),
        &unknown_property,
        &bad_flag,
    ] {
        assert_eq!(quote(update, SPYX, PYTH_UPDATES_AT).unwrap_err(), LateriteError::InvalidPriceUpdate.into());
    }
}

#[test]
fn min_out_is_the_worth_at_the_conservative_prices_less_slippage() {
    assert_eq!(min_out(1_000_000, Quote::DOLLAR, USD_DECIMALS, SPYX_QUOTE, ASSET_DECIMALS).unwrap(), 127_121);
    assert_eq!(min_out(10_000_000, Quote::DOLLAR, USD_DECIMALS, SPYX_QUOTE, ASSET_DECIMALS).unwrap(), 1_271_223);
    assert_eq!(min_out(25_000_000, Quote::DOLLAR, USD_DECIMALS, QQQX_QUOTE, ASSET_DECIMALS).unwrap(), 3_316_017);
    assert_eq!(min_out(25_000_000, USDT_QUOTE, USD_DECIMALS, QQQX_QUOTE, ASSET_DECIMALS).unwrap(), 3_314_879);
    assert_eq!(min_out(0, Quote::DOLLAR, USD_DECIMALS, SPYX_QUOTE, ASSET_DECIMALS).unwrap(), 0);
}

#[test]
fn usdt_counts_at_its_verified_price_from_its_own_update() {
    let asset = quote(PYTH_SPYX_QQQX, SPYX, PYTH_UPDATES_AT).unwrap();
    let usdt = quote(PYTH_USDT, USDT_FEED, PYTH_UPDATES_AT).unwrap();
    let usdc = quote(&[], 0, PYTH_UPDATES_AT).unwrap();
    assert_eq!(min_out(10_000_000, usdt, USD_DECIMALS, asset, ASSET_DECIMALS).unwrap(), 1_270_787);
    assert_eq!(min_out(10_000_000, usdc, USD_DECIMALS, asset, ASSET_DECIMALS).unwrap(), 1_271_223);
}

#[test]
fn a_wider_confidence_lowers_min_out() {
    let wide = Quote { confidence: SPYX_QUOTE.confidence * 2, ..SPYX_QUOTE };
    let usdt_wide = Quote { confidence: USDT_QUOTE.confidence * 2, ..USDT_QUOTE };
    let base = min_out(10_000_000, USDT_QUOTE, USD_DECIMALS, SPYX_QUOTE, ASSET_DECIMALS).unwrap();
    assert!(min_out(10_000_000, USDT_QUOTE, USD_DECIMALS, wide, ASSET_DECIMALS).unwrap() < base);
    assert!(min_out(10_000_000, usdt_wide, USD_DECIMALS, SPYX_QUOTE, ASSET_DECIMALS).unwrap() < base);
}

#[test]
fn min_out_that_cannot_be_computed_is_refused() {
    let zero = Quote { price: 0, confidence: 0, exponent: -8 };
    let tiny = Quote { price: 1, confidence: 0, exponent: -30 };
    assert_eq!(
        min_out(1, Quote::DOLLAR, USD_DECIMALS, zero, ASSET_DECIMALS).unwrap_err(),
        LateriteError::InvalidPriceUpdate.into()
    );
    assert_eq!(min_out(u64::MAX, Quote::DOLLAR, 0, tiny, 18).unwrap_err(), LateriteError::InvalidPriceUpdate.into());
    assert_eq!(
        min_out(1, Quote::DOLLAR, USD_DECIMALS, SPYX_QUOTE, ASSET_DECIMALS).unwrap_err(),
        LateriteError::AmountTooSmall.into()
    );
}

proptest! {
    #[test]
    fn arbitrary_bytes_never_panic(bytes in prop::collection::vec(any::<u8>(), 0..700), feed in any::<u32>(), now in any::<i64>()) {
        let _ = quote(&bytes, feed, now);
    }

    #[test]
    fn a_corrupted_real_update_never_panics(index in 0..PYTH_SPYX_QQQX.len(), byte in any::<u8>(), cut in 0..=PYTH_SPYX_QQQX.len()) {
        let mut update = PYTH_SPYX_QQQX.to_vec();
        update[index] = byte;
        let _ = quote(&update[..cut], SPYX, PYTH_UPDATES_AT);
        let _ = quote(&update, SPYX, PYTH_UPDATES_AT);
    }

    #[test]
    fn min_out_stays_below_the_mid_price_worth(amount in 0..=1_000_000_000u64, price in 1..=10_000_000_000_000u64, bps in 0..=50u64) {
        let asset = Quote { price, confidence: price * bps / 10_000, exponent: -8 };
        let mid = u128::from(amount) * 10u128.pow(10) / u128::from(price);
        prop_assert!(u128::from(min_out(amount, Quote::DOLLAR, USD_DECIMALS, asset, ASSET_DECIMALS).unwrap()) <= mid);
    }
}

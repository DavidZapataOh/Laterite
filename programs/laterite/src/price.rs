//! Pyth Pro prices: reading a feed from a Solana-format update and deriving a swap's minimum output from
//! it. Each update's signature is verified by the Pyth Pro program; these functions only read the bytes.

use {crate::LateriteError, anchor_lang::prelude::*};

/// Oldest price accepted, by the feed's own update time.
pub const MAX_PRICE_AGE_SECONDS: i64 = 60;

/// Widest confidence interval accepted, in basis points of the price.
pub const MAX_CONFIDENCE_BPS: u64 = 50;

/// How far below the oracle's worth a swap may fill, in basis points.
pub const SLIPPAGE_BPS: u64 = 100;

const SOLANA_FORMAT_MAGIC: u32 = 2_182_742_457;
const PAYLOAD_FORMAT_MAGIC: u32 = 2_479_346_549;

/// A price of `price × 10^exponent` dollars, with its confidence in the same units.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Quote {
    pub price: u64,
    pub confidence: u64,
    pub exponent: i16,
}

impl Quote {
    /// Exactly one dollar, for payment tokens counted at face value.
    pub const DOLLAR: Quote = Quote { price: 1, confidence: 0, exponent: 0 };
}

/// The quote of `feed_id` in one Solana-format Pyth Pro update, fresh at `now` and within the confidence
/// bound. Feed 0 is [`Quote::DOLLAR`] and takes no update, so `message` must then be empty.
pub fn quote(message: &[u8], feed_id: u32, now: i64) -> Result<Quote> {
    if feed_id == 0 {
        require!(message.is_empty(), LateriteError::InvalidPriceUpdate);
        return Ok(Quote::DOLLAR);
    }
    let feed = find_feed(payload(message)?, feed_id)?.ok_or(LateriteError::PriceUnavailable)?;
    let (Some(price), Some(confidence), Some(exponent), Some(updated_at)) =
        (feed.price, feed.confidence, feed.exponent, feed.updated_at)
    else {
        return err!(LateriteError::PriceUnavailable);
    };
    let price = u64::try_from(price).map_err(|_| LateriteError::PriceUnavailable)?;
    let confidence = u64::try_from(confidence).map_err(|_| LateriteError::PriceUnavailable)?;
    require!(now.saturating_sub((updated_at / 1_000_000) as i64) <= MAX_PRICE_AGE_SECONDS, LateriteError::StalePrice);
    require!(
        u128::from(confidence) * 10_000 <= u128::from(price) * u128::from(MAX_CONFIDENCE_BPS),
        LateriteError::PriceUncertain
    );
    Ok(Quote { price, confidence, exponent })
}

/// Minimum raw output of a swap of `amount` raw units of a payment token into an asset: the amount's worth at
/// the payment token's lowest price over the asset's highest, both within confidence, less [`SLIPPAGE_BPS`].
/// The two quotes come from separately verified updates, or [`Quote::DOLLAR`] for a token counted at one dollar.
/// Fails rather than return 0 for a positive amount, since a zero minimum bounds nothing. Asset prices are per
/// whole token in raw amounts, so the ScaledUiAmount multiplier never enters.
pub fn min_out(amount: u64, payment: Quote, payment_decimals: u8, asset: Quote, asset_decimals: u8) -> Result<u64> {
    let worth = u128::from(amount) * u128::from(payment.price.saturating_sub(payment.confidence));
    let asset_price = u128::from(asset.price) + u128::from(asset.confidence);
    let scale = i32::from(payment.exponent) - i32::from(asset.exponent) + i32::from(asset_decimals)
        - i32::from(payment_decimals);
    let factor = 10u128.checked_pow(scale.unsigned_abs()).ok_or(LateriteError::InvalidPriceUpdate)?;
    let (numerator, denominator) = if scale >= 0 {
        (worth.checked_mul(factor), Some(asset_price))
    } else {
        (Some(worth), asset_price.checked_mul(factor))
    };
    let out = numerator
        .zip(denominator.filter(|&d| d > 0))
        .and_then(|(n, d)| (n / d).checked_mul(u128::from(10_000 - SLIPPAGE_BPS)))
        .ok_or(LateriteError::InvalidPriceUpdate)?
        / 10_000;
    require!(out > 0 || amount == 0, LateriteError::AmountTooSmall);
    u64::try_from(out).map_err(|_| error!(LateriteError::InvalidPriceUpdate))
}

#[derive(Default)]
struct Feed {
    price: Option<i64>,
    confidence: Option<i64>,
    exponent: Option<i16>,
    updated_at: Option<u64>,
}

/// The payload of a Solana-format message: magic, signature (64), public key (32), `u16` length, payload.
fn payload(message: &[u8]) -> Result<&[u8]> {
    let mut reader = Reader(message);
    require!(reader.u32()? == SOLANA_FORMAT_MAGIC, LateriteError::InvalidPriceUpdate);
    reader.skip(96)?;
    let len = usize::from(reader.u16()?);
    require!(reader.0.len() == len, LateriteError::InvalidPriceUpdate);
    Ok(reader.0)
}

fn find_feed(payload: &[u8], feed_id: u32) -> Result<Option<Feed>> {
    let mut reader = Reader(payload);
    require!(reader.u32()? == PAYLOAD_FORMAT_MAGIC, LateriteError::InvalidPriceUpdate);
    reader.skip(9)?; // timestamp and channel
    for _ in 0..reader.u8()? {
        let id = reader.u32()?;
        let mut feed = Feed::default();
        for _ in 0..reader.u8()? {
            match reader.u8()? {
                0 => feed.price = reader.nonzero()?,
                4 => feed.exponent = Some(reader.i16()?),
                5 => feed.confidence = reader.nonzero()?,
                12 => feed.updated_at = reader.optional()?,
                1 | 2 | 10 | 11 => reader.skip(8)?,
                3 | 9 => reader.skip(2)?,
                6..=8 => _ = reader.optional()?,
                _ => return err!(LateriteError::InvalidPriceUpdate),
            }
        }
        if id == feed_id {
            return Ok(Some(feed));
        }
    }
    Ok(None)
}

/// Little-endian reads that fail on truncation instead of panicking.
struct Reader<'a>(&'a [u8]);

impl Reader<'_> {
    fn take<const N: usize>(&mut self) -> Result<[u8; N]> {
        let (head, rest) = self.0.split_first_chunk::<N>().ok_or(LateriteError::InvalidPriceUpdate)?;
        self.0 = rest;
        Ok(*head)
    }

    fn skip(&mut self, len: usize) -> Result<()> {
        self.0 = self.0.get(len..).ok_or(LateriteError::InvalidPriceUpdate)?;
        Ok(())
    }

    fn u8(&mut self) -> Result<u8> {
        Ok(self.take::<1>()?[0])
    }

    fn u16(&mut self) -> Result<u16> {
        Ok(u16::from_le_bytes(self.take()?))
    }

    fn i16(&mut self) -> Result<i16> {
        Ok(i16::from_le_bytes(self.take()?))
    }

    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.take()?))
    }

    /// An `i64` where 0 encodes "absent".
    fn nonzero(&mut self) -> Result<Option<i64>> {
        Ok(Some(i64::from_le_bytes(self.take()?)).filter(|&value| value != 0))
    }

    /// A presence flag, then a `u64` when present.
    fn optional(&mut self) -> Result<Option<u64>> {
        match self.u8()? {
            0 => Ok(None),
            1 => Ok(Some(u64::from_le_bytes(self.take()?))),
            _ => err!(LateriteError::InvalidPriceUpdate),
        }
    }
}

/** Weekly tiers in USD with 6 decimals: $10 and $25. A user's tier is their combined weekly cap. */
export const TIERS = [10_000_000n, 25_000_000n] as const;

/** Weekly cap during a user's first week: $5. */
export const TRIAL_CAP = 5_000_000n;

/** Seconds in a day; days are counted in UTC from 1970-01-01. */
export const DAY_SECONDS = 86_400n;

/** A user's weeks start at `enrolledAt`. */
export const WEEK_SECONDS = 7n * DAY_SECONDS;

/** Length of the trial: the user's first week. */
export const TRIAL_SECONDS = WEEK_SECONDS;

/** Every plan's period: one week. */
export const PLAN_PERIOD_HOURS = 168n;

/** Plan ids reserved per payment token. */
export const PLAN_IDS_PER_TOKEN = 2;

/** Entries in the payment-token table: USDC and USDT. */
export const PAYMENT_TOKEN_COUNT = 2;

/** Days a market calendar spans from the day it is loaded. */
export const CALENDAR_DAYS = 1_464;

/** Income rule: the share of each incoming payment invested, in basis points (10%). */
export const INCOME_SHARE_BPS = 1_000n;

/** Income rule: smaller incoming payments are ignored ($50). */
export const INCOME_MIN = 50_000_000n;

/** Change per payment rounds each outgoing payment up to the next dollar... */
export const CHANGE_STEP = 1_000_000n;

/** ...and invests at least $0.50 per payment, before the multiplier. */
export const CHANGE_MIN = 500_000n;

/** Oldest price the program accepts, by the feed's own update time. */
export const MAX_PRICE_AGE_SECONDS = 60n;

/** Widest confidence interval the program accepts, in basis points of the price. */
export const MAX_CONFIDENCE_BPS = 50n;

/** How far below the oracle's worth a sweep's swap may fill, in basis points. */
export const SLIPPAGE_BPS = 100n;

/** Decimals of every payment token: one dollar is 1,000,000 raw units. */
export const USD_DECIMALS = 6;

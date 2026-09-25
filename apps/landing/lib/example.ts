/** The page's worked example: a $25 weekly cap, a year of weekly bricks, and one brick more in the wallet. */
export const example = {
    cap: 25,
    bricks: 52,
    wallet: { before: 0.4532, after: 0.4944 },
} as const;

/** Dollars in `locale`'s digits, with a bare `$`. */
export const dollars = (locale: string) =>
    new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', currencyDisplay: 'narrowSymbol' });

/** Shares to four decimals in `locale`'s digits. */
export const shares = (locale: string) =>
    new Intl.NumberFormat(locale, { minimumFractionDigits: 4, maximumFractionDigits: 4 });

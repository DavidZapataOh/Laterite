/**
 * Countries where Laterite cannot be used, by ISO 3166-1 alpha-2 code: every country the issuer of xStocks
 * (Backed Assets) prohibits or does not serve (https://assets.backed.fi/legal-documentation/restricted-countries),
 * the United States with its territories (xStocks may not be offered to anyone located there), and the United
 * Kingdom, Canada and Australia, where xStocks are not available (https://xstocks.fi).
 */
export const BLOCKED_COUNTRIES: ReadonlySet<string> = new Set([
    // prohibited: international sanctions
    'IR',
    'KP',
    'SY',
    // prohibited: the United States and its territories
    'US',
    'AS',
    'GU',
    'MP',
    'PR',
    'UM',
    'VI',
    // not available
    'AU',
    'CA',
    'GB',
    // not serviced
    'AF',
    'BY',
    'CD',
    'CF',
    'CU',
    'ET',
    'HT',
    'IQ',
    'LB',
    'LY',
    'ML',
    'MM',
    'MZ',
    'NG',
    'NI',
    'PH',
    'RU',
    'SD',
    'SO',
    'SS',
    'VE',
    'YE',
    'ZW',
]);

/**
 * The occupied regions of Ukraine the issuer does not serve, by ISO 3166-2 code: Crimea, Sevastopol, and the
 * Donetsk, Luhansk, Zaporizhzhia and Kherson oblasts.
 */
export const BLOCKED_REGIONS: ReadonlySet<string> = new Set(['UA-09', 'UA-14', 'UA-23', 'UA-40', 'UA-43', 'UA-65']);

/** Where a request comes from, as Vercel's edge geolocates it; both are null off Vercel. */
export type RequestRegion = { country: string | null; region: string | null };

/** Reads `x-vercel-ip-country` and `x-vercel-ip-country-region` into a country and an ISO 3166-2 region. */
export function requestRegion(headers: Headers): RequestRegion {
    const country = headers.get('x-vercel-ip-country')?.toUpperCase() || null;
    const subdivision = headers.get('x-vercel-ip-country-region')?.toUpperCase() || null;
    return { country, region: country && subdivision ? `${country}-${subdivision}` : null };
}

/** True when Laterite cannot be offered to a request from `country` (and `region`). */
export function isBlocked({ country, region }: RequestRegion): boolean {
    return (country !== null && BLOCKED_COUNTRIES.has(country)) || (region !== null && BLOCKED_REGIONS.has(region));
}

import { NextRequest } from 'next/server';
import { getRewrittenUrl, isRewrite, unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { describe, expect, it } from 'vitest';

import { BLOCKED_COUNTRIES, isBlocked, requestRegion } from '@/lib/geo';
import proxy, { config } from '@/proxy';

const from = (country?: string, region?: string, path = '/', init: { method?: string } = {}) =>
    new NextRequest(`https://app.laterite.cash${path}`, {
        ...init,
        headers: {
            ...(country ? { 'x-vercel-ip-country': country } : {}),
            ...(region ? { 'x-vercel-ip-country-region': region } : {}),
        },
    });

describe('isBlocked', () => {
    it('blocks every country the issuer prohibits or does not serve, and none it does', () => {
        for (const country of ['US', 'PR', 'GB', 'CA', 'AU', 'IR', 'KP', 'SY', 'RU', 'VE', 'NG', 'PH']) {
            expect(isBlocked({ country, region: null }), country).toBe(true);
        }
        for (const country of ['AR', 'BR', 'MX', 'CO', 'ES', 'DE', 'FR', 'IN', 'JP', 'UA']) {
            expect(isBlocked({ country, region: null }), country).toBe(false);
        }
        expect(BLOCKED_COUNTRIES.size).toBe(36);
    });

    it('blocks the occupied regions of Ukraine and not the rest of it', () => {
        expect(isBlocked(requestRegion(from('UA', '43').headers))).toBe(true);
        expect(isBlocked(requestRegion(from('UA', '14').headers))).toBe(true);
        expect(isBlocked(requestRegion(from('UA', '30').headers))).toBe(false);
    });

    it('lets a request without geolocation through: only Vercel sets the headers', () => {
        expect(requestRegion(from().headers)).toEqual({ country: null, region: null });
        expect(isBlocked(requestRegion(from().headers))).toBe(false);
    });
});

describe('proxy', () => {
    it('runs on pages and the API, never on assets', () => {
        for (const url of ['/', '/es', '/unavailable', '/api/eligibility']) {
            expect(unstable_doesMiddlewareMatch({ config, url }), url).toBe(true);
        }
        for (const url of ['/_next/static/chunks/app.js', '/icon.svg']) {
            expect(unstable_doesMiddlewareMatch({ config, url }), url).toBe(false);
        }
    });

    it('shows a blocked request the unavailable screen, in its locale, as 451', () => {
        const english = proxy(from('US'));
        expect(isRewrite(english)).toBe(true);
        expect(getRewrittenUrl(english)).toBe('https://app.laterite.cash/en/unavailable');
        expect(english.status).toBe(451);
        expect(getRewrittenUrl(proxy(from('GB', undefined, '/es')))).toBe(
            'https://app.laterite.cash/es-AR/unavailable',
        );
    });

    it('refuses a blocked request to the API', async () => {
        const response = proxy(from('US', undefined, '/api/eligibility', { method: 'POST' }));
        expect(response.status).toBe(451);
        expect(await response.json()).toEqual({ error: 'unavailable' });
    });

    it('routes an allowed request by locale', () => {
        expect(getRewrittenUrl(proxy(from('AR')))).toBe('https://app.laterite.cash/en');
        expect(getRewrittenUrl(proxy(from('AR', undefined, '/es')))).toBe('https://app.laterite.cash/es-AR');
        expect(proxy(from('AR', undefined, '/api/eligibility')).headers.get('x-middleware-next')).toBe('1');
    });
});

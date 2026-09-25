import { type NextRequest, NextResponse } from 'next/server';
import createMiddleware from 'next-intl/middleware';
import { routing } from '@laterite/i18n/routing';
import { isBlocked, requestRegion } from './lib/geo';

const handleI18nRouting = createMiddleware(routing);

/**
 * Geoblocking, then locale routing. A request from a country or region where Laterite cannot be offered gets the
 * unavailable screen in its locale, and the API refuses it, both as 451 Unavailable For Legal Reasons.
 */
export default function proxy(request: NextRequest) {
    const api = request.nextUrl.pathname.startsWith('/api/');
    if (isBlocked(requestRegion(request.headers))) {
        if (api) return NextResponse.json({ error: 'unavailable' }, { status: 451 });
        const routed = handleI18nRouting(request);
        // a locale redirect comes back through here
        if (!routed.headers.has('x-middleware-rewrite')) return routed;
        const [, locale] = new URL(routed.headers.get('x-middleware-rewrite')!).pathname.split('/');
        return NextResponse.rewrite(new URL(`/${locale}/unavailable`, request.url), { status: 451 });
    }
    return api ? NextResponse.next() : handleI18nRouting(request);
}

export const config = {
    matcher: '/((?!_next|_vercel|.*\\..*).*)',
};

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hasLocale } from 'next-intl';
import { getTranslations } from 'next-intl/server';
import { ImageResponse } from 'next/og';
import { routing } from '@laterite/i18n/routing';

const size = { width: 1200, height: 630 };
// Course size in px: the widest course (Spanish "UN COBRO.", 7.34 em at width 125) fills the card's 1,072 px measure
const COURSE = 144;
const contentType = 'image/png';

const dataUrl = (bytes: Buffer, type: string) => `data:${type};base64,${bytes.toString('base64')}`;

const localeOf = async (params: Promise<{ locale: string }> | { locale: string }) => {
    const { locale } = await params;
    return hasLocale(routing.locales, locale) ? locale : routing.defaultLocale;
};

/** One card per locale, with the headline's alt text in that locale. */
export async function generateImageMetadata({ params }: { params: Promise<{ locale: string }> }) {
    const t = await getTranslations({ locale: await localeOf(params), namespace: 'landing.meta' });
    return [{ id: 'card', alt: t('imageAlt'), size, contentType }];
}

/** The shared card: the lockup, the hero's three courses and its brick, on lime. Rendered once per locale at build. */
export default async function Image({ params }: { params: Promise<{ locale: string }> }) {
    const t = await getTranslations({ locale: await localeOf(params), namespace: 'landing.hero' });
    const [font, symbol, wordmark, brick] = await Promise.all([
        readFile(join(process.cwd(), 'assets/fonts/archivo-expanded-black-latin.ttf')),
        readFile(join(process.cwd(), 'node_modules/@laterite/ui/brand/symbol-terracotta.svg')),
        readFile(join(process.cwd(), 'node_modules/@laterite/ui/brand/wordmark-ink.svg')),
        readFile(join(process.cwd(), 'public/hero/brick-25.png')),
    ]);

    return new ImageResponse(
        <div
            style={{
                width: '100%',
                height: '100%',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                padding: '56px 64px 64px',
                background: '#F4EEE2',
                color: '#1E1612',
                fontFamily: 'Archivo',
            }}
        >
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14 }}>
                <img src={dataUrl(symbol, 'image/svg+xml')} width={60} height={60} alt="" />
                <img src={dataUrl(wordmark, 'image/svg+xml')} width={185} height={30} alt="" />
            </div>
            {/* the hero's forme: three courses, the brick in the second course's gap, ending with the first */}
            <div
                style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignSelf: 'flex-start',
                    fontSize: COURSE,
                    lineHeight: 0.886,
                    letterSpacing: -0.015 * COURSE,
                    textTransform: 'uppercase',
                }}
            >
                <span>{t('first')}</span>
                <div style={{ display: 'flex', position: 'relative' }}>
                    <span>{t('second')}</span>
                    <img
                        src={dataUrl(brick, 'image/png')}
                        width={2.36 * COURSE}
                        height={(2.36 * COURSE * 2) / 3}
                        alt=""
                        style={{ position: 'absolute', right: 0, top: -0.126 * COURSE }}
                    />
                </div>
                <span>{t('third')}</span>
            </div>
        </div>,
        { ...size, fonts: [{ name: 'Archivo', data: font, weight: 900, style: 'normal' }] },
    );
}

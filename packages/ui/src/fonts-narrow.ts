import localFont from 'next/font/local';

// Martian Mono with its width axis (75-112.5), for the app's dense rows of labels and chips. Self-hosted under a family
// of its own (fonts/, latin, from Google Fonts' `Martian+Mono:wdth,wght@75..112.5,100..800`, OFL): Google's face of
// the same family would merge with the regular one and move every regular line's metrics. Preloaded, since the
// fallback's wider glyphs wrap the rows until it arrives; its own entry keeps it out of pages that never set it.
export const martianMonoNarrow = localFont({
    variable: '--font-martian-mono-narrow',
    src: '../fonts/martian-mono-narrow-latin.woff2',
    weight: '100 800',
    declarations: [{ prop: 'font-stretch', value: '75% 112.5%' }],
    display: 'swap',
    preload: true,
});

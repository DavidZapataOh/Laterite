import { Archivo, Martian_Mono } from 'next/font/google';
import localFont from 'next/font/local';

// Archivo carries both voices: width 110-125 at weight 900 for display,
// width 100 for running text. The width axis must be requested explicitly.
export const archivo = Archivo({
    variable: '--font-archivo',
    subsets: ['latin'],
    axes: ['wdth'],
    display: 'swap',
});

// Every amount, date, label and address is set in Martian Mono.
export const martianMono = Martian_Mono({
    variable: '--font-martian-mono',
    subsets: ['latin'],
    display: 'swap',
});

/** Class names that define `--font-archivo` and `--font-martian-mono`; set them on `<html>`. */
export const fontVariables = `${archivo.variable} ${martianMono.variable}`;

// Martian Mono with its width axis (75-112.5), for dense rows of labels and chips. Google's face of the same family
// would merge with the regular one and move every regular line's metrics, so this one is self-hosted under a family
// of its own (fonts/, latin, from Google Fonts' `Martian+Mono:wdth,wght@75..112.5,100..800`, OFL) and loaded only
// where a page uses it.
export const martianMonoNarrow = localFont({
    variable: '--font-martian-mono-narrow',
    src: '../fonts/martian-mono-narrow-latin.woff2',
    weight: '100 800',
    declarations: [{ prop: 'font-stretch', value: '75% 112.5%' }],
    display: 'swap',
    preload: false,
});

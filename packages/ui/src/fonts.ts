import { Archivo, Martian_Mono } from 'next/font/google';

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

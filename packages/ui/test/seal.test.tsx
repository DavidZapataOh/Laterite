import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Seal } from '../src/seal';

describe('Seal', () => {
    it('is an image named by its label and main line', () => {
        const svg = renderToStaticMarkup(<Seal label="Capped" main="$25 / WK" />);
        expect(svg).toContain('role="img"');
        expect(svg).toContain('aria-label="Capped: $25 / WK"');
    });

    it('is hidden from assistive tech when decorative', () => {
        const svg = renderToStaticMarkup(<Seal decorative main="$25 / WK" />);
        expect(svg).toContain('aria-hidden="true"');
        expect(svg).not.toContain('role="img"');
    });

    it('widens for mono stamps', () => {
        expect(renderToStaticMarkup(<Seal mono main="TRIAL · 7 DAYS · CAP $5" />)).toContain('viewBox="0 0 470 120"');
    });

    it('derives its ink roughness from its text', () => {
        expect(renderToStaticMarkup(<Seal main="$25 / WK" />)).toContain('seed="24"');
    });
});

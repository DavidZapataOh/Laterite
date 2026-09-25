import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Back } from '../src/back';
import { Disclosure } from '../src/disclosure';

describe('Disclosure', () => {
    it('is a native details element whose summary is the line and a drawn chevron', () => {
        const html = renderToStaticMarkup(<Disclosure summary="What is SPYx?">A token.</Disclosure>);
        expect(html).toMatch(/^<details class="[^"]+"><summary class="[^"]+"><span>What is SPYx\?<\/span><svg/);
        expect(html).toContain('aria-hidden="true"');
        expect(html).toMatch(/<\/summary><div class="[^"]+">A token\.<\/div><\/details>$/);
    });
});

describe('Back', () => {
    it('is a button with a drawn arrow before its text', () => {
        const html = renderToStaticMarkup(<Back className="mono">Your rules</Back>);
        expect(html).toMatch(/^<button type="button" class="\S+ mono"><svg[^>]+aria-hidden="true"/);
        expect(html).toContain('<span>Your rules</span></button>');
    });
});

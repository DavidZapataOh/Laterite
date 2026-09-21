import { describe, expect, it } from 'vitest';

import { slice } from '../src/use-scroll-progress';

describe('slice', () => {
    it('eases a window of progress out', () => {
        expect(slice(0.5, 0, 1)).toBeCloseTo(0.875);
        expect(slice(0.4, 0.2, 0.6)).toBeCloseTo(0.875);
    });

    it('clamps outside the window', () => {
        expect(slice(0.1, 0.2, 0.6)).toBe(0);
        expect(slice(0.9, 0.2, 0.6)).toBe(1);
    });
});

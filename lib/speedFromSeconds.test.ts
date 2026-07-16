import { describe, it, expect } from 'vitest';
import { speedFromSeconds } from './speedFromSeconds';

// Characterization tests — see heightFromSeconds.test.ts. This pins the mph
// figure shown after a throw.
describe('speedFromSeconds', () => {
  it('returns 0 for no airtime', () => {
    expect(speedFromSeconds(0)).toBe(0);
  });

  it('matches known values (mph)', () => {
    expect(speedFromSeconds(1)).toBeCloseTo(10.9615, 3);
    expect(speedFromSeconds(2)).toBeCloseTo(21.923, 3);
  });

  it('is linear in airtime (2x airtime -> 2x speed)', () => {
    expect(speedFromSeconds(2) / speedFromSeconds(1)).toBeCloseTo(2, 5);
  });
});

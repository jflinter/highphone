import { describe, it, expect } from 'vitest';
import { heightFromSeconds } from './heightFromSeconds';

// Characterization tests: they pin the CURRENT physics output. Leaderboard
// heights are derived from this function, so if a refactor changes any of these
// numbers, throw heights changed — which must never happen silently. Only touch
// these with a deliberate, understood reason.
describe('heightFromSeconds', () => {
  it('returns 0 for no airtime', () => {
    expect(heightFromSeconds(0)).toBe(0);
  });

  it('matches known values (feet)', () => {
    expect(heightFromSeconds(1)).toBeCloseTo(4.019225, 5);
    expect(heightFromSeconds(2)).toBeCloseTo(16.0769, 4);
    expect(heightFromSeconds(3)).toBeCloseTo(36.173025, 5);
  });

  it('is monotonic in airtime', () => {
    expect(heightFromSeconds(2)).toBeGreaterThan(heightFromSeconds(1));
    expect(heightFromSeconds(3)).toBeGreaterThan(heightFromSeconds(2));
  });

  it('scales with the square of airtime (2x airtime -> 4x height)', () => {
    expect(heightFromSeconds(2) / heightFromSeconds(1)).toBeCloseTo(4, 5);
  });
});

import { describe, it, expect } from 'vitest';
import { isProfane } from './profanity';

// We deliberately do NOT hardcode slurs in this repo. These cover the behavior
// we actually rely on: obfuscated profanity is caught, and ordinary names are
// not false-positived (the classic "Scunthorpe problem"). Real offending
// leaderboard names are covered by the same underlying obscenity dataset.
describe('isProfane', () => {
  it('flags obfuscated profanity (leetspeak)', () => {
    expect(isProfane('sh1t')).toBe(true);
  });

  it('allows normal names', () => {
    for (const name of [
      'Jack',
      'Seeker of glory',
      'CoolThrower99',
      'Finn Kaufmann',
    ]) {
      expect(isProfane(name)).toBe(false);
    }
  });

  it('does not false-positive on the Scunthorpe problem', () => {
    expect(isProfane('Scunthorpe')).toBe(false);
    expect(isProfane('assassin')).toBe(false);
  });
});

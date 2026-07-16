import {
  RegExpMatcher,
  englishDataset,
  englishRecommendedTransformers,
} from 'obscenity';

// Catches obfuscated variants too (leetspeak, spacing, etc.) since people
// actively try to sneak slurs past filters. Display-side only — we never
// block name entry, we just hide offending names from the leaderboard for
// everyone except the offender themselves (a shadowban).
const matcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

export const isProfane = (name: string): boolean => matcher.hasMatch(name);

import { randomInt } from 'node:crypto';

/**
 * Memorable fallback branch names for sessions created with no title, no
 * prompt, and no requested branch — a water-themed word pair reads better in
 * a branch list than a uuid fragment ever did.
 */
const ADJECTIVES = [
  'still',
  'quiet',
  'misty',
  'silver',
  'rippling',
  'glassy',
  'mossy',
  'pebbled',
  'shallow',
  'drifting',
  'murmuring',
  'gleaming',
  'dappled',
  'reedy',
  'bright',
  'hidden',
  'wandering',
  'gentle',
  'restless',
  'lilting',
  'cool',
  'clear',
  'winding',
  'lapping',
];

const NOUNS = [
  'brook',
  'beck',
  'tarn',
  'mere',
  'lagoon',
  'eddy',
  'rill',
  'spring',
  'creek',
  'delta',
  'estuary',
  'shoal',
  'cove',
  'inlet',
  'cascade',
  'pool',
  'bay',
  'marsh',
  'fen',
  'loch',
  'burn',
  'ford',
  'weir',
  'firth',
];

export function wordPairName(): string {
  return `${ADJECTIVES[randomInt(ADJECTIVES.length)]}-${NOUNS[randomInt(NOUNS.length)]}`;
}

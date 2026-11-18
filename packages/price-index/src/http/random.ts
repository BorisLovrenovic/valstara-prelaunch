import { randomInt } from 'node:crypto';

// Randomness is seeded (epic rule 9): the jitter draws from a source built
// from a seed, so a test fixes the seed and gets the same delays every time.

/** A uniform draw in [0, 1). */
export type Random = () => number;

/**
 * Mulberry32, a small 32-bit generator. It only spaces requests out, so it
 * needs to be uniform and reproducible, not unpredictable.
 */
export function seededRandom(seed: number): Random {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** A generator seeded from the operating system, for the founder's run. */
export function freshRandom(): Random {
  return seededRandom(randomInt(0, 2 ** 32 - 1));
}

import { describe, expect, it } from 'vitest';
import { chunk } from '../src/core/chunk.js';

describe('chunk', () => {
  it('cuts a list into pieces of at most the size asked for', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([1, 2], 5)).toEqual([[1, 2]]);
  });

  it('makes no pieces at all out of nothing', () => {
    // Not one empty piece: a caller looping over this asks for nothing rather
    // than asking for nothing once.
    expect(chunk([], 5)).toEqual([]);
    expect(chunk([], Number.POSITIVE_INFINITY)).toEqual([]);
  });

  it('never asks for nothing, however small the size', () => {
    // A size of zero would otherwise make a loop that never advances.
    expect(chunk([1, 2], 0)).toEqual([[1], [2]]);
    expect(chunk([1, 2], -3)).toEqual([[1], [2]]);
  });

  it('takes an uncapped axis as one piece', () => {
    // What the planner's caps resolve to when a site names none.
    expect(chunk([1, 2, 3], Number.POSITIVE_INFINITY)).toEqual([[1, 2, 3]]);
  });

  it('always hands back a copy', () => {
    // A piece becomes the `channels` array a site is given, and site code
    // sorting it in place must not reach back into the planner's own list.
    const items = [1, 2, 3];
    const [only] = chunk(items, 10);

    only!.sort((left, right) => right - left);

    expect(items).toEqual([1, 2, 3]);
  });
});

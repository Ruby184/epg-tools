import { describe, expect, it } from 'vitest';
import { inParallel } from '../src/core/parallel.js';

describe('inParallel', () => {
  it('runs every item, no more than limit at once', async () => {
    let running = 0;
    let most = 0;
    const done: number[] = [];

    await inParallel([1, 2, 3, 4, 5, 6, 7], 3, async (item) => {
      running++;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      done.push(item);
      running--;
    });

    expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(most).toBe(3);
  });

  it('refuses a limit that would run nothing', async () => {
    for (const limit of [0, -1, Number.NaN, 1.5]) {
      await expect(inParallel([1], limit, async () => {})).rejects.toThrow(RangeError);
    }
  });

  it('starts nothing more once an item has failed', async () => {
    const started: number[] = [];

    await expect(
      inParallel(
        Array.from({ length: 100 }, (_, i) => i),
        2,
        async (item) => {
          started.push(item);
          await new Promise((resolve) => setTimeout(resolve, 1));

          if (item === 0) {
            throw new Error('unreadable');
          }
        },
      ),
    ).rejects.toThrow('unreadable');

    // Wait out anything still going, then see what was begun: the two at
    // first, and at most the one the other worker took before it heard.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(started.length).toBeLessThanOrEqual(3);
  });

  it('takes items as they are made, no further ahead than there are workers', async () => {
    const done: number[] = [];
    let made = 0;
    let most = 0;

    async function* listing(): AsyncGenerator<number> {
      for (let item = 0; item < 20; item++) {
        made++;
        // Made and not yet done: one a worker each, this one included.
        most = Math.max(most, made - done.length);
        yield item;
      }
    }

    await inParallel(listing(), 3, async (item) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      done.push(item);
    });

    expect(done.toSorted((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(most).toBe(3);
  });

  it('closes a source it stops taking from, and answers with the failure', async () => {
    let closed = false;

    async function* listing(): AsyncGenerator<number> {
      try {
        for (let item = 0; ; item++) {
          yield item;
        }
      } finally {
        closed = true;
      }
    }

    await expect(
      inParallel(listing(), 2, async (item) => {
        if (item === 3) {
          throw new Error('unreadable');
        }
      }),
    ).rejects.toThrow('unreadable');
    expect(closed).toBe(true);
  });

  it('takes nothing more from a source once an item has failed', async () => {
    const started: number[] = [];

    async function* listing(): AsyncGenerator<number> {
      yield 0;
      // The next one is slow to come, and comes after the failure.
      await new Promise((resolve) => setTimeout(resolve, 10));
      yield 1;
    }

    await expect(
      inParallel(listing(), 2, async (item) => {
        started.push(item);

        if (item === 0) {
          throw new Error('unreadable');
        }
      }),
    ).rejects.toThrow('unreadable');

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(started).toEqual([0]);
  });

  it('answers with what the source threw', async () => {
    async function* listing(): AsyncGenerator<number> {
      yield 1;
      throw new Error('EACCES');
    }

    await expect(inParallel(listing(), 2, async () => {})).rejects.toThrow('EACCES');
  });
});

/**
 * A `localWork` slot that its work lets go of while it waits on the network.
 *
 * `localWork` bounds what never leaves the machine — a parse, and the write it
 * is for — because that is what holds open files and live programme lists. A
 * parse that asks for a request of its own through `paced` is doing neither
 * while it waits for the answer, and used to hold its slot for the whole of it.
 * A site that fetches a detail per programme then filled every slot in the run
 * with parses waiting on its own pacing, and every other site's parses queued
 * behind them: a consumer measured a site whose two requests took under a
 * second finishing after 170, beside one making a few thousand detail calls.
 *
 * So the slot is held only while the work is working. It is given up when the
 * first of the work's waits begins, and taken back when the last of them ends —
 * ahead of work that has not started, since a channel-day already in hand is
 * finished rather than joined by another. Between two waits the parse runs on
 * the slot it took back, and the write that follows the parse always does.
 */

import type PQueue from 'p-queue';
import type { Enqueue } from './site-run.js';

export class LocalSlot {
  readonly #queue: PQueue;
  readonly #enqueue: Enqueue;
  readonly #priority: number;

  /** How many of this work's waits are in flight. A slot is held only at nought. */
  #away = 0;

  /** Lets go of the slot, while one is held. */
  #release: (() => void) | undefined;

  /** A slot being waited for, so two waits ending together ask for one, not two. */
  #taking: Promise<void> | undefined;

  /**
   * Whether the work has finished. A wait it started and never awaited can end
   * after that, and must not take a slot that nothing would then let go of.
   */
  #done = false;

  constructor(queue: PQueue, enqueue: Enqueue, priority: number) {
    this.#queue = queue;
    this.#enqueue = enqueue;
    this.#priority = priority;
  }

  /** Do the work holding a slot, except while it is {@link away}. */
  async hold<T>(work: () => Promise<T>): Promise<T> {
    await this.#settle(this.#priority);

    try {
      return await work();
    } finally {
      this.#done = true;
      this.#letGo();
    }
  }

  /** Wait on something that is not local work, with the slot free for others meanwhile. */
  async away<T>(wait: () => Promise<T>): Promise<T> {
    if (this.#away++ === 0) {
      this.#letGo();
    }

    try {
      return await wait();
    } finally {
      if (--this.#away === 0) {
        // One above the work's own priority: back ahead of anything that has
        // not started yet.
        await this.#settle(this.#priority + 1);
      }
    }
  }

  /**
   * Hold a slot, unless the work has gone away again in the meantime — two
   * waits in flight at once can end and begin around each other, and only the
   * count at the moment the slot arrives says whether it is wanted.
   */
  async #settle(priority: number): Promise<void> {
    while (this.#away === 0 && this.#release === undefined && !this.#done) {
      // Cleared here rather than by the task: p-queue may start a task inside
      // `add` itself, which would clear it before this line had set it, and a
      // request left pointing at a settled promise is a loop that never yields.
      this.#taking ??= this.#take(priority).finally(() => {
        this.#taking = undefined;
      });
      await this.#taking;
    }
  }

  /**
   * One queue task that lasts until the slot is let go of.
   *
   * Through `enqueue`, so a cancelled run drops it while it waits and the work
   * sees the rejection rather than hanging on a queue that has stopped.
   */
  #take(priority: number): Promise<void> {
    return new Promise<void>((taken, failed) => {
      this.#enqueue(
        this.#queue,
        () =>
          new Promise<void>((done) => {
            if (this.#away > 0 || this.#done) {
              // Not wanted any more: handed straight back.
              done();
            } else {
              this.#release = done;
            }

            taken();
          }),
        { priority },
      ).catch((error: unknown) => {
        // A cancel. A slot that never started is how the work hears why; one
        // that had started has already settled `taken`, so this is a no-op.
        failed(error);
      });
    });
  }

  #letGo(): void {
    const release = this.#release;

    this.#release = undefined;
    release?.();
  }
}

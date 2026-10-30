/**
 * A threaded site's counts, in memory its thread and the run's both see — so a
 * thread that dies has lost none of what it counted, and nothing of the
 * counting crosses as a message but each request count's name, once.
 *
 * When its thread began on it takes the first slot, its channel-day counts
 * — `GrabCounts` — the ones after, and where its time went — `msBy`, in
 * microseconds — the ones after those: always the same slots, which need no
 * name, and which the
 * run's thread sees as soon as they are written — so a thread that dies leaves
 * no doubt whether the site had begun, or had counted itself failed. After
 * them, a label is given three slots side by side when it is first counted,
 * for the three counts every label has — its `requests`, its `requestMs`, then
 * its `waitedMs` — and a kind of failure one of its own when it first fails
 * that way: those are the names said. The site's thread alone adds to them,
 * and the run's reads them when the site is done, or its thread gone. Counts
 * it has no slot left for — a site of more labels and failures than
 * {@link SLOTS} holds — are handed back for the thread to say another way.
 *
 * Its time is added as everything else is, with `Atomics`, though that makes a
 * `BigInt` of every stretch its clock gives out: about 65ns a stretch, against
 * 2ns for a float added without — measured, some 1.4ms of a grab of 7,000
 * channel-days one request at a time, which is none worth one rule less.
 */

import {
  MEASURED_TIME,
  noRequests,
  type GrabCounts,
  type MeasuredTime,
  type RequestCounts,
} from '../core/events.js';
import { addRequests } from './session.js';

/** How many counts a site's memory holds: far more than any site names. */
export const SLOTS = 1024;

/**
 * The channel-day counts, in the order of their slots from {@link Slot.TALLY}:
 * every one of `GrabCounts`, which `count` and `tally` do not compile without.
 */
const TALLIED = [
  'fetched',
  'empty',
  'fromCache',
  'unchanged',
  'failed',
  'sitesFailed',
] as const satisfies ReadonlyArray<keyof GrabCounts>;

/** Where in a site's memory each thing is that is always there, before any label's slots. */
const Slot = {
  /** When the site's thread began on it — nought, until it has. */
  BEGAN: 0,
  /** Where the channel-day counts start, in the order of {@link TALLIED}. */
  TALLY: 1,
  /** Where its time starts, in the order of `MEASURED_TIME`, in microseconds. */
  SPENT: 1 + TALLIED.length,
} as const;

/**
 * Each channel-day count by its slot's place after {@link Slot.TALLY}, and each
 * part of a site's time by its place after {@link Slot.SPENT} — found once
 * rather than searched for at every count. `Map`s, so a name that is none —
 * `constructor`, which every object has — finds nothing.
 */
const TALLY_AT: ReadonlyMap<keyof GrabCounts, number> = new Map(
  TALLIED.map((field, at) => [field, at]),
);
const SPENT_AT: ReadonlyMap<MeasuredTime, number> = new Map(
  MEASURED_TIME.map((part, at) => [part, at]),
);

/**
 * What a slot counts: a label — its `requests` there, its `requestMs` in the
 * slot after and its `waitedMs` in the one after that — or, with `failure`,
 * how many of its requests failed so.
 */
export interface SlotName {
  label: string;
  /** Which failure — see `RequestCounts.failed`. */
  failure?: string;
}

/** Memory for one site's counts, to hand its thread and keep a {@link CountReader} on. */
export function sharedCounts(): SharedArrayBuffer {
  return new SharedArrayBuffer(SLOTS * BigInt64Array.BYTES_PER_ELEMENT);
}

/** The site's thread's side: each count added in place, each new slot named once. */
export class CountWriter {
  readonly #view: BigInt64Array;
  readonly #name: (index: number, slot: SlotName) => void;
  /**
   * Where each label's three counts are — nowhere, once there was no room — and
   * each of its kinds of failure: looked up by the label's own string, so a
   * slot already named costs a request nothing to find.
   */
  readonly #slots = new Map<
    string,
    { at: number | undefined; failed: Map<string, number | undefined> }
  >();
  /** The first slot nothing counts in yet: when it began, its channel-day counts and its time have theirs. */
  #free = Slot.SPENT + MEASURED_TIME.length;

  constructor(buffer: SharedArrayBuffer, name: (index: number, slot: SlotName) => void) {
    this.#view = new BigInt64Array(buffer);
    this.#name = name;
  }

  /** Say the site begun on, and when: from here, a thread that dies may have run some of it. */
  begin(at = Date.now()): void {
    Atomics.store(this.#view, Slot.BEGAN, BigInt(at));
  }

  /** Add `delta` to a channel-day count — less, as an empty day that then is not. */
  count(field: keyof GrabCounts, delta: number): void {
    const at = TALLY_AT.get(field);

    // Said, rather than added to whatever slot `NaN` comes to: when it began.
    if (at === undefined) {
      throw new TypeError(`No channel-day count is called ${String(field)}`);
    }

    Atomics.add(this.#view, Slot.TALLY + at, BigInt(delta));
  }

  /** Add `ms` to a part of the site's time — see `SiteClock`. */
  spend(part: MeasuredTime, ms: number): void {
    const at = SPENT_AT.get(part);

    // As for a count: said, rather than added to when it began.
    if (at === undefined) {
      throw new TypeError(`No part of a site's time is called ${String(part)}`);
    }

    Atomics.add(this.#view, Slot.SPENT + at, BigInt(Math.round(ms * 1000)));
  }

  /**
   * Add what `done` says of `label` — and answer what there was no slot for,
   * where anything, for the caller to say another way.
   */
  add(label: string, done: RequestCounts): RequestCounts | undefined {
    let left: RequestCounts | undefined;
    /** Slots this call took, named once what it adds is in them — see {@link #take}. */
    let taken: Array<[number, SlotName]> | undefined;
    let slots = this.#slots.get(label);

    if (slots === undefined) {
      slots = { at: this.#take(3), failed: new Map() };
      this.#slots.set(label, slots);

      if (slots.at !== undefined) {
        (taken ??= []).push([slots.at, { label }]);
      }
    }

    if (slots.at === undefined) {
      left = {
        requests: done.requests,
        requestMs: done.requestMs,
        waitedMs: done.waitedMs,
        failed: {},
      };
    } else {
      Atomics.add(this.#view, slots.at, BigInt(done.requests));
      Atomics.add(this.#view, slots.at + 1, BigInt(done.requestMs));
      Atomics.add(this.#view, slots.at + 2, BigInt(done.waitedMs));
    }

    for (const failure in done.failed) {
      // Its own, and not what anything put on every object.
      if (!Object.hasOwn(done.failed, failure)) {
        continue;
      }

      const n = done.failed[failure]!;
      let index = slots.failed.get(failure);

      if (index === undefined && !slots.failed.has(failure)) {
        index = this.#take(1);
        slots.failed.set(failure, index);

        if (index !== undefined) {
          (taken ??= []).push([index, { label, failure }]);
        }
      }

      if (index === undefined) {
        left ??= noRequests();
        left.failed[failure] = (left.failed[failure] ?? 0) + n;
      } else {
        Atomics.add(this.#view, index, BigInt(n));
      }
    }

    for (const [index, slot] of taken ?? []) {
      this.#name(index, slot);
    }

    return left;
  }

  /**
   * `size` slots, or none, where there is no room left — named by the caller,
   * and only once what it adds is in them: the run's thread may read a slot
   * the moment it hears its name, and for the last time, as the run hangs up.
   */
  #take(size: number): number | undefined {
    if (this.#free + size > SLOTS) {
      return undefined;
    }

    const index = this.#free;

    this.#free += size;

    return index;
  }
}

/** The run's thread's side: what each slot counts, as it is told, and what they hold. */
export class CountReader {
  /** The memory, to hand the site's thread. */
  readonly buffer: SharedArrayBuffer;
  readonly #view: BigInt64Array;
  readonly #names: SlotName[] = [];

  constructor(buffer = sharedCounts()) {
    this.buffer = buffer;
    this.#view = new BigInt64Array(buffer);
  }

  /** When the site's thread began on it, if it has. */
  began(): number | undefined {
    const at = Number(Atomics.load(this.#view, Slot.BEGAN));

    return at === 0 ? undefined : at;
  }

  /** What the slot at `index` counts, as the site's thread said when it began counting there. */
  named(index: number, slot: SlotName): void {
    this.#names[index] = slot;
  }

  /** The channel-day counts, as they stand. */
  tally(): GrabCounts {
    return Object.fromEntries(
      TALLIED.map((field, at) => [field, Number(Atomics.load(this.#view, Slot.TALLY + at))]),
    ) as Record<(typeof TALLIED)[number], number>;
  }

  /** Where the site's time went, as far as its thread said, in milliseconds. */
  spent(): Record<MeasuredTime, number> {
    return Object.fromEntries(
      MEASURED_TIME.map((part, at) => [
        part,
        Number(Atomics.load(this.#view, Slot.SPENT + at)) / 1000,
      ]),
    ) as Record<MeasuredTime, number>;
  }

  /**
   * What the site counted, by label, in the order each was first counted. A
   * slot whose name has not been heard is not read: there is no saying what
   * it counts.
   */
  read(): Map<string, RequestCounts> {
    const by = new Map<string, RequestCounts>();
    const at = (index: number): number => Number(Atomics.load(this.#view, index));

    // Each slot read once, so adding what it holds is setting it.
    this.#names.forEach((slot, index) => {
      addRequests(
        by,
        slot.label,
        slot.failure === undefined
          ? {
              requests: at(index),
              requestMs: at(index + 1),
              waitedMs: at(index + 2),
              failed: {},
            }
          : { requests: 0, requestMs: 0, waitedMs: 0, failed: { [slot.failure]: at(index) } },
      );
    });

    return by;
  }
}

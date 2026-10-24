import { describe, expect, it } from 'vitest';
import {
  CountReader,
  CountWriter,
  sharedCounts,
  SLOTS,
  type SlotName,
} from '../src/grabber/shared-counts.js';

/** A writer and a reader over one site's memory, the names said as a thread would say them. */
function shared(): { writer: CountWriter; reader: CountReader; named: SlotName[] } {
  const counts = sharedCounts();
  const reader = new CountReader(counts);
  const named: SlotName[] = [];
  const writer = new CountWriter(counts, (index, slot) => {
    named.push(slot);
    reader.named(index, slot);
  });

  return { writer, reader, named };
}

describe('shared counts', () => {
  it('reads back what was added, by label, in the order each was first counted', () => {
    const { writer, reader } = shared();

    writer.add('listings', { requests: 1, requestMs: 0, failed: {} });
    writer.add('detail', { requests: 1, requestMs: 0, failed: {} });
    writer.add('listings', { requests: 0, requestMs: 120, failed: {} });
    writer.add('detail', { requests: 0, requestMs: 30, failed: { 404: 1 } });
    writer.add('detail', { requests: 1, requestMs: 25, failed: { 404: 1, timeout: 1 } });

    expect([...reader.read()]).toEqual([
      ['listings', { requests: 1, requestMs: 120, failed: {} }],
      ['detail', { requests: 2, requestMs: 55, failed: { 404: 2, timeout: 1 } }],
    ]);
  });

  it('names each count once, however often it is added to', () => {
    const { writer, reader, named } = shared();

    for (let i = 0; i < 10_000; i++) {
      writer.add('detail', { requests: 1, requestMs: 2, failed: i % 2 === 0 ? { 404: 1 } : {} });
    }

    // The label, with its two counts — and its one kind of failure.
    expect(named).toEqual([{ label: 'detail' }, { label: 'detail', failure: '404' }]);
    expect(reader.read().get('detail')).toEqual({
      requests: 10_000,
      requestMs: 20_000,
      failed: { 404: 5_000 },
    });
  });

  it('names a label once for both its counts, before it has taken any time', () => {
    const { writer, reader, named } = shared();

    writer.add('detail', { requests: 1, requestMs: 0, failed: {} });
    writer.add('detail', { requests: 0, requestMs: 9, failed: {} });

    expect(named).toEqual([{ label: 'detail' }]);
    expect(reader.read().get('detail')).toEqual({ requests: 1, requestMs: 9, failed: {} });
  });

  it('hands back what it has no slot left for, and keeps counting what it has', () => {
    const { writer, reader } = shared();

    // Every slot taken, two to a label after the seven always there — when it
    // began, and the six of the channel-days — and the odd one by a failure.
    const labels = Math.floor((SLOTS - 7) / 2);

    for (let i = 0; i < labels; i++) {
      expect(writer.add(`label${i}`, { requests: 1, requestMs: 0, failed: {} })).toBeUndefined();
    }

    expect(writer.add('label1', { requests: 0, requestMs: 0, failed: { 500: 1 } })).toBeUndefined();

    // A label already slotted still counts; a failure it has no slot for, and
    // a label of none, are handed back.
    expect(writer.add('label0', { requests: 1, requestMs: 7, failed: { 503: 1 } })).toEqual({
      requests: 0,
      requestMs: 0,
      failed: { 503: 1 },
    });
    expect(writer.add('more', { requests: 1, requestMs: 3, failed: {} })).toEqual({
      requests: 1,
      requestMs: 3,
      failed: {},
    });
    expect(reader.read().get('label0')).toEqual({ requests: 2, requestMs: 7, failed: {} });
    expect(reader.read().size).toBe(labels);
  });

  it('counts channel-days in slots of their own, which need no name', () => {
    const { writer, reader, named } = shared();

    writer.count('fetched', 1);
    writer.count('empty', 1);
    writer.count('fetched', 1);
    // A day that came back empty and then did not.
    writer.count('empty', -1);
    writer.add('request', { requests: 1, requestMs: 0, failed: {} });

    expect(reader.tally()).toEqual({
      fetched: 2,
      empty: 0,
      fromCache: 0,
      unchanged: 0,
      failed: 0,
      sitesFailed: 0,
    });
    // And none of a label's slots taken by them.
    expect(named).toEqual([{ label: 'request' }]);
    expect(reader.read().get('request')).toEqual({ requests: 1, requestMs: 0, failed: {} });
  });

  it('says when the site began, in a slot of its own', () => {
    const { writer, reader, named } = shared();

    expect(reader.began()).toBeUndefined();

    writer.begin(1_700_000_000_000);

    expect(reader.began()).toBe(1_700_000_000_000);
    // Taking nothing of the counts' slots.
    expect(reader.tally()).toEqual({
      fetched: 0,
      empty: 0,
      fromCache: 0,
      unchanged: 0,
      failed: 0,
      sitesFailed: 0,
    });
    expect(named).toEqual([]);
  });

  it('refuses a channel-day count it does not know, rather than counting it into another', () => {
    const { writer, reader } = shared();

    writer.begin(1_700_000_000_000);

    expect(() => writer.count('hours' as never, 1)).toThrow('No channel-day count is called hours');
    // When it began, untouched.
    expect(reader.began()).toBe(1_700_000_000_000);
  });

  it('names a slot only once what was added is in it', () => {
    const counts = sharedCounts();
    const reader = new CountReader(counts);
    const seen: unknown[] = [];
    // Read the moment each name is heard, as the run's thread may — for the
    // last time, as it hangs up.
    const writer = new CountWriter(counts, (index, slot) => {
      reader.named(index, slot);
      seen.push(reader.read().get('detail'));
    });

    writer.add('detail', { requests: 1, requestMs: 7, failed: { 404: 1 } });

    expect(seen).toEqual([
      { requests: 1, requestMs: 7, failed: {} },
      { requests: 1, requestMs: 7, failed: { 404: 1 } },
    ]);
  });

  it('counts only the failures a request has, not what anything put on every object', () => {
    const { writer, reader } = shared();

    Object.defineProperty(Object.prototype, 'polluted', {
      value: 'not a count',
      enumerable: true,
      configurable: true,
    });

    try {
      writer.add('detail', { requests: 1, requestMs: 2, failed: { 404: 1 } });
    } finally {
      delete (Object.prototype as { polluted?: unknown }).polluted;
    }

    expect(reader.read().get('detail')).toEqual({
      requests: 1,
      requestMs: 2,
      failed: { 404: 1 },
    });
  });

  it('reads nothing of a slot whose name it has not heard', () => {
    const counts = sharedCounts();
    const writer = new CountWriter(counts, () => {});

    writer.add('detail', { requests: 1, requestMs: 5, failed: {} });

    expect(new CountReader(counts).read().size).toBe(0);
  });
});

import { expect, test } from 'vitest';
import { parseXmltvStream, writeXmltvStream } from '../src/xmltv/main.js';
import { TIMEOUT } from './harness.js';
import { guideToXml, INSTRUCTIONS, makeGuide } from './fixture.js';

/**
 * Guards rather than measurements: each one names a feature that is supposed to
 * cost nothing per element and asserts it, instead of leaving a gap in a table
 * for someone to notice.
 *
 * Their own file for the measurement, and the `DELTA` below for what that
 * measurement is worth. A comparison is one test now, so its arms are sampled
 * one after another over ten-odd seconds, and two arms doing *identical* work
 * come out anywhere from level to 12% apart as the machine drifts under them —
 * per-sample jitter is a tenth of that (rme ±2%), so more samples do not help.
 * Beside a full table it is worse again, hence the split: Vitest isolates per
 * file, and a worker that has not already run a benchmark is the cleanest
 * ground available.
 *
 * So these catch a feature that started charging per element, which at 1440
 * programmes is a doubling, not a few percent. They are not a regression
 * budget, and the table above each assertion is the better read.
 *
 * Nothing here is `tracked()`: each arm is read against the arm beside it, not
 * against last week's number.
 */

/** Run-to-run drift between two arms doing the same work, with room to spare. */
const DELTA = 0.2;

const guide = makeGuide(20, 3, 24); // 20 channels × 3 days × 24 = 1440 programmes
const xml = await guideToXml(guide);
// The same guide carrying a processing instruction at each top-level position.
const xmlWithInstructions = await guideToXml(guide, INSTRUCTIONS);

const PARSE = 'epg-tools parseXmltvStream';
const PARSE_INSTRUCTIONS = `${PARSE} (with processing instructions)`;

const WRITE = 'epg-tools writeXmltvStream';
const WRITE_INSTRUCTIONS = `${WRITE} (with processing instructions)`;
const EMPTY_PROFILE = `${WRITE} (empty profile)`;
const TVHEADEND = `${WRITE} (profile: tvheadend)`;

/**
 * Surfacing a processing instruction is per instruction and a guide has a
 * handful, so the cost is expected to disappear into a 2 MiB document. If the
 * two arms separate, the work moved into the per-element path.
 *
 * Streaming rather than whole-document because `parseXmltvString` retains 1440
 * programmes and its GC noise (±10%) would swamp the same thing.
 */
test(
  'a processing instruction costs nothing to parse per element',
  {
    timeout: TIMEOUT,
  },
  async ({ bench }) => {
    const result = await bench.compare(
      bench(PARSE, async () => {
        for await (const _event of parseXmltvStream([xml])) {
          // consume
        }
      }),
      bench(PARSE_INSTRUCTIONS, async () => {
        for await (const _event of parseXmltvStream([xmlWithInstructions])) {
          // consume
        }
      }),
    );

    expect(result.get(PARSE_INSTRUCTIONS)).not.toBeSlowerThan(result.get(PARSE), {
      delta: DELTA,
    });
  },
);

test(
  'instructions and profiles cost nothing to write per element',
  {
    timeout: TIMEOUT,
  },
  async ({ bench }) => {
    const result = await bench.compare(
      bench(WRITE, async () => {
        let out = '';

        for await (const chunk of writeXmltvStream({
          channels: guide.channels,
          programmes: guide.programmes,
        })) {
          out += chunk;
        }
      }),
      // The list is read once up front (a prolog one has to be in hand before the
      // header) and a guide with none allocates nothing for them at all, so a gap
      // here means the placing moved into the per-element path.
      bench(WRITE_INSTRUCTIONS, async () => {
        let out = '';

        for await (const chunk of writeXmltvStream({
          processingInstructions: INSTRUCTIONS,
          channels: guide.channels,
          programmes: guide.programmes,
        })) {
          out += chunk;
        }
      }),
      // An output profile is opt-in, and a guide written without one must not pay
      // for the feature existing. An empty profile is the worst case for that —
      // every guard runs and none of them has anything to say. A gap means the
      // per-element path grew work that belongs in `resolveProfile`.
      bench(EMPTY_PROFILE, async () => {
        let out = '';

        for await (const chunk of writeXmltvStream(
          { channels: guide.channels, programmes: guide.programmes },
          { profile: {} },
        )) {
          out += chunk;
        }
      }),
      // And the real thing: reorders episode-nums, derives a missing one,
      // normalises a dd_progid, rewrites every category through the genre table
      // and attaches its code, and drops two elements. Slower than the plain arm
      // is expected — what would not be is *scaling* differently, which is what a
      // per-element resolve would look like.
      bench(TVHEADEND, async () => {
        let out = '';

        for await (const chunk of writeXmltvStream(
          { channels: guide.channels, programmes: guide.programmes },
          { profile: 'tvheadend' },
        )) {
          out += chunk;
        }
      }),
    );

    expect(result.get(WRITE_INSTRUCTIONS)).not.toBeSlowerThan(result.get(WRITE), { delta: DELTA });
    expect(result.get(EMPTY_PROFILE)).not.toBeSlowerThan(result.get(WRITE), { delta: DELTA });

    // The profiled write is allowed to be slower, but only by a constant factor —
    // it measures ~50% over the plain arm. A per-element `resolveProfile` would
    // not fit under this ceiling at 1440 programmes.
    expect(result.get(TVHEADEND)).not.toBeSlowerThan(result.get(WRITE), { delta: 1 });
  },
);

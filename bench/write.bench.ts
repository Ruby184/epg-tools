import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseXmltv, writeXmltv } from '@iptv/xmltv';
import { bench, describe } from 'vitest';
import { writeXmltvStream, XmltvSerializeStream } from '../src/xmltv/main.js';
import type { XmltvParseEvent } from '../src/xmltv/main.js';
import { guideToXml, INSTRUCTIONS, makeGuide } from './fixture.js';

const guide = makeGuide(20, 3, 24); // 20 channels × 3 days × 24 = 1440 programmes
// The same guide in @iptv/xmltv's own object shape, via its own parser.
const iptvGuide = parseXmltv(await guideToXml(guide));

// The guide as a tagged event stream (channels then programmes) for the Transform.
const events: XmltvParseEvent[] = [
  ...guide.channels.map((value): XmltvParseEvent => ({ type: 'channel', value })),
  ...guide.programmes.map((value): XmltvParseEvent => ({ type: 'programme', value })),
];

describe(`write XMLTV (${guide.programmes.length} programmes)`, () => {
  bench('epg-tools writeXmltvStream', async () => {
    let out = '';

    for await (const chunk of writeXmltvStream({
      channels: guide.channels,
      programmes: guide.programmes,
    })) {
      out += chunk;
    }
  });

  // A guard rather than a measurement, like its counterpart in parse.bench.ts:
  // this should read the same as the line above. The list is read once up front
  // (a prolog one has to be in hand before the header) and a guide with none
  // allocates nothing for them at all, so a gap here means the placing moved
  // into the per-element path.
  bench('epg-tools writeXmltvStream (with processing instructions)', async () => {
    let out = '';

    for await (const chunk of writeXmltvStream({
      processingInstructions: INSTRUCTIONS,
      channels: guide.channels,
      programmes: guide.programmes,
    })) {
      out += chunk;
    }
  });

  bench('epg-tools XmltvSerializeStream (Node Transform)', async () => {
    await pipeline(
      Readable.from(events),
      new XmltvSerializeStream(),
      async (chunks: AsyncIterable<string>) => {
        for await (const _chunk of chunks) {
          // consume
        }
      },
    );
  });

  bench('@iptv/xmltv writeXmltv', () => {
    writeXmltv(iptvGuide);
  });
});

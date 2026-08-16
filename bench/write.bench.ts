import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseXmltv, writeXmltv } from '@iptv/xmltv';
import { bench, describe } from 'vitest';
import { writeXmltvStream, XmltvSerializeStream } from '../src/xmltv/main.js';
import type { XmltvParseEvent } from '../src/xmltv/main.js';
import { guideToXml, makeGuide } from './fixture.js';

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

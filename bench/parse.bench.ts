import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseXmltv } from '@iptv/xmltv';
import epgParser from 'epg-parser';
import { XMLParser } from 'fast-xml-parser';
import { bench, describe } from 'vitest';
import { parseXmltvStream, parseXmltvString, XmltvParseStream } from '../src/xmltv/main.js';
import { guideToXml, makeGuide, rechunk } from './fixture.js';

const guide = makeGuide(20, 3, 24); // 20 channels × 3 days × 24 = 1440 programmes
const xml = await guideToXml(guide);
const sizeKiB = Math.round(Buffer.byteLength(xml) / 1024);

describe(`parse XMLTV (${sizeKiB} KiB, ${guide.programmes.length} programmes)`, () => {
  bench('epg-tools parseXmltvStream (whole string)', async () => {
    // eslint-disable-next-line no-empty
    for await (const _event of parseXmltvStream([xml])) {
      // consume
    }
  });

  bench('epg-tools parseXmltvStream (64 KiB chunks)', async () => {
    for await (const _event of parseXmltvStream(rechunk(xml, 65_536))) {
      // consume
    }
  });

  bench('epg-tools parseXmltvString (sync, whole document)', () => {
    parseXmltvString(xml);
  });

  bench('epg-tools XmltvParseStream (Node Transform, 64 KiB chunks)', async () => {
    await pipeline(
      Readable.from(rechunk(xml, 65_536)),
      new XmltvParseStream(),
      async (events: AsyncIterable<unknown>) => {
        for await (const _event of events) {
          // consume
        }
      },
    );
  });

  bench('@iptv/xmltv parseXmltv', () => {
    parseXmltv(xml);
  });

  bench('epg-parser parse', () => {
    epgParser.parse(xml);
  });

  // Not an XMLTV-specific parser — the generic XML parser people commonly
  // reach for ad hoc. Measures raw parse() cost only (into its own generic
  // object shape, not our typed model), same as @iptv/xmltv's own benchmarks.
  bench('fast-xml-parser (generic XML) parse', () => {
    new XMLParser({ ignoreAttributes: false }).parse(xml);
  });
});

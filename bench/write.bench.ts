import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseXmltv, writeXmltv } from '@iptv/xmltv';
import { test } from 'vitest';
import { writeXmltvStream, XmltvSerializeStream } from '../src/xmltv/main.js';
import type { XmltvChannel, XmltvParseEvent, XmltvProgramme } from '../src/xmltv/main.js';
import { speedup, TIMEOUT, tracked } from './harness.js';
import { guideToXml, makeGuide } from './fixture.js';

const guide = makeGuide(20, 3, 24); // 20 channels × 3 days × 24 = 1440 programmes
// The same guide in @iptv/xmltv's own object shape, via its own parser.
const iptvGuide = parseXmltv(await guideToXml(guide));

// The guide as a tagged event stream (channels then programmes) for the Transform.
const events: XmltvParseEvent[] = [
  ...guide.channels.map((value): XmltvParseEvent => ({ type: 'channel', value })),
  ...guide.programmes.map((value): XmltvParseEvent => ({ type: 'programme', value })),
];

/**
 * The same guide with its pictures and links written relative, which is what a
 * `baseUrl` is for — and the only shape where it has anything to rewrite.
 */
const relative = {
  channels: guide.channels.map((channel, index) => ({
    ...channel,
    icon: [{ src: `/logo-${index}.png`, width: 120, height: 60 }],
    url: [`/channel/${index}`],
  })),
  programmes: guide.programmes.map((programme) => ({
    ...programme,
    icon: [{ src: `/still/${programme.channel}.png` }],
  })),
};

test(
  `write XMLTV with a baseUrl (${guide.programmes.length} programmes)`,
  { timeout: TIMEOUT },
  async ({ annotate, bench }) => {
    const write = async (
      input: { channels: XmltvChannel[]; programmes: XmltvProgramme[] },
      options?: { baseUrl: string },
    ): Promise<void> => {
      for await (const _chunk of writeXmltvStream(input, options)) {
        // consume
      }
    };

    const results = await bench.compare(
      bench('relative urls, no baseUrl', async () => {
        await write(relative);
      }),
      bench('relative urls, resolved against a baseUrl', async () => {
        await write(relative, { baseUrl: 'https://pi.local/' });
      }),
      // Every url already absolute, which is the case a base still has to look
      // at and can do nothing with — the cost of asking, with none of the work.
      bench('absolute urls, with a baseUrl set', async () => {
        await write(guide, { baseUrl: 'https://pi.local/' });
      }),
    );

    await speedup(annotate, results, 'relative urls, no baseUrl', [
      'relative urls, resolved against a baseUrl',
      'absolute urls, with a baseUrl set',
    ]);
  },
);

test(
  `write XMLTV (${guide.programmes.length} programmes)`,
  { timeout: TIMEOUT },
  async ({ annotate, bench }) => {
    const results = await bench.compare(
      ...tracked(bench, 'epg-tools writeXmltvStream', async () => {
        let out = '';

        for await (const chunk of writeXmltvStream({
          channels: guide.channels,
          programmes: guide.programmes,
        })) {
          out += chunk;
        }
      }),
      ...tracked(bench, 'epg-tools XmltvSerializeStream (Node Transform)', async () => {
        await pipeline(
          Readable.from(events),
          new XmltvSerializeStream(),
          async (chunks: AsyncIterable<string>) => {
            for await (const _chunk of chunks) {
              // consume
            }
          },
        );
      }),
      bench('@iptv/xmltv writeXmltv', () => {
        writeXmltv(iptvGuide);
      }),
    );

    await speedup(annotate, results, 'epg-tools writeXmltvStream', ['@iptv/xmltv writeXmltv']);
  },
);

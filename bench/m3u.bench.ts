import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseM3U } from '@iptv/playlist';
import iptvPlaylistParser from 'iptv-playlist-parser';
import { M3uGenerator, M3uParser } from 'm3u-parser-generator';
import { bench, describe } from 'vitest';
import { M3uParseStream, parseM3uStream, parseM3uString } from '../src/m3u/main.js';
import { serializeM3uEntry, writeM3uStream } from '../src/m3u/main.js';
import type { M3uEntry } from '../src/m3u/main.js';
import { rechunk } from './fixture.js';

/**
 * A playlist shaped like the one this is really about: iptv-org's `index.m3u`,
 * measured at 12,946 entries and 2.7 MB. Everything here is proportioned to
 * what that file actually contains — three attributes on every entry, an
 * `#EXTVLCOPT` on 6% of them, and **a comma inside a quoted value on 4.9%**,
 * which is the case that separates a correct parser from a fast one.
 */
function makePlaylist(count: number): { text: string; entries: M3uEntry[] } {
  const entries: M3uEntry[] = [];

  for (let i = 0; i < count; i++) {
    const attributes = new Map<string, string>([
      ['tvg-id', `Channel${i}.us@SD`],
      ['tvg-logo', `https://images.example.com/channels/${i}/colorLogoPNG.png`],
    ]);

    // 1 in 20, as in the real playlist: a user agent whose value contains a
    // comma, so the first comma on the line is not where the name begins.
    if (i % 20 === 0) {
      attributes.set(
        'http-user-agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
      );
    }

    attributes.set('group-title', ['News', 'Movies', 'Sports', 'General'][i % 4] ?? 'General');

    const entry: M3uEntry = {
      url: `https://cdn.example.com/live/channel${i}/index.m3u8`,
      name: `Channel ${i} (1080p)`,
      duration: -1,
      attributes,
      ...(i % 16 === 0
        ? { directives: [{ name: 'EXTVLCOPT', value: 'http-referrer=https://example.com/' }] }
        : {}),
    };

    entries.push(entry);
  }

  const text =
    '#EXTM3U x-tvg-url="https://example.com/guide.xml.gz"\r\n' +
    entries.map((entry) => serializeM3uEntry(entry, { eol: '\r\n' })).join('');

  return { text, entries };
}

const { text: playlist, entries } = makePlaylist(12_946);
const sizeKiB = Math.round(Buffer.byteLength(playlist) / 1024);

describe(`parse M3U (${sizeKiB} KiB, ${entries.length} entries)`, () => {
  bench('epg-tools parseM3uStream (whole string)', async () => {
    for await (const _event of parseM3uStream([playlist])) {
      // consume
    }
  });

  bench('epg-tools parseM3uStream (64 KiB chunks)', async () => {
    for await (const _event of parseM3uStream(rechunk(playlist, 65_536))) {
      // consume
    }
  });

  bench('epg-tools parseM3uString (sync, whole document)', () => {
    parseM3uString(playlist);
  });

  bench('epg-tools M3uParseStream (Node Transform, 64 KiB chunks)', async () => {
    await pipeline(
      Readable.from(rechunk(playlist, 65_536)),
      new M3uParseStream(),
      async (events: AsyncIterable<unknown>) => {
        for await (const _event of events) {
          // consume
        }
      },
    );
  });

  // Both comparators take the whole playlist as a string and return the whole
  // model, which is what the two `epg-tools` whole-string arms above are for —
  // the chunked arms are doing strictly more work (an extra copy per chunk) and
  // are not the fair comparison.
  //
  // A speed number here is only half the comparison, and the smaller half. Run
  // against the real `index.m3u`, `@iptv/playlist` 1.2.1 returns 12,911 of the
  // 12,946 entries, and of those it returns, 781 have `name: undefined` and the
  // rest of the `#EXTINF` line sitting in `url` where the stream address should
  // be — it splits the name off at the first comma, which the 4.9% case is
  // built to defeat. `iptv-playlist-parser` gets all 12,946 right.
  bench('@iptv/playlist parseM3U', () => {
    parseM3U(playlist);
  });

  bench('iptv-playlist-parser parse', () => {
    iptvPlaylistParser.parse(playlist);
  });

  // Correct on the comma case only when the *name* holds it: on iptv-org's real
  // playlist it mangles the name of all 628 entries that carry a comma inside a
  // quoted attribute value, in the same way `@iptv/playlist` does.
  bench('m3u-parser-generator parse', () => {
    new M3uParser({ ignoreErrors: true }).parse(playlist);
  });
});

// The one external comparator for the write side. Its model is built once here
// rather than per iteration, so what is timed is generating from a model in
// hand — the same thing the two arms above are doing.
const theirs = new M3uParser({ ignoreErrors: true }).parse(playlist);

describe(`write M3U (${entries.length} entries)`, () => {
  bench('epg-tools writeM3uStream', async () => {
    for await (const _chunk of writeM3uStream({ entries }, { eol: '\r\n' })) {
      // consume
    }
  });

  bench('epg-tools serializeM3uEntry (per entry)', () => {
    for (const entry of entries) {
      serializeM3uEntry(entry, { eol: '\r\n' });
    }
  });

  // Close, and doing less on the way: it writes ~6.6% fewer bytes on the real
  // playlist because it drops every directive it was not configured to keep,
  // and it validates nothing. So read the margin here as "about the same work
  // rate", not as a win — what this side spends the difference on is a
  // byte-identical round trip and a `TypeError` instead of a playlist that does
  // not read back.
  bench('m3u-parser-generator M3uGenerator', () => {
    M3uGenerator.generate(theirs);
  });
});

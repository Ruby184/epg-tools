import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import {
  M3uParseStream,
  M3uScanner,
  M3uTag,
  M3uSerializeStream,
  parseM3uFile,
  parseM3uStream,
  parseM3uString,
  serializeM3uEntry,
  serializeM3uHeader,
  writeM3uStream,
  writeM3uToFile,
} from '../src/m3u/main.js';
import type { M3uEntry, M3uParseEvent, M3uTokens, M3uUri, M3uWarning } from '../src/m3u/main.js';

const FIXTURE = new URL('./fixtures/iptv-org-slice.m3u', import.meta.url);
/** `parseM3uFile` takes a path, and `URL.pathname` is not one — it keeps the
 *  percent-encoding and, on Windows, a leading slash. */
const FIXTURE_PATH = fileURLToPath(FIXTURE);

function* rechunk(document: string, size: number): Generator<string> {
  for (let i = 0; i < document.length; i += size) {
    yield document.slice(i, i + size);
  }
}

/**
 * The default for parse-behavior tests, for the reason `parseAll` is in
 * `test/xmltv.test.ts`: a 7-character split falls inside `#EXTINF:`, inside a
 * quoted value and between a CR and its LF, which is where a line scanner's
 * carry-over bugs live. `parseM3uString` is used directly only where the claim
 * is about the synchronous surface itself.
 */
async function parseAll(document: string, chunkSize = 7): Promise<M3uParseEvent[]> {
  const events: M3uParseEvent[] = [];

  for await (const event of parseM3uStream(rechunk(document, chunkSize))) {
    events.push(event);
  }

  return events;
}

/** The attributes of an entry, written the way a test wants to read them. */
const attrs = (record: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(record));

const entriesOf = (events: M3uParseEvent[]): M3uEntry[] =>
  events.filter((e) => e.type === 'entry').map((e) => e.value);

const warningsOf = (events: M3uParseEvent[]): M3uWarning[] =>
  events.filter((e) => e.type === 'warning').map((e) => e.value);

async function collect(source: AsyncIterable<string>): Promise<string> {
  let out = '';

  for await (const chunk of source) {
    out += chunk;
  }

  return out;
}

describe('parseM3uString', () => {
  it('reads a header, an entry and its attributes', () => {
    const playlist = parseM3uString(
      '#EXTM3U x-tvg-url="http://example/guide.xml"\n' +
        '#EXTINF:-1 tvg-id="one.us" group-title="News",One HD\n' +
        'http://example/one.m3u8\n',
    );

    expect(playlist.warnings).toEqual([]);
    expect(playlist.header.attributes).toEqual(attrs({ 'x-tvg-url': 'http://example/guide.xml' }));
    expect(playlist.entries).toEqual([
      {
        url: 'http://example/one.m3u8',
        name: 'One HD',
        duration: -1,
        attributes: attrs({ 'tvg-id': 'one.us', 'group-title': 'News' }),
      },
    ]);
  });

  it('keeps a real duration, and attribute order as written', () => {
    const [entry] = parseM3uString(
      '#EXTM3U\n#EXTINF:212.5 b="2" a="1" c="3",Song\nhttp://example/s.mp3\n',
    ).entries;

    expect(entry?.duration).toBe(212.5);
    expect([...(entry?.attributes.keys() ?? [])]).toEqual(['b', 'a', 'c']);
  });

  it('keeps directives whole, splitting on the first colon only', () => {
    const [entry] = parseM3uString(
      '#EXTM3U\n' +
        '#EXTINF:-1,Two\n' +
        '#EXTVLCOPT:http-user-agent=Mozilla/5.0 (X11; Linux) Chrome/1:2\n' +
        '#EXTGRP:News\n' +
        'http://example/two.m3u8\n',
    ).entries;

    expect(entry?.directives).toEqual([
      { name: 'EXTVLCOPT', value: 'http-user-agent=Mozilla/5.0 (X11; Linux) Chrome/1:2' },
      { name: 'EXTGRP', value: 'News' },
    ]);
  });

  it('drops unknown directives when asked, and says nothing about them', () => {
    const playlist = parseM3uString(
      '#EXTM3U\n#EXTINF:-1,Two\n#EXTVLCOPT:x=1\nhttp://example/two.m3u8\n',
      { keepUnknownDirectives: false },
    );

    expect(playlist.entries[0]?.directives).toBeUndefined();
    expect(playlist.warnings).toEqual([]);
  });
});

describe('where the display name begins', () => {
  // The one genuinely hard piece of this format, and the case 4.9% of
  // iptv-org's playlist exercises. Neither the first comma nor the last one is
  // the answer; the first comma *outside quotes* is.
  it('ignores a comma inside a quoted attribute value', () => {
    const [entry] = parseM3uString(
      '#EXTM3U\n' +
        '#EXTINF:-1 http-user-agent="AppleWebKit/537.36 (KHTML, like Gecko)" group-title="News",One HD\n' +
        'http://example/one.m3u8\n',
    ).entries;

    expect(entry?.name).toBe('One HD');
    expect(entry?.attributes).toEqual(
      attrs({
        'http-user-agent': 'AppleWebKit/537.36 (KHTML, like Gecko)',
        'group-title': 'News',
      }),
    );
  });

  it('keeps a comma in the name itself', () => {
    const [entry] = parseM3uString(
      '#EXTM3U\n#EXTINF:-1 tvg-id="a.us",One HD, the good one\nhttp://example/one.m3u8\n',
    ).entries;

    expect(entry?.name).toBe('One HD, the good one');
  });

  // Where Kodi's pvr.iptvsimple gets it wrong, and it is the reference
  // implementation for this layer: it defaults to the *last* comma on the line
  // and only refines that when a comma sits just after the line's last quote.
  // With no quoted attribute there is no last quote, so the default stands.
  it('keeps a comma in the name of an entry with no attributes at all', () => {
    const [entry] = parseM3uString(
      '#EXTM3U\n#EXTINF:-1,One HD, the good one\nhttp://e/1\n',
    ).entries;

    expect(entry?.name).toBe('One HD, the good one');
  });

  // The other divergence: a quote inside the display name moves the "last
  // quote" into the name, and a rule anchored to it lands past the comma.
  // Counting quotes from the left cannot be fooled this way.
  it('keeps a name containing a double quote and a comma', () => {
    const [entry] = parseM3uString(
      '#EXTM3U\n#EXTINF:-1 tvg-id="a.us",The "Best", Channel\nhttp://e/1\n',
    ).entries;

    expect(entry?.name).toBe('The "Best", Channel');
    expect(entry?.attributes).toEqual(attrs({ 'tvg-id': 'a.us' }));
  });

  // Both at once, which is what tells the two rules apart. Synthetic: no entry
  // in iptv-org's 12,946 has a comma in its *name*, so the fixture cannot cover
  // this and a test has to.
  it('handles a comma in an attribute and in the name together', () => {
    const [entry] = parseM3uString(
      '#EXTM3U\n' +
        '#EXTINF:-1 http-user-agent="AppleWebKit (KHTML, like Gecko)" group-title="News;Docs",One HD, the good one\n' +
        'http://example/one.m3u8\n',
    ).entries;

    expect(entry?.name).toBe('One HD, the good one');
    expect(entry?.attributes.get('http-user-agent')).toBe('AppleWebKit (KHTML, like Gecko)');
    expect(entry?.attributes.get('group-title')).toBe('News;Docs');
  });
});

describe('what a playlist can be written as', () => {
  it('reads CRLF, a BOM, blank lines and a last line with no newline', async () => {
    const events = await parseAll(
      '﻿#EXTM3U\r\n' +
        '\r\n' +
        '#EXTINF:-1 tvg-id="a.us",One\r\n' +
        '   \r\n' +
        'http://example/one.m3u8',
    );

    expect(warningsOf(events)).toEqual([]);
    expect(entriesOf(events)).toEqual([
      {
        url: 'http://example/one.m3u8',
        name: 'One',
        duration: -1,
        attributes: attrs({ 'tvg-id': 'a.us' }),
      },
    ]);
  });

  it('reads an unquoted value and whitespace around the =', () => {
    const [entry] = parseM3uString('#EXTM3U\n#EXTINF:-1 tvg-chno = 42,One\nhttp://e/1\n').entries;

    expect(entry?.attributes).toEqual(attrs({ 'tvg-chno': '42' }));
  });

  it('gives the same events however the bytes are split', async () => {
    const document = await readFile(FIXTURE, 'utf8');
    const whole = parseM3uString(document);

    for (const size of [1, 7, 16, 4096]) {
      const events = await parseAll(document, size);

      expect(entriesOf(events), `chunk size ${size}`).toEqual(whole.entries);
      expect(warningsOf(events), `chunk size ${size}`).toEqual(whole.warnings);
    }
  });

  it('decodes a multi-byte character split across byte chunks', async () => {
    const document = '#EXTM3U\n#EXTINF:-1,Jednotka — Dvojka ľščť\nhttp://e/1\n';
    const bytes = Buffer.from(document, 'utf8');
    const events: M3uParseEvent[] = [];

    for await (const event of parseM3uStream(
      (function* () {
        for (let i = 0; i < bytes.length; i++) {
          yield bytes.subarray(i, i + 1);
        }
      })(),
    )) {
      events.push(event);
    }

    expect(entriesOf(events)[0]?.name).toBe('Jednotka — Dvojka ľščť');
  });
});

describe('one url per entry, and one only', () => {
  // RFC 8216 gives an `#EXTINF` exactly one URI, and no implementation of the
  // IPTV layer reads a second line as a backup stream — Kodi, tvheadend and
  // `iptv-playlist-parser` all take the first and move on. (`@iptv/playlist`
  // collects them into an undocumented `urls`, which is the outlier.) The
  // backup-stream proposals that do exist put them in the url line itself or
  // behind a tag of their own, so a bare second url is exactly what the
  // `orphan-url` warning calls it.
  it('reports a second url line rather than attaching it', async () => {
    const events = await parseAll(
      '#EXTM3U\n#EXTINF:-1 tvg-id="a.us",One\nhttp://primary/1.m3u8\nhttp://backup/1.m3u8\n',
    );

    expect(warningsOf(events)).toEqual([
      {
        code: 'orphan-url',
        message: '"http://backup/1.m3u8" has no #EXTINF before it, and is dropped',
        line: 4,
        col: 1,
      },
    ]);
    expect(entriesOf(events)).toEqual([
      {
        url: 'http://primary/1.m3u8',
        name: 'One',
        duration: -1,
        attributes: attrs({ 'tvg-id': 'a.us' }),
      },
    ]);
  });

  // The convention that *is* real, and it needs no support: whatever the line
  // holds is the url, so tvheadend's `url|Header=value` round-trips untouched.
  it('keeps http headers appended to the url verbatim', () => {
    const [entry] = parseM3uString(
      '#EXTM3U\n#EXTINF:-1,One\nhttp://e/1|User-Agent=Mozilla&Referer=http://e/\n',
    ).entries;

    expect(entry?.url).toBe('http://e/1|User-Agent=Mozilla&Referer=http://e/');
  });
});

describe('directives on either side of the #EXTINF', () => {
  // Kodi and tvheadend both accumulate into a pending channel and commit it on
  // the url line, so which side of the `#EXTINF` a directive sits is not
  // something either can notice. Kodi has an issue titled "#EXTGRP before
  // #EXTINF breaks the parsing of playlist", which says how common it is —
  // and iptv-org uses `#EXTGRP` zero times, so the fixture cannot cover it.
  it('gives a leading directive to the entry that follows', async () => {
    const events = await parseAll('#EXTM3U\n#EXTGRP:News\n#EXTINF:-1 tvg-id="a",A\nhttp://e/a\n');

    expect(warningsOf(events)).toEqual([]);
    expect(entriesOf(events)[0]?.directives).toEqual([{ name: 'EXTGRP', value: 'News' }]);
  });

  it('keeps both sides, in the order the playlist wrote them', async () => {
    const events = await parseAll(
      '#EXTM3U\n' +
        '#EXTGRP:News\n' +
        '#EXTINF:-1 tvg-id="a",A\n' +
        '#EXTVLCOPT:http-referrer=http://e/\n' +
        'http://e/a\n',
    );

    expect(entriesOf(events)[0]?.directives).toEqual([
      { name: 'EXTGRP', value: 'News' },
      { name: 'EXTVLCOPT', value: 'http-referrer=http://e/' },
    ]);
  });

  it('starts a fresh set for each entry rather than carrying them over', async () => {
    const events = await parseAll(
      '#EXTM3U\n' +
        '#EXTGRP:News\n#EXTINF:-1 tvg-id="a",A\nhttp://e/a\n' +
        '#EXTINF:-1 tvg-id="b",B\nhttp://e/b\n' +
        '#EXTGRP:Sports\n#EXTINF:-1 tvg-id="c",C\nhttp://e/c\n',
    );

    expect(warningsOf(events)).toEqual([]);
    expect(entriesOf(events).map((e) => e.directives ?? null)).toEqual([
      [{ name: 'EXTGRP', value: 'News' }],
      // Not carried forward: what `#EXTGRP` *means* across entries is for
      // `channelsFromM3u` to say, not for the parser to duplicate into a model
      // that would then write it back out three times.
      null,
      [{ name: 'EXTGRP', value: 'Sports' }],
    ]);
  });

  it('gives a directive after a url to the next entry, as Kodi does', async () => {
    const events = await parseAll(
      '#EXTM3U\n#EXTINF:-1,A\nhttp://e/a\n#EXTVLCOPT:x=1\n#EXTINF:-1,B\nhttp://e/b\n',
    );

    expect(warningsOf(events)).toEqual([]);
    expect(entriesOf(events).map((e) => e.directives ?? null)).toEqual([
      null,
      [{ name: 'EXTVLCOPT', value: 'x=1' }],
    ]);
  });

  it('drops leading directives too when asked not to keep unknown ones', () => {
    const playlist = parseM3uString('#EXTM3U\n#EXTGRP:News\n#EXTINF:-1,A\nhttp://e/a\n', {
      keepUnknownDirectives: false,
    });

    expect(playlist.entries[0]?.directives).toBeUndefined();
    expect(playlist.warnings).toEqual([]);
  });
});

describe('bytes that are not UTF-8', () => {
  // The format carries no encoding declaration, so a provider writing
  // windows-1251 produces a file that is not valid UTF-8 and whose every
  // channel name comes back as replacement characters.
  const cyrillic = '#EXTM3U\n#EXTINF:-1 tvg-id="a",Первый канал\nhttp://e/1\n';
  const windows1251 = Buffer.from(
    [...cyrillic].map((ch) => {
      const code = ch.codePointAt(0)!;
      // U+0410–U+044F map to 0xC0–0xFF in windows-1251.
      return code >= 0x410 && code <= 0x44f ? code - 0x410 + 0xc0 : code;
    }),
  );

  it('reads them as the charset it is told', async () => {
    const events: M3uParseEvent[] = [];

    for await (const event of parseM3uStream([windows1251], { charset: 'windows-1251' })) {
      events.push(event);
    }

    expect(entriesOf(events)[0]?.name).toBe('Первый канал');
  });

  it('mangles them without being told, which is why the option exists', async () => {
    const events: M3uParseEvent[] = [];

    for await (const event of parseM3uStream([windows1251])) {
      events.push(event);
    }

    expect(entriesOf(events)[0]?.name).toBe('������ �����');
  });

  it('refuses a charset it does not know, rather than falling back', () => {
    expect(() => new M3uParseStream({ charset: 'not-an-encoding' })).toThrow(RangeError);
  });
});

describe('a line that never ends', () => {
  // The scanner holds a line until its newline arrives, so without a bound an
  // endpoint answering with megabytes and no newline grows the buffer without
  // limit — and a playlist is usually fetched from a url someone else controls.
  const runaway = (size: number, chunk: number): Generator<string> =>
    rechunk(`#EXTM3U\n${'x'.repeat(size)}\n#EXTINF:-1 tvg-id="a",After\nhttp://e/1\n`, chunk);

  it('drops the line and picks the playlist up again after it', async () => {
    const events: M3uParseEvent[] = [];

    for await (const event of parseM3uStream(runaway(5000, 512), { maxLineLength: 1000 })) {
      events.push(event);
    }

    expect(warningsOf(events)).toEqual([
      {
        code: 'line-too-long',
        message: 'line is longer than 1000 characters and was dropped',
        line: 2,
        col: 1,
      },
    ]);
    // The entry after it is read normally, and its line number is still right.
    expect(entriesOf(events)).toEqual([
      { url: 'http://e/1', name: 'After', duration: -1, attributes: attrs({ 'tvg-id': 'a' }) },
    ]);
  });

  it('says the same thing however the bytes are chunked', async () => {
    for (const chunk of [1, 7, 4096, 100_000]) {
      const events: M3uParseEvent[] = [];

      for await (const event of parseM3uStream(runaway(5000, chunk), { maxLineLength: 1000 })) {
        events.push(event);
      }

      expect(
        warningsOf(events).map((w) => w.code),
        `chunk ${chunk}`,
      ).toEqual(['line-too-long']);
      expect(
        entriesOf(events).map((e) => e.name),
        `chunk ${chunk}`,
      ).toEqual(['After']);
    }
  });

  // The two entry points are the same scanner; the one thing they must never do
  // is disagree about what a playlist says.
  it('applies to the last line, so the sync form agrees with the stream', () => {
    const playlist = parseM3uString(`#EXTM3U\n${'x'.repeat(5000)}`, { maxLineLength: 1000 });

    expect(playlist.warnings.map((w) => w.code)).toEqual(['line-too-long']);
    expect(playlist.entries).toEqual([]);
  });

  it('leaves every real playlist alone by default', async () => {
    const document = await readFile(FIXTURE, 'utf8');

    expect(parseM3uString(document).warnings).toEqual([]);
  });
});

describe('the scanner on its own, for a dialect that is not IPTV', () => {
  const HLS = [
    '#EXTM3U',
    '#EXT-X-TARGETDURATION:10',
    '#EXT-X-KEY:METHOD=AES-128,URI="https://e/k1.bin"',
    '#EXTINF:9.009,',
    'http://e/first.ts',
    '#EXT-X-KEY:METHOD=AES-128,URI="https://e/k2.bin"',
    '#EXTINF:8.5,Third',
    'http://e/second.ts',
    '#EXT-X-ENDLIST',
    '',
  ].join('\r\n');

  /** Every line, in order, as the scanner classified it. */
  class Lines implements M3uTokens<never> {
    readonly events: never[] = [];
    readonly seen: string[] = [];
    ended = false;

    tag({ name, value, line }: M3uTag): void {
      this.seen.push(`${line} tag ${name}${value === '' ? '' : `:${value}`}`);
    }
    uri({ text, line }: M3uUri): void {
      this.seen.push(`${line} uri ${text}`);
    }
    warn(): void {}
    end(): void {
      this.ended = true;
    }
  }

  it('classifies lines and knows nothing else about them', () => {
    const lines = new Lines();

    for (const _event of new M3uScanner(lines, {}).consume(HLS, true)) {
      // this handler emits nothing
    }

    expect(lines.seen).toEqual([
      '1 tag EXTM3U',
      '2 tag EXT-X-TARGETDURATION:10',
      '3 tag EXT-X-KEY:METHOD=AES-128,URI="https://e/k1.bin"',
      '4 tag EXTINF:9.009,',
      '5 uri http://e/first.ts',
      '6 tag EXT-X-KEY:METHOD=AES-128,URI="https://e/k2.bin"',
      '7 tag EXTINF:8.5,Third',
      '8 uri http://e/second.ts',
      '9 tag EXT-X-ENDLIST',
    ]);
    expect(lines.ended).toBe(true);
  });

  // The point of the seam: a handler that scopes tags the way RFC 8216 does,
  // getting CRLF, blank lines and the line bound from the scanner for nothing.
  it('lets a handler carry an EXT-X-KEY forward, as the RFC says to', () => {
    class Hls implements M3uTokens<never> {
      readonly events: never[] = [];
      readonly segments: { uri: string; duration: number; key: string | undefined }[] = [];
      targetDuration?: number;
      #key: string | undefined;
      #duration = 0;

      tag(tag: M3uTag): void {
        if (tag.name === 'EXTINF') this.#duration = Number(tag.value.split(',')[0]);
        else if (tag.name === 'EXT-X-TARGETDURATION') this.targetDuration = Number(tag.value);
        // Applies to every segment after it, until the next one. The grammar is
        // the tag's own business, which is why the reader names it here.
        else if (tag.name === 'EXT-X-KEY')
          this.#key = tag.attributes({ separator: ',' }).get('URI');
      }
      uri({ text }: M3uUri): void {
        this.segments.push({ uri: text, duration: this.#duration, key: this.#key });
      }
      warn(): void {}
      end(): void {}
    }

    const hls = new Hls();

    for (const _event of new M3uScanner(hls, {}).consume(HLS, true)) {
      // this handler emits nothing
    }

    expect(hls.targetDuration).toBe(10);
    expect(hls.segments).toEqual([
      { uri: 'http://e/first.ts', duration: 9.009, key: 'https://e/k1.bin' },
      { uri: 'http://e/second.ts', duration: 8.5, key: 'https://e/k2.bin' },
    ]);
  });

  // RFC 8216 §4.3.1.1 requires `#EXTM3U` of every playlist type, so the scanner
  // reports its absence and every dialect gets that without asking.
  it('tells any handler when the playlist does not open with #EXTM3U', () => {
    class Warnings implements M3uTokens<never> {
      readonly events: never[] = [];
      readonly warnings: M3uWarning[] = [];
      tag(): void {}
      uri(): void {}
      warn(warning: M3uWarning): void {
        this.warnings.push(warning);
      }
      end(): void {}
    }

    const missing = new Warnings();

    for (const _event of new M3uScanner(missing, {}).consume('\n# a comment\nhttp://e/1\n', true)) {
      // this handler emits nothing
    }

    expect(missing.warnings).toEqual([
      {
        code: 'missing-header',
        message: 'the playlist begins with "# a comment", not #EXTM3U',
        // The comment, not the blank line above it.
        line: 2,
        col: 1,
      },
    ]);

    const present = new Warnings();

    for (const _event of new M3uScanner(present, {}).consume(HLS, true)) {
      // this handler emits nothing
    }

    expect(present.warnings).toEqual([]);
  });

  it('gives the IPTV reader those same lines as entries', () => {
    const playlist = parseM3uString(HLS);

    expect(playlist.entries.map((e) => [e.duration, e.url])).toEqual([
      [9.009, 'http://e/first.ts'],
      [8.5, 'http://e/second.ts'],
    ]);
  });
});

describe('M3uTag.attributes', () => {
  const tag = (name: string, value: string) => new M3uTag(name, value, 1, 1);

  it('reads the space-separated grammar the #EXTINF layer uses', () => {
    expect(tag('EXTM3U', 'tvg-id="a.us" group-title="News"').attributes()).toEqual(
      attrs({ 'tvg-id': 'a.us', 'group-title': 'News' }),
    );
  });

  it('reads the comma-separated grammar RFC 8216 §4.2 defines', () => {
    expect(
      tag('EXT-X-KEY', 'METHOD=AES-128,URI="https://e/k.bin",IV=0x9c7d').attributes({
        separator: ',',
      }),
    ).toEqual(attrs({ METHOD: 'AES-128', URI: 'https://e/k.bin', IV: '0x9c7d' }));
  });

  it('keeps a comma inside a quoted value under either grammar', () => {
    expect(
      tag('EXT-X-STREAM-INF', 'BANDWIDTH=1280000,CODECS="avc1.42e00a,mp4a.40.2"').attributes({
        separator: ',',
      }),
    ).toEqual(attrs({ BANDWIDTH: '1280000', CODECS: 'avc1.42e00a,mp4a.40.2' }));
  });

  it('reads only the slice it is given', () => {
    // What the IPTV reader asks for: past the duration, up to the comma that
    // begins the display name.
    const extinf = tag('EXTINF', '-1 tvg-id="a.us",One HD, the good one');

    expect(extinf.attributes({ from: 2, to: 16 })).toEqual(attrs({ 'tvg-id': 'a.us' }));
  });

  it('says where a quote was opened and never closed', () => {
    const opened: number[] = [];

    expect(
      tag('EXTM3U', 'a="one" b="never closed').attributes({
        onUnterminated: (at) => opened.push(at),
      }),
    ).toEqual(attrs({ a: 'one', b: 'never closed' }));
    // The `"` after `b=`, which is where the trouble starts.
    expect(opened).toEqual([10]);
  });

  // Which grammar applies is a property of the tag, which is why the reading
  // belongs to the tag — and why a value is handed over unparsed. `#EXTVLCOPT`
  // is not an attribute list at all: one key, and a value holding spaces and
  // commas, which neither grammar reads.
  it('is not the tool for a directive carrying a single free-text value', () => {
    const vlc = tag('EXTVLCOPT', 'http-user-agent=Mozilla/5.0 (KHTML, like Gecko) Chrome/1');

    for (const separator of [' ', ','] as const) {
      expect(vlc.attributes({ separator }).get('http-user-agent')).toBe('Mozilla/5.0');
    }

    // What the tag actually means, which is the caller's business.
    const at = vlc.value.indexOf('=');

    expect([vlc.value.slice(0, at), vlc.value.slice(at + 1)]).toEqual([
      'http-user-agent',
      'Mozilla/5.0 (KHTML, like Gecko) Chrome/1',
    ]);
  });
});

describe('warnings', () => {
  it('reports a missing header against the first line that carries anything', async () => {
    const events = await parseAll('\n# a comment\n#EXTINF:-1,One\nhttp://e/1\n');
    const [warning] = warningsOf(events);

    expect(warning?.code).toBe('missing-header');
    // Line 2 — the comment — not line 1, which is blank.
    expect(warning).toMatchObject({ line: 2, col: 1 });
    // And said once, not once per line.
    expect(warningsOf(events).filter((w) => w.code === 'missing-header')).toHaveLength(1);
  });

  it('reports an entry that never got a url, and keeps it', async () => {
    const events = await parseAll('#EXTM3U\n#EXTINF:-1,One\n#EXTINF:-1,Two\nhttp://e/2\n');
    const [warning] = warningsOf(events);

    expect(warning?.code).toBe('incomplete-entry');
    expect(warning).toMatchObject({ line: 2, col: 1 });
    // Kept: a channel with nothing to play is still a channel.
    expect(entriesOf(events).map((e) => [e.name, e.url])).toEqual([
      ['One', ''],
      ['Two', 'http://e/2'],
    ]);
  });

  it('reports an entry left open at the end of the playlist', async () => {
    const events = await parseAll('#EXTM3U\n#EXTINF:-1,One\n');

    expect(warningsOf(events)[0]).toMatchObject({ code: 'incomplete-entry', line: 2 });
    expect(entriesOf(events)).toHaveLength(1);
  });

  it('reports a url with no #EXTINF before it', async () => {
    const events = await parseAll('#EXTM3U\nhttp://e/1\n');

    expect(warningsOf(events)[0]).toMatchObject({ code: 'orphan-url', line: 2, col: 1 });
    expect(entriesOf(events)).toEqual([]);
  });

  // Only one that never finds an entry at all: a directive *before* an
  // `#EXTINF` belongs to it — see the block below.
  it('reports a directive the playlist ended before an entry could claim', async () => {
    const events = await parseAll('#EXTM3U\n#EXTINF:-1,One\nhttp://e/1\n#EXTVLCOPT:x=1\n');
    const [warning] = warningsOf(events);

    expect(warning?.code).toBe('orphan-directive');
    expect(warning).toMatchObject({
      message: '#EXTVLCOPT has no #EXTINF to belong to, and is dropped',
      line: 4,
      col: 1,
    });
    expect(entriesOf(events)[0]?.directives).toBeUndefined();
  });

  it('reports an unreadable duration and keeps the entry with -1', async () => {
    const events = await parseAll('#EXTM3U\n#EXTINF:abc tvg-id="a.us",One\nhttp://e/1\n');

    expect(warningsOf(events)[0]).toMatchObject({
      code: 'invalid-duration',
      line: 2,
      // 1-based, just past `#EXTINF:` — where the duration should have been.
      col: 9,
    });
    expect(entriesOf(events)[0]).toMatchObject({ duration: -1, name: 'One' });
  });

  it('reports an unterminated quote, and keeps what parsed', async () => {
    const events = await parseAll(
      '#EXTM3U\n#EXTINF:-1 tvg-id="a.us group-title="News",One\nhttp://e/1\n',
    );
    const warnings = warningsOf(events);

    expect(warnings.some((w) => w.code === 'malformed-attributes')).toBe(true);
    expect(entriesOf(events)).toHaveLength(1);
  });

  it('reports an #EXTINF with no comma at all', async () => {
    const events = await parseAll('#EXTM3U\n#EXTINF:-1\nhttp://e/1\n');

    expect(warningsOf(events)[0]).toMatchObject({ code: 'malformed-attributes', line: 2 });
    expect(entriesOf(events)[0]).toMatchObject({ name: '', url: 'http://e/1' });
  });

  // Also from review: `startsWith` matched any tag beginning `#EXTM3U`, so
  // `#EXTM3UPLUS` was read as the header — swallowing the directive and filling
  // the header slot, which is why no missing-header warning came out either.
  it('does not mistake a longer tag for the header', async () => {
    const events = await parseAll('#EXTM3UPLUS:x\n#EXTINF:-1,One\nhttp://e/1\n');

    expect(events.filter((e) => e.type === 'header')).toEqual([]);
    expect(warningsOf(events).map((w) => w.code)).toEqual(['missing-header']);
    // Kept as what it is: an unrecognized `#` line belonging to the entry below.
    expect(entriesOf(events)[0]?.directives).toEqual([{ name: 'EXTM3UPLUS', value: 'x' }]);
  });

  it('treats a second #EXTM3U as an ordinary # line', async () => {
    const events = await parseAll('#EXTM3U\n#EXTINF:-1,One\n#EXTM3U\nhttp://e/1\n');

    expect(events.filter((e) => e.type === 'header')).toHaveLength(1);
    expect(entriesOf(events)[0]?.directives).toEqual([{ name: 'EXTM3U', value: '' }]);
  });
});

describe('attribute names from an untrusted playlist', () => {
  // A `Map`, so a hostile or merely odd name is an ordinary key. On a plain
  // object `record['__proto__'] = value` is diverted to the prototype accessor
  // and the attribute lost without a word.
  it('keeps __proto__ as an ordinary attribute, and round-trips it', () => {
    const playlist = parseM3uString(
      '#EXTM3U __proto__="fromheader"\n' +
        '#EXTINF:-1 __proto__="polluted" tvg-id="a.tv",One\n' +
        'http://e/1\n',
    );
    const [entry] = playlist.entries;

    expect(playlist.warnings).toEqual([]);
    expect(entry?.attributes.get('__proto__')).toBe('polluted');
    expect(playlist.header.attributes.get('__proto__')).toBe('fromheader');

    // And it survives being written back out, which a dropped attribute cannot.
    const again = parseM3uString(serializeM3uHeader(playlist.header) + serializeM3uEntry(entry!));

    expect(again.entries[0]?.attributes.get('__proto__')).toBe('polluted');
    expect(again.header.attributes.get('__proto__')).toBe('fromheader');
  });

  it('leaves Object.prototype alone', () => {
    parseM3uString('#EXTM3U\n#EXTINF:-1 __proto__="polluted",One\nhttp://e/1\n');

    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  // On an object these would each hand back an inherited function for a name
  // the playlist never carried, which is what makes a plain record a lie.
  it('reads an absent name as undefined', () => {
    const [entry] = parseM3uString('#EXTM3U\n#EXTINF:-1 tvg-id="a",One\nhttp://e/1\n').entries;

    expect(entry?.attributes.get('valueOf')).toBeUndefined();
    expect(entry?.attributes.get('toString')).toBeUndefined();
    expect(entry?.attributes.get('constructor')).toBeUndefined();
  });

  it('gives a playlist with no header an empty one of the same shape', () => {
    expect(parseM3uString('').header.attributes).toEqual(new Map());
  });

  it('keeps constructor and toString when they really are attributes', () => {
    const [entry] = parseM3uString(
      '#EXTM3U\n#EXTINF:-1 constructor="a" toString="b",One\nhttp://e/1\n',
    ).entries;

    expect(entry?.attributes).toEqual(attrs({ constructor: 'a', toString: 'b' }));
    expect(parseM3uString(`#EXTM3U\n${serializeM3uEntry(entry!)}`).entries[0]).toEqual(entry);
  });

  // The one thing a Map costs, and the reason `channelsFromM3u` converts.
  it('is empty under JSON.stringify, which is why the bridge converts', () => {
    const [entry] = parseM3uString('#EXTM3U\n#EXTINF:-1 tvg-id="a",One\nhttp://e/1\n').entries;

    expect(JSON.parse(JSON.stringify(entry)).attributes).toEqual({});
    expect(Object.fromEntries(entry!.attributes)).toEqual({ 'tvg-id': 'a' });
  });
});

describe('serializing', () => {
  const entry: M3uEntry = {
    url: 'http://example/one.m3u8',
    name: 'One HD, the good one',
    duration: -1,
    attributes: attrs({ 'tvg-id': 'a.us', 'http-user-agent': 'AppleWebKit (KHTML, like Gecko)' }),
    directives: [{ name: 'EXTVLCOPT', value: 'http-referrer=http://example/' }],
  };

  it('writes an entry back as the line it came from', () => {
    expect(serializeM3uEntry(entry)).toBe(
      '#EXTINF:-1 tvg-id="a.us" http-user-agent="AppleWebKit (KHTML, like Gecko)",One HD, the good one\n' +
        '#EXTVLCOPT:http-referrer=http://example/\n' +
        'http://example/one.m3u8\n',
    );
  });

  it('writes CRLF when asked', () => {
    expect(
      serializeM3uHeader({ attributes: attrs({ 'x-tvg-url': 'http://e/g.xml' }) }, { eol: '\r\n' }),
    ).toBe('#EXTM3U x-tvg-url="http://e/g.xml"\r\n');
    expect(serializeM3uEntry({ ...entry, directives: [] }, { eol: '\r\n' })).toBe(
      '#EXTINF:-1 tvg-id="a.us" http-user-agent="AppleWebKit (KHTML, like Gecko)",One HD, the good one\r\n' +
        'http://example/one.m3u8\r\n',
    );
  });

  it('writes a bare #EXTM3U for a playlist that carries nothing', () => {
    expect(serializeM3uHeader()).toBe('#EXTM3U\n');
  });

  // Refused rather than written, as `serializeProcessingInstruction` refuses a
  // `?>`: this format has no escape, so a value carrying one of these produces a
  // line that parses back as something else entirely.
  it.each([
    ['a quote in a value', { ...entry, attributes: attrs({ 'tvg-id': 'a"b' }) }],
    ['a newline in a value', { ...entry, attributes: attrs({ 'tvg-id': 'a\nb' }) }],
    ['a comma in an attribute name', { ...entry, attributes: attrs({ 'a,b': 'c' }) }],
    ['an empty attribute name', { ...entry, attributes: attrs({ '': 'c' }) }],
    ['a newline in the name', { ...entry, name: 'One\nTwo' }],
    ['a newline in the url', { ...entry, url: 'http://e/1\nhttp://e/2' }],
    ['a duration that is not a number', { ...entry, duration: Number.NaN }],
  ])('refuses to write %s', (_label, bad) => {
    expect(() => serializeM3uEntry(bad as M3uEntry)).toThrow(TypeError);
  });

  // Found by review, not by use: the serializer refused what could not be read
  // back as an *attribute*, but not what could not be read back as a *url*.
  // `#weird` came out on the url line and parsed as a directive, leaving the
  // entry incomplete — silent corruption in the one thing this module promises.
  it.each([
    ['a url beginning with #', '#weird'],
    ['a url beginning with # after spaces', '  #weird'],
    ['a url of only whitespace', '   '],
  ])('refuses %s', (_label, url) => {
    expect(() => serializeM3uEntry({ ...entry, url })).toThrow(TypeError);
  });

  // The one empty url that is allowed: it is what an incomplete entry holds,
  // and it survives the trip as exactly that rather than as corruption.
  it('writes an entry that never got a url, and reads it back the same', () => {
    const text = `#EXTM3U\n${serializeM3uEntry({ ...entry, url: '', directives: [] })}`;
    const back = parseM3uString(text);

    expect(back.warnings.map((w) => w.code)).toEqual(['incomplete-entry']);
    expect(back.entries).toEqual([
      {
        url: '',
        name: 'One HD, the good one',
        duration: -1,
        attributes: attrs({
          'tvg-id': 'a.us',
          'http-user-agent': 'AppleWebKit (KHTML, like Gecko)',
        }),
      },
    ]);
  });

  it('refuses a bad attribute name on the header too', () => {
    expect(() => serializeM3uHeader({ attributes: attrs({ 'a b': 'c' }) })).toThrow(TypeError);
  });

  it('streams a whole playlist without holding it', async () => {
    const text = await collect(
      writeM3uStream({
        header: { attributes: attrs({ 'x-tvg-url': 'http://e/g.xml' }) },
        entries: [entry],
      }),
    );

    expect(text).toBe(
      serializeM3uHeader({ attributes: attrs({ 'x-tvg-url': 'http://e/g.xml' }) }) +
        serializeM3uEntry(entry),
    );
  });

  it('writes to a file, creating parent directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'm3u-'));

    try {
      const file = join(dir, 'nested', 'out.m3u');

      await writeM3uToFile(file, { entries: [entry] });
      expect(await readFile(file, 'utf8')).toBe('#EXTM3U\n' + serializeM3uEntry(entry));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('stops between entries when the signal fires', async () => {
    const controller = new AbortController();

    controller.abort();

    await expect(
      collect(writeM3uStream({ entries: [entry] }, { signal: controller.signal })),
    ).rejects.toThrow();
  });
});

describe('round-trip', () => {
  it('gives back the same model and the same bytes', async () => {
    const document = await readFile(FIXTURE, 'utf8');
    const playlist = parseM3uString(document);

    expect(playlist.warnings).toEqual([]);

    const written = await collect(
      writeM3uStream({ header: playlist.header, entries: playlist.entries }, { eol: '\r\n' }),
    );

    // The bytes, which is the stronger claim: the fixture is a slice of a real
    // playlist, so this says unknown attributes, multiple directives, CRLF and
    // the comma case all survive a full trip.
    expect(written).toBe(document);
    expect(parseM3uString(written)).toEqual(playlist);
  });
});

describe('node streams', () => {
  it('parses through a pipeline', async () => {
    const document = await readFile(FIXTURE, 'utf8');
    const events: M3uParseEvent[] = [];

    await pipeline(Readable.from(rechunk(document, 64)), new M3uParseStream(), async (source) => {
      for await (const event of source as AsyncIterable<M3uParseEvent>) {
        events.push(event);
      }
    });

    expect(entriesOf(events)).toEqual(parseM3uString(document).entries);
  });

  it('round-trips parse → serialize as a pipeline', async () => {
    const document = await readFile(FIXTURE, 'utf8');
    let out = '';

    await pipeline(
      Readable.from([document]),
      new M3uParseStream(),
      new M3uSerializeStream({ eol: '\r\n' }),
      async (source) => {
        for await (const chunk of source) {
          out += chunk;
        }
      },
    );

    expect(out).toBe(document);
  });

  it('lets the header option override what the stream carried', async () => {
    let out = '';

    await pipeline(
      Readable.from([
        {
          type: 'header',
          value: { attributes: attrs({ 'x-tvg-url': 'http://old/g.xml', 'tvg-shift': '1' }) },
        },
        {
          type: 'entry',
          value: { url: 'http://e/1', name: 'One', duration: -1, attributes: new Map() },
        },
      ] satisfies M3uParseEvent[]),
      new M3uSerializeStream({
        header: { attributes: attrs({ 'x-tvg-url': 'http://new/g.xml' }) },
      }),
      async (source) => {
        for await (const chunk of source) {
          out += chunk;
        }
      },
    );

    expect(out).toBe(
      '#EXTM3U x-tvg-url="http://new/g.xml" tvg-shift="1"\n#EXTINF:-1,One\nhttp://e/1\n',
    );
  });

  it('writes the #EXTM3U line even for a playlist with no entries', async () => {
    let out = '';

    await pipeline(Readable.from([]), new M3uSerializeStream(), async (source) => {
      for await (const chunk of source) {
        out += chunk;
      }
    });

    expect(out).toBe('#EXTM3U\n');
  });

  it('re-emits a parse warning as a warning event', async () => {
    const warnings: M3uWarning[] = [];
    const serialize = new M3uSerializeStream();

    serialize.on('warning', (warning) => warnings.push(warning));

    await pipeline(
      Readable.from(['#EXTINF:-1,One\nhttp://e/1\n']),
      new M3uParseStream(),
      serialize,
      async (source) => {
        for await (const _chunk of source) {
          // drained
        }
      },
    );

    expect(warnings.map((w) => w.code)).toEqual(['missing-header']);
  });

  it('errors when a header arrives after the first entry', async () => {
    await expect(
      pipeline(
        Readable.from([
          {
            type: 'entry',
            value: { url: 'http://e/1', name: 'One', duration: -1, attributes: new Map() },
          },
          { type: 'header', value: { attributes: new Map() } },
        ] satisfies M3uParseEvent[]),
        new M3uSerializeStream(),
        async (source) => {
          for await (const _chunk of source) {
            // drained
          }
        },
      ),
    ).rejects.toThrow(/must precede the first entry/);
  });
});

describe('parseM3uFile', () => {
  it('reads the fixture from disk', async () => {
    const events: M3uParseEvent[] = [];

    for await (const event of parseM3uFile(FIXTURE_PATH)) {
      events.push(event);
    }

    expect(entriesOf(events)).toHaveLength(4);
    expect(warningsOf(events)).toEqual([]);
  });

  it('stops on an already-aborted signal', async () => {
    const controller = new AbortController();

    controller.abort();

    await expect(
      (async () => {
        for await (const _event of parseM3uFile(FIXTURE_PATH, { signal: controller.signal })) {
          // never reached
        }
      })(),
    ).rejects.toThrow();
  });
});

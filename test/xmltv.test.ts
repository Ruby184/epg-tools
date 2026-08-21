import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import {
  escapeXml,
  formatXmltvDate,
  getXmltvOffset,
  getXmltvPrecision,
  parseXmltvDate,
  xmltvDate,
  XmltvDateError,
  serializeChannel,
  serializeProgramme,
  serializeDocumentHeader,
  serializeDocumentFooter,
  writeXmltvStream,
  parseXmltvStream,
  parseXmltvString,
  XmltvParseStream,
  XmltvSerializeStream,
} from '../src/xmltv/main.js';
import type {
  XmltvChannel,
  XmltvParseEvent,
  XmltvProgramme,
  XmltvWarning,
} from '../src/xmltv/main.js';

async function collect(source: Iterable<string> | AsyncIterable<string>): Promise<string> {
  let out = '';

  for await (const chunk of source) {
    out += chunk;
  }

  return out;
}

function* rechunk(document: string, size: number): Generator<string> {
  for (let i = 0; i < document.length; i += size) {
    yield document.slice(i, i + size);
  }
}

/**
 * Which parse entry point to reach for — both are thin wrappers over the same
 * `XmltvScanner.consume`, so they can never differ in parse *semantics*, only
 * in I/O framing:
 *
 * - `parseAll` (this helper) streams the input in small chunks. It is the
 *   DEFAULT for parse-behavior tests, especially malformed / edge / warning
 *   inputs, because the default 7-char split fuzzes chunk boundaries for free
 *   on exactly the inputs where `NEED_MORE` bugs hide. Pass an explicit
 *   `chunkSize` (and loop `[1, 16, whole]`) when a test's claim is streaming
 *   itself: position chunk-invariance, `NEED_MORE` retry/dedup, byte-split
 *   multibyte, truncation.
 * - `parseXmltvString` (used directly) is for the synchronous whole-document
 *   API surface and trivial inputs where chunking adds nothing.
 *
 * The `real-world fixture` block asserts `parseXmltvString(xml)` equals the
 * chunked stream on a rich document — the guard that the two stay in sync.
 */
async function parseAll(document: string, chunkSize = 7): Promise<XmltvParseEvent[]> {
  const events: XmltvParseEvent[] = [];

  for await (const event of parseXmltvStream(rechunk(document, chunkSize))) {
    events.push(event);
  }

  return events;
}

describe('escapeXml', () => {
  it('escapes special characters', () => {
    expect(escapeXml(`Tom & Jerry <"'>`)).toBe('Tom &amp; Jerry &lt;&quot;&apos;&gt;');
  });

  it('leaves plain text alone', () => {
    expect(escapeXml('Bez zmeny — ľščťžýáí')).toBe('Bez zmeny — ľščťžýáí');
  });
});

describe('xmltv dates', () => {
  it('formats in UTC', () => {
    expect(formatXmltvDate(new Date('2026-07-17T20:30:05Z'))).toBe('20260717203005 +0000');
  });

  it('round-trips', () => {
    const date = new Date('2026-07-17T20:30:05Z');
    expect(parseXmltvDate(formatXmltvDate(date)).getTime()).toBe(date.getTime());
  });

  it('parses non-UTC offsets', () => {
    expect(parseXmltvDate('20260717203000 +0200').toISOString()).toBe('2026-07-17T18:30:00.000Z');
    expect(parseXmltvDate('20260717203000 -0130').toISOString()).toBe('2026-07-17T22:00:00.000Z');
  });

  it('parses truncated forms as UTC', () => {
    expect(parseXmltvDate('202607172030').toISOString()).toBe('2026-07-17T20:30:00.000Z');
    expect(parseXmltvDate('20260717').toISOString()).toBe('2026-07-17T00:00:00.000Z');
  });

  it('parses the DTD example forms, including named timezones', () => {
    // Substring precision (YYYYMM) — assumed UTC.
    expect(parseXmltvDate('200209').toISOString()).toBe('2002-09-01T00:00:00.000Z');
    expect(getXmltvPrecision(parseXmltvDate('200209'))).toBe(6);
    // Numeric offset.
    expect(parseXmltvDate('19880523083000 +0300').toISOString()).toBe('1988-05-23T05:30:00.000Z');

    // Unambiguous named UTC zones resolve to an explicit +0000.
    for (const tz of ['GMT', 'UTC', 'UT', 'Z']) {
      const d = parseXmltvDate(`200007281733 ${tz}`);
      expect(d.toISOString()).toBe('2000-07-28T17:33:00.000Z');
      expect(getXmltvOffset(d)).toBe(0);
    }
    expect(parseXmltvDate('200007281733Z').toISOString()).toBe('2000-07-28T17:33:00.000Z');

    // An unmapped named zone is rejected so it can be seen and fixed.
    expect(() => parseXmltvDate('200007281733 BST')).toThrow(XmltvDateError);
  });

  it('resolves named timezones from a supplied offset map, and rejects unmapped ones', () => {
    const tz = { BST: 60, CET: 60, CEST: 120, EST: -300 };

    // BST == +0100 (per the DTD): 17:33 local → 16:33 UTC, offset preserved.
    const bst = parseXmltvDate('200007281733 BST', tz);
    expect(bst.toISOString()).toBe('2000-07-28T16:33:00.000Z');
    expect(getXmltvOffset(bst)).toBe(60);

    // Lower-case abbreviation in the value still matches the uppercase key.
    expect(getXmltvOffset(parseXmltvDate('200007281733 est', tz))).toBe(-300);

    // A zone absent from the map is rejected, naming the offender and where.
    try {
      parseXmltvDate('200007281733 PST', tz);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(XmltvDateError);
      expect((error as XmltvDateError).reason).toBe(
        'unknown timezone "PST" — add it to the timezone offset map',
      );
      expect((error as XmltvDateError).index).toBe(13);
    }

    // Built-in UTC zones resolve even without a map.
    expect(getXmltvOffset(parseXmltvDate('200007281733 GMT', tz))).toBe(0);
  });

  it('throws on garbage', () => {
    expect(() => parseXmltvDate('not a date')).toThrow(TypeError);
  });

  it('rejects structurally valid but out-of-range dates instead of rolling them over', () => {
    expect(() => parseXmltvDate('20261345')).toThrow(TypeError); // month 13
    expect(() => parseXmltvDate('20260230')).toThrow(TypeError); // Feb 30
    expect(() => parseXmltvDate('20260717250000')).toThrow(TypeError); // hour 25
    expect(() => parseXmltvDate('20260717206000')).toThrow(TypeError); // minute 60
  });

  it('reports the reason and the index within the value on invalid dates', () => {
    const cases: [string, string, number][] = [
      ['20261345', 'month must be in 01–12', 4],
      ['20260230', 'day 30 is out of range for month 02', 6],
      ['20260717250000', 'hour must be in 00–23', 8],
      ['20260717203000 +0299', 'timezone offset minutes must be in 00–59', 18],
    ];

    for (const [value, reason, index] of cases) {
      try {
        parseXmltvDate(value);
        expect.unreachable(`expected ${value} to throw`);
      } catch (error) {
        expect(error).toBeInstanceOf(XmltvDateError);
        expect((error as XmltvDateError).reason).toBe(reason);
        expect((error as XmltvDateError).index).toBe(index);
      }
    }
  });

  it('xmltvDate throws on values that produce an Invalid Date', () => {
    expect(() => xmltvDate(Number.NaN)).toThrow(TypeError);
    expect(() => xmltvDate(new Date('nope'))).toThrow(TypeError);
    expect(() => xmltvDate('20261345')).toThrow(TypeError);
  });

  it('preserves the source offset on the Date and re-emits it', () => {
    expect(getXmltvOffset(parseXmltvDate('20260717203000 +0200'))).toBe(120);
    expect(getXmltvOffset(parseXmltvDate('20260717203000 -0130'))).toBe(-90);
    // UTC is offset 0, whether written as an explicit +0000 or omitted entirely
    // (both format identically, so nothing is stored and 0 is the default).
    expect(getXmltvOffset(parseXmltvDate('20260717203000 +0000'))).toBe(0);
    expect(getXmltvOffset(parseXmltvDate('202607172030'))).toBe(0);

    // Same wall-clock string comes back out, not a UTC-normalized one.
    expect(formatXmltvDate(parseXmltvDate('20260717203000 +0200'))).toBe('20260717203000 +0200');
    expect(formatXmltvDate(parseXmltvDate('20260717203000 -0130'))).toBe('20260717203000 -0130');
  });

  it('preserves the source precision and truncates the output to match', () => {
    expect(getXmltvPrecision(parseXmltvDate('2026'))).toBe(4);
    expect(getXmltvPrecision(parseXmltvDate('20260717'))).toBe(8);
    expect(getXmltvPrecision(parseXmltvDate('20260717203000'))).toBe(14);

    // `<date>`-style: no offset suffix, only the significant fields.
    expect(formatXmltvDate(parseXmltvDate('2026'), { offset: false })).toBe('2026');
    expect(formatXmltvDate(parseXmltvDate('20260717'), { offset: false })).toBe('20260717');
  });

  it('xmltvDate factory accepts unix seconds, strings, and flag options', () => {
    expect(xmltvDate(1_216_081_800).getTime()).toBe(1_216_081_800_000);
    expect(xmltvDate('20260717203000 +0200').getTime()).toBe(Date.UTC(2026, 6, 17, 18, 30));

    const flagged = xmltvDate('20260717', { offset: 120, precision: 8 });
    expect(getXmltvOffset(flagged)).toBe(120);
    expect(getXmltvPrecision(flagged)).toBe(8);
    expect(formatXmltvDate(flagged)).toBe('20260717 +0200');

    // Flags on a Date input are carried over, options override.
    expect(getXmltvOffset(xmltvDate(parseXmltvDate('20260717203000 +0200')))).toBe(120);
    expect(getXmltvOffset(xmltvDate(parseXmltvDate('20260717203000 +0200'), { offset: 0 }))).toBe(
      0,
    );
  });
});

const maximalProgramme: XmltvProgramme = {
  channel: 'one.example.tv',
  start: new Date('2026-07-17T20:30:00Z'),
  stop: new Date('2026-07-17T22:00:00Z'),
  pdcStart: new Date('2026-07-17T20:29:00Z'),
  vpsStart: new Date('2026-07-17T20:30:00Z'),
  showview: '123-456',
  videoplus: '987654',
  clumpidx: '0/2',
  title: [
    { value: 'Večerné správy & šport', lang: 'sk' },
    { value: 'Evening News', lang: 'en' },
  ],
  subTitle: [{ value: 'Denný prehľad', lang: 'sk' }],
  desc: [{ value: 'Správy <dňa>', lang: 'sk' }],
  credits: {
    director: ['Jana Novak'],
    actor: [
      { value: 'Peter Herec', role: 'moderátor' },
      {
        value: 'Eva Hostka',
        guest: true,
        image: [{ value: 'https://example.tv/eva.jpg', type: 'person' }],
      },
    ],
    producer: [
      {
        value: 'Prod Ucent',
        image: [{ value: 'https://example.tv/prod.jpg' }],
        url: [{ value: 'https://imdb.example/prod', system: 'imdb' }],
      },
    ],
    presenter: ['Milan Moderátor'],
  },
  date: parseXmltvDate('2026'),
  category: [
    { value: 'News', lang: 'en' },
    { value: 'Správy', lang: 'sk' },
  ],
  keyword: [{ value: 'live' }],
  language: { value: 'Slovak', lang: 'en' },
  origLanguage: { value: 'Slovak' },
  length: { units: 'minutes', value: 90 },
  icon: [{ src: 'https://example.tv/e.png', width: 120, height: 80 }],
  url: ['https://example.tv/programme/1', { value: 'https://tvdb.example/1', system: 'thetvdb' }],
  country: [{ value: 'SK' }],
  episodeNum: [{ system: 'xmltv_ns', value: '0.5.' }],
  video: { present: true, colour: false, aspect: '16:9', quality: 'HDTV' },
  audio: { present: true, stereo: 'dolby digital' },
  previouslyShown: { start: new Date('2026-07-10T20:30:00Z'), channel: 'one.example.tv' },
  premiere: { value: 'Premiéra', lang: 'sk' },
  lastChance: true,
  new: true,
  subtitles: [{ type: 'teletext', language: { value: 'Slovak' } }, { type: 'onscreen' }],
  rating: [{ system: 'VCHIP', value: 'TV-PG', icon: [{ src: 'https://example.tv/r.png' }] }],
  starRating: [{ system: 'imdb', value: '8/10' }],
  review: [{ type: 'text', source: 'Denník', reviewer: 'rk', lang: 'sk', value: 'Výborné' }],
  image: [
    { type: 'poster', size: '3', orient: 'P', system: 'tmdb', value: 'https://example.tv/p.jpg' },
  ],
};

const channels: XmltvChannel[] = [
  {
    id: 'one.example.tv',
    displayName: [{ value: 'Example One', lang: 'en' }, { value: 'Jednotka' }],
    icon: [{ src: 'https://example.tv/one.png', width: 100 }],
    url: ['https://example.tv'],
  },
  {
    id: 'two.example.tv',
    displayName: [{ value: 'Two & Co' }],
  },
];

describe('serialize', () => {
  it('serializes a channel, compact by default', () => {
    const xml = serializeChannel(channels[0]!);
    expect(xml).toContain('<channel id="one.example.tv">');
    expect(xml).toContain('<display-name lang="en">Example One</display-name>');
    expect(xml).toContain('<icon src="https://example.tv/one.png" width="100"/>');
    expect(xml).toContain('<url>https://example.tv</url>');
    // Compact: no whitespace between elements, no trailing newline.
    expect(xml).not.toContain('\n');
    expect(xml.startsWith('<channel ')).toBe(true);
    expect(xml.endsWith('</channel>')).toBe(true);
  });

  it('pretty-prints with the indent option (spaces or a custom string)', () => {
    const spaces = serializeChannel(channels[0]!, { indent: 2 });
    expect(spaces.startsWith('  <channel ')).toBe(true);
    expect(spaces).toContain('\n    <display-name lang="en">Example One</display-name>\n');
    expect(spaces).toContain('\n    <icon ');
    expect(spaces.endsWith('  </channel>\n')).toBe(true);

    // A string indent works too; `indent: 2` is just sugar for two spaces.
    const tabs = serializeChannel(channels[0]!, { indent: '\t' });
    expect(tabs.startsWith('\t<channel ')).toBe(true);
    expect(tabs).toContain('\n\t\t<display-name lang="en">');
    expect(serializeChannel(channels[0]!, { indent: '  ' })).toBe(spaces);
  });

  it('serializes a maximal programme in DTD order', () => {
    const xml = serializeProgramme(maximalProgramme);
    expect(xml).toContain(
      '<programme start="20260717203000 +0000" stop="20260717220000 +0000"' +
        ' pdc-start="20260717202900 +0000" vps-start="20260717203000 +0000"' +
        ' showview="123-456" videoplus="987654" channel="one.example.tv" clumpidx="0/2">',
    );
    expect(xml).toContain('<title lang="sk">Večerné správy &amp; šport</title>');
    expect(xml).toContain('<desc lang="sk">Správy &lt;dňa&gt;</desc>');
    expect(xml).toContain('<actor role="moderátor">Peter Herec</actor>');
    expect(xml).toContain(
      '<actor guest="yes">Eva Hostka<image type="person">https://example.tv/eva.jpg</image></actor>',
    );
    expect(xml).toContain(
      '<producer>Prod Ucent<image>https://example.tv/prod.jpg</image><url system="imdb">https://imdb.example/prod</url></producer>',
    );
    expect(xml).toContain('<length units="minutes">90</length>');
    expect(xml).toContain('<url system="thetvdb">https://tvdb.example/1</url>');
    expect(xml).toContain('<episode-num system="xmltv_ns">0.5.</episode-num>');
    expect(xml).toContain('<video>');
    expect(xml).toContain('<present>yes</present>');
    expect(xml).toContain('<colour>no</colour>');
    expect(xml).toContain('<aspect>16:9</aspect>');
    expect(xml).toContain('<quality>HDTV</quality>');
    expect(xml).toContain('<audio>');
    expect(xml).toContain('<stereo>dolby digital</stereo>');
    expect(xml).toContain(
      '<previously-shown start="20260710203000 +0000" channel="one.example.tv"/>',
    );
    expect(xml).toContain('<premiere lang="sk">Premiéra</premiere>');
    expect(xml).toContain('<last-chance/>');
    expect(xml).toContain('<new/>');
    expect(xml).toContain('<subtitles type="onscreen"/>');
    expect(xml).toContain('<star-rating system="imdb">');
    expect(xml).toContain(
      '<image type="poster" size="3" orient="P" system="tmdb">https://example.tv/p.jpg</image>',
    );

    // DTD ordering: title before credits before category before rating
    const order = [
      '<title',
      '<credits>',
      '<date>',
      '<category',
      '<icon',
      '<episode-num',
      '<video>',
      '<audio>',
      '<previously-shown',
      '<premiere',
      '<rating',
      '<review',
    ];
    const positions = order.map((tag) => xml.indexOf(tag));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('round-trips a start offset and a precision-truncated <date> through serialize/parse', () => {
    const xml = serializeProgramme({
      channel: 'x',
      start: parseXmltvDate('20260717203000 +0200'),
      title: [{ value: 'T' }],
      date: parseXmltvDate('1999'),
    });

    // Offset kept on start; <date> emitted bare (no time, no offset).
    expect(xml).toContain('start="20260717203000 +0200"');
    expect(xml).toContain('<date>1999</date>');

    const parsed = parseXmltvString(`<tv>${xml}</tv>`).programmes[0]!;
    expect(getXmltvOffset(parsed.start)).toBe(120);
    expect(parsed.start.getTime()).toBe(Date.UTC(2026, 6, 17, 18, 30));
    expect(getXmltvPrecision(parsed.date!)).toBe(4);
  });

  it('omits absent optional fields', () => {
    const xml = serializeProgramme({
      channel: 'x',
      start: new Date('2026-07-17T00:00:00Z'),
      title: [{ value: 'T' }],
    });
    expect(xml).not.toContain('<desc');
    expect(xml).not.toContain('<credits');
    expect(xml).not.toContain('stop=');
  });

  it('assembles a whole document by hand from header/footer + element serializers', () => {
    const meta = { generatorInfoName: 'epg-tools' };
    const xml =
      serializeDocumentHeader(meta) +
      channels.map((channel) => serializeChannel(channel)).join('') +
      serializeProgramme(maximalProgramme) +
      serializeDocumentFooter();

    const doc = parseXmltvString(xml);
    expect(doc.meta).toEqual(meta);
    expect(doc.channels).toEqual(channels);
    expect(doc.programmes).toEqual([maximalProgramme]);

    // Header/footer honour indent (same options API as the element serializers).
    expect(serializeDocumentHeader(undefined, { indent: 2 })).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE tv SYSTEM "xmltv.dtd">\n<tv>\n',
    );
    expect(serializeDocumentFooter({ indent: 2 })).toBe('</tv>\n');
    expect(serializeDocumentFooter()).toBe('</tv>'); // compact: no trailing newline
  });
});

describe('writeXmltvStream', () => {
  it('produces a full document with meta attributes', async () => {
    const xml = await collect(
      writeXmltvStream({
        meta: {
          date: new Date('2026-07-17T00:00:00Z'),
          generatorInfoName: 'epg-tools',
          sourceInfoName: 'Test & Source',
        },
        channels,
        programmes: [maximalProgramme],
      }),
    );

    // Compact by default: header, doctype and root run together, no newlines.
    expect(
      xml.startsWith('<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE tv SYSTEM "xmltv.dtd"><tv'),
    ).toBe(true);
    expect(xml).not.toContain('\n');
    expect(xml).toContain('generator-info-name="epg-tools"');
    expect(xml).toContain('source-info-name="Test &amp; Source"');
    expect(xml).toContain('date="20260717000000 +0000"');
    expect(xml.endsWith('</tv>')).toBe(true);
    expect(xml.indexOf('<channel')).toBeLessThan(xml.indexOf('<programme'));
  });

  it('pretty-prints the whole document with the indent option', async () => {
    const xml = await collect(
      writeXmltvStream({ channels, programmes: [maximalProgramme] }, { indent: 2 }),
    );

    expect(
      xml.startsWith(
        '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE tv SYSTEM "xmltv.dtd">\n<tv',
      ),
    ).toBe(true);
    expect(xml).toContain('\n  <channel ');
    expect(xml).toContain('\n  <programme ');
    expect(xml).toContain('\n    <title ');
    expect(xml.endsWith('</tv>\n')).toBe(true);
    // Same content whichever way it is formatted.
    const compact = await collect(writeXmltvStream({ channels, programmes: [maximalProgramme] }));
    expect(parseXmltvString(xml)).toEqual(parseXmltvString(compact));
  });

  it('accepts async iterables', async () => {
    async function* channelGen() {
      yield channels[0]!;
    }
    async function* programmeGen() {
      yield maximalProgramme;
    }

    const xml = await collect(
      writeXmltvStream({ channels: channelGen(), programmes: programmeGen() }),
    );
    expect(xml).toContain('<channel id="one.example.tv">');
    expect(xml).toContain('<programme ');
  });
});

const xmllintAvailable = (() => {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!xmllintAvailable)('DTD validity (xmllint against official xmltv.dtd)', () => {
  it('a maximal document validates against the official DTD', async () => {
    const xml = await collect(
      writeXmltvStream({
        meta: {
          date: new Date('2026-07-17T00:00:00Z'),
          sourceInfoName: 'Test Source',
          sourceInfoUrl: 'https://example.tv',
          sourceDataUrl: 'https://example.tv/data',
          generatorInfoName: 'epg-tools',
          generatorInfoUrl: 'https://example.tv/generator',
        },
        channels,
        programmes: [
          maximalProgramme,
          {
            channel: 'two.example.tv',
            start: new Date('2026-07-18T06:00:00Z'),
            title: [{ value: 'Minimal' }],
          },
        ],
      }),
    );

    // The document references SYSTEM "xmltv.dtd", so validate it from a
    // directory containing the official DTD.
    const dir = await mkdtemp(join(tmpdir(), 'epg-dtd-'));

    try {
      await copyFile(join(import.meta.dirname, 'fixtures', 'xmltv.dtd'), join(dir, 'xmltv.dtd'));
      const file = join(dir, 'guide.xml');
      await writeFile(file, xml, 'utf8');

      // Throws (non-zero exit) on any validity error.
      expect(() =>
        execFileSync('xmllint', ['--noout', '--valid', file], { encoding: 'utf8' }),
      ).not.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('warnings', () => {
  it('skips a programme with an invalid start, warns with line/col, and continues', async () => {
    const xml =
      '<tv>\n' +
      '  <programme start="garbage" channel="c"><title>Bad</title></programme>\n' +
      '  <programme start="20260717210000 +0000" channel="c"><title>Good</title></programme>\n' +
      '</tv>';

    for (const chunkSize of [1, 16, xml.length]) {
      const events = await parseAll(xml, chunkSize);
      const programmes = events.filter((e) => e.type === 'programme').map((e) => e.value);
      const warnings = events.filter((e) => e.type === 'warning').map((e) => e.value);

      expect(programmes).toHaveLength(1);
      expect((programmes[0] as XmltvProgramme).title).toEqual([{ value: 'Good' }]);
      expect(warnings).toEqual([
        {
          code: 'invalid-programme',
          message:
            'skipped <programme> with invalid start="garbage": expected a datetime, found no digits at index 0',
          line: 2,
          col: 3,
        },
      ]);
    }
  });

  it('skips a programme without a start attribute', async () => {
    const xml = '<tv><programme channel="c"><title>T</title></programme></tv>';
    const events = await parseAll(xml);

    expect(events.filter((e) => e.type === 'programme')).toEqual([]);
    expect(events.filter((e) => e.type === 'warning').map((e) => e.value.code)).toEqual([
      'invalid-programme',
    ]);
  });

  it('warns when a recognized attribute is present but empty', async () => {
    const xml =
      '<tv><programme start="20260717200000 +0000" channel="c" stop=""><title>T</title></programme></tv>';
    const events = await parseAll(xml);
    const warnings = events.filter((e) => e.type === 'warning').map((e) => e.value);

    expect(warnings.map((w) => ({ code: w.code, message: w.message }))).toContainEqual({
      code: 'invalid-attribute',
      message: 'empty value for stop on <programme> dropped',
    });
  });

  it('warns on an empty recognized attribute on the root <tv> element', async () => {
    const xml =
      '<tv date="" source-info-name=""><programme start="20260717200000 +0000" channel="c">' +
      '<title>T</title></programme></tv>';
    const events = await parseAll(xml);
    const messages = events.filter((e) => e.type === 'warning').map((e) => e.value.message);

    expect(messages).toContain('empty value for date on <tv> dropped');
    expect(messages).toContain('empty value for source-info-name on <tv> dropped');
  });

  it('resolves named timezones via the timezones parse option, and warns on unmapped ones', () => {
    const xml =
      '<tv><programme start="20260717203000 BST" channel="c"><title>T</title></programme></tv>';

    // With a mapping the programme parses and the offset is preserved.
    const mapped = parseXmltvString(xml, { timezones: { BST: 60 } });
    expect(mapped.programmes).toHaveLength(1);
    expect(getXmltvOffset(mapped.programmes[0]!.start)).toBe(60);
    expect(mapped.warnings).toEqual([]);

    // Without it the unknown zone drops the programme with a naming warning.
    const unmapped = parseXmltvString(xml);
    expect(unmapped.programmes).toHaveLength(0);
    expect(unmapped.warnings[0]!.message).toContain('unknown timezone "BST"');
  });

  it('warns on a duplicate single-occurrence element, keeping the first and skipping the repeat', () => {
    const head = '<tv><programme start="20260717200000 +0000" channel="c"><title>T</title>';
    const xml = `${head}<length units="minutes">30</length><length units="minutes">45</length></programme></tv>`;
    const doc = parseXmltvString(xml);

    // First wins; the repeat is dropped.
    expect(doc.programmes[0]!.length).toEqual({ units: 'minutes', value: 30 });

    const dup = doc.warnings.find((w) => w.message.startsWith('duplicate <length>'))!;
    expect(dup.message).toBe('duplicate <length> element ignored, keeping the first');
    expect(dup.code).toBe('invalid-element');
    // Anchored at the second <length> (the ignored one), not the first.
    expect(dup.col).toBe(xml.indexOf('<length', xml.indexOf('<length') + 1) + 1);
  });

  it('skips a duplicate structured element without parsing its subtree', () => {
    const xml =
      '<tv><programme start="20260717200000 +0000" channel="c"><title>T</title>' +
      '<video><aspect>16:9</aspect></video><video><aspect>4:3</aspect></video></programme></tv>';
    const doc = parseXmltvString(xml);

    expect(doc.programmes[0]!.video).toEqual({ aspect: '16:9' });
    expect(doc.warnings.map((w) => w.message)).toContain(
      'duplicate <video> element ignored, keeping the first',
    );
  });

  it('warns on and skips a duplicate nested single-occurrence child', () => {
    const xml =
      '<tv><programme start="20260717200000 +0000" channel="c"><title>T</title>' +
      '<video><aspect>16:9</aspect><aspect>4:3</aspect></video>' +
      '<rating><value>PG</value><value>R</value></rating>' +
      '</programme></tv>';
    const doc = parseXmltvString(xml);
    const p = doc.programmes[0]!;

    // First child of each kind wins.
    expect(p.video).toEqual({ aspect: '16:9' });
    expect(p.rating).toEqual([{ value: 'PG' }]);

    const messages = doc.warnings.map((w) => w.message);
    expect(messages).toContain('duplicate <aspect> in <video> ignored, keeping the first');
    expect(messages).toContain('duplicate <value> in <rating> ignored, keeping the first');
  });

  it('uses the same "empty value for" phrasing for an empty yes/no attribute', async () => {
    const xml =
      '<tv><programme start="20260717200000 +0000" channel="c"><title>T</title>' +
      '<credits><actor guest="">Ann</actor></credits></programme></tv>';
    const events = await parseAll(xml);
    const warnings = events.filter((e) => e.type === 'warning').map((e) => e.value);

    expect(warnings.map((w) => w.message)).toContain('empty value for guest on <actor> dropped');
  });

  it('warns once and skips a nested element found inside a text element', async () => {
    const xml =
      '<tv><programme start="20260717200000 +0000" channel="c">' +
      '<title>Hello <b>World</b></title></programme></tv>';
    const events = await parseAll(xml);
    const programme = events.find((e) => e.type === 'programme')!.value as XmltvProgramme;
    const warnings = events.filter((e) => e.type === 'warning').map((e) => e.value);

    expect(programme.title).toEqual([{ value: 'Hello' }]);
    expect(warnings).toEqual([
      {
        code: 'unknown-element',
        message: 'nested <b> inside text element <title> ignored',
        line: 1,
        col: expect.any(Number),
      },
    ]);
  });

  it('skips a programme without the required channel attribute', async () => {
    const xml = '<tv><programme start="20260717200000 +0000"><title>T</title></programme></tv>';
    const events = await parseAll(xml);
    const warnings = events.filter((e) => e.type === 'warning').map((e) => e.value);

    expect(events.filter((e) => e.type === 'programme')).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe('invalid-programme');
    expect(warnings[0]!.message).toContain('without a channel attribute');
  });

  it('keeps the programme but warns when stop is invalid', async () => {
    const xml =
      '<tv><programme start="20260717200000 +0000" stop="nope" channel="c">' +
      '<title>T</title></programme></tv>';
    const events = await parseAll(xml);
    const programme = events.find((e) => e.type === 'programme')?.value as XmltvProgramme;
    const warnings = events.filter((e) => e.type === 'warning').map((e) => e.value);

    expect(programme.stop).toBeUndefined();
    expect(programme.title).toEqual([{ value: 'T' }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe('invalid-attribute');
    expect(warnings[0]!.message).toContain('invalid value "nope" for stop on <programme>');
  });

  it('anchors an invalid programme attribute at the attribute, not the tag', async () => {
    const line2 =
      '<programme start="20260717200000 +0000" stop="nope" channel="c"><title>T</title></programme>';
    const xml = `<tv>\n${line2}\n</tv>`;
    // 1-based column of the "stop" attribute name on line 2.
    const expectedCol = line2.indexOf('stop=') + 1;

    for (const chunkSize of [1, 16, xml.length]) {
      const warnings = (await parseAll(xml, chunkSize))
        .filter((e) => e.type === 'warning')
        .map((e) => e.value);

      expect(warnings).toEqual([
        {
          code: 'invalid-attribute',
          message:
            'invalid value "nope" for stop on <programme> dropped: expected a datetime, found no digits at index 0',
          line: 2,
          col: expectedCol,
        },
      ]);
    }
  });

  it('anchors an invalid child-element attribute at the attribute, not the element', async () => {
    const xml =
      '<tv><programme start="20260717200000 +0000" channel="c">' +
      '<title>T</title><image size="9">https://x.tv/f.jpg</image></programme></tv>';
    // Single line: 1-based column equals the 0-based index + 1.
    const expectedCol = xml.indexOf('size=') + 1;

    for (const chunkSize of [1, 16, xml.length]) {
      const warnings = (await parseAll(xml, chunkSize))
        .filter((e) => e.type === 'warning')
        .map((e) => e.value)
        .filter((w) => w.message.includes('size='));

      expect(warnings).toEqual([
        {
          code: 'invalid-attribute',
          message: 'invalid size="9" on <image> dropped',
          line: 1,
          col: expectedCol,
        },
      ]);
    }
  });

  it('does not duplicate warnings across chunk-boundary retries', async () => {
    // 1-byte chunks force the programme to be re-parsed once per byte;
    // buffered warnings must still be emitted exactly once.
    const xml =
      '<tv><programme start="20260717200000 +0000" stop="bad" channel="c">' +
      '<title>T</title></programme></tv>';
    const events = await parseAll(xml, 1);

    expect(events.filter((e) => e.type === 'warning')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'programme')).toHaveLength(1);
  });

  it('drops an invalid <tv> date (anchored at the attribute) but keeps other meta and extras', async () => {
    const xml =
      '<tv date="notadate" generator-info-name="grabber" data-provider="acme">' +
      '<programme start="20260717200000 +0000" channel="c"><title>T</title></programme></tv>';
    const events = await parseAll(xml);
    const meta = events.find((e) => e.type === 'meta')?.value;
    const warnings = events.filter((e) => e.type === 'warning').map((e) => e.value);

    expect(meta).toEqual({
      generatorInfoName: 'grabber',
      extraAttributes: { 'data-provider': 'acme' },
    });
    expect(warnings).toEqual([
      {
        code: 'invalid-attribute',
        message:
          'invalid value "notadate" for date on <tv> dropped: expected a datetime, found no digits at index 0',
        line: 1,
        col: xml.indexOf('date=') + 1,
      },
    ]);
  });

  it('drops a <channel> without the required id, warns, and keeps parsing', async () => {
    // <channel id> is #REQUIRED by the DTD; a channel missing it is dropped
    // (body discarded) with a warning, and the following valid channel must
    // still parse — proving the discard leaves the scanner correctly placed.
    const xml =
      '<tv>' +
      '<channel><display-name>Orphan</display-name><icon src="https://x.tv/o.png"/></channel>' +
      '<channel id="good.tv"><display-name>Good</display-name></channel>' +
      '</tv>';

    for (const chunkSize of [1, 16, xml.length]) {
      const events = await parseAll(xml, chunkSize);
      const channels = events.filter((e) => e.type === 'channel').map((e) => e.value);
      const warnings = events.filter((e) => e.type === 'warning').map((e) => e.value);

      expect(channels).toEqual([{ id: 'good.tv', displayName: [{ value: 'Good' }] }]);
      expect(warnings).toEqual([
        {
          code: 'invalid-element',
          message: '<channel> without an id attribute dropped',
          line: 1,
          col: '<tv>'.length + 1,
        },
      ]);
    }
  });

  it('drops a self-closing <channel> without an id', async () => {
    const xml =
      '<tv><channel/><channel id="good.tv"><display-name>Good</display-name></channel></tv>';
    const events = await parseAll(xml);
    const channels = events.filter((e) => e.type === 'channel').map((e) => e.value);
    const warnings = events.filter((e) => e.type === 'warning').map((e) => e.value);

    expect(channels).toEqual([{ id: 'good.tv', displayName: [{ value: 'Good' }] }]);
    expect(warnings.map((w) => w.code)).toEqual(['invalid-element']);
  });

  it('warns about truncated input at end of stream', async () => {
    const xml =
      '<tv><programme start="20260717200000 +0000" channel="c"><title>Full</title></programme>' +
      '<programme start="20260717210000 +0000" channel="c"><title>Cut';
    const events = await parseAll(xml);
    const programmes = events.filter((e) => e.type === 'programme');
    const warnings = events.filter((e) => e.type === 'warning').map((e) => e.value);

    expect(programmes).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe('truncated-input');
  });

  it('keeps the first of a duplicated attribute and warns at the dropped later one', async () => {
    const line =
      '<programme start="20260717200000 +0000" channel="first" channel="second"><title>T</title></programme>';
    const xml = `<tv>${line}</tv>`;
    const events = await parseAll(xml);
    const programme = events.find((e) => e.type === 'programme')?.value as XmltvProgramme;
    const warnings = events.filter((e) => e.type === 'warning').map((e) => e.value);

    // First value wins, matching the first-wins rule for duplicate elements.
    expect(programme.channel).toBe('first');
    // Warning names the ignored later value, anchored at that later attribute.
    expect(warnings).toEqual([
      {
        code: 'invalid-attribute',
        message: 'duplicate attribute channel="second" ignored, keeping the first',
        line: 1,
        col: '<tv>'.length + line.indexOf('channel=', line.indexOf('channel=') + 1) + 1,
      },
    ]);
  });

  it('warns about unknown top-level elements', async () => {
    const xml =
      '<tv><junk attr="1">x</junk>' +
      '<programme start="20260717200000 +0000" channel="c"><title>T</title></programme></tv>';
    const events = await parseAll(xml);
    const warnings = events.filter((e) => e.type === 'warning').map((e) => e.value);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe('unknown-element');
    expect(warnings[0]!.message).toContain('<junk>');
    expect(events.filter((e) => e.type === 'programme')).toHaveLength(1);
  });

  it('warns about dropped invalid enum and element values', async () => {
    const xml =
      '<tv><programme start="20260717200000 +0000" channel="c">' +
      '<title>T</title>' +
      '<length units="parsecs">12</length>' +
      '<rating system="x"><icon src="https://x.tv/r.png"/></rating>' +
      '<image type="fanart" size="9" orient="landscape">https://x.tv/f.jpg</image>' +
      '</programme></tv>';
    const events = await parseAll(xml);
    const programme = events.find((e) => e.type === 'programme')?.value as XmltvProgramme;
    const codes = events
      .filter((e) => e.type === 'warning')
      .map((e) => e.value.code)
      .sort();

    expect(programme.length).toBeUndefined();
    expect(programme.rating).toBeUndefined();
    expect(programme.image).toEqual([{ value: 'https://x.tv/f.jpg' }]);
    expect(codes).toEqual([
      'invalid-attribute',
      'invalid-attribute',
      'invalid-attribute',
      'invalid-element',
      'invalid-element',
    ]);
  });

  it('keeps valid image size/orient enum values', async () => {
    const xml =
      '<tv><programme start="20260717200000 +0000" channel="c">' +
      '<title>T</title>' +
      '<image size="3" orient="P">https://x.tv/p.jpg</image>' +
      '</programme></tv>';
    const events = await parseAll(xml);
    const programme = events.find((e) => e.type === 'programme')?.value as XmltvProgramme;

    expect(programme.image).toEqual([{ value: 'https://x.tv/p.jpg', size: '3', orient: 'P' }]);
    expect(events.filter((e) => e.type === 'warning')).toEqual([]);
  });

  it('resolves yes/no fields to true, false, or undefined-with-warning, never a false negative', async () => {
    const xml =
      '<tv><programme start="20260717200000 +0000" channel="c">' +
      '<title>T</title>' +
      '<credits><actor guest="no">Bit Player</actor></credits>' +
      '<video><present>maybe</present><colour>no</colour></video>' +
      '<audio><present>yes</present></audio>' +
      '</programme></tv>';
    const events = await parseAll(xml);
    const programme = events.find((e) => e.type === 'programme')?.value as XmltvProgramme;
    const warnings = events.filter((e) => e.type === 'warning').map((e) => e.value);

    // explicit "no" -> false, never silently dropped to undefined
    expect(programme.credits?.actor?.[0]?.guest).toBe(false);
    expect(programme.video?.colour).toBe(false);
    // explicit "yes" -> true
    expect(programme.audio?.present).toBe(true);
    // garbage -> left unset (not coerced to false), with a warning
    expect(programme.video?.present).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe('invalid-element');
    expect(warnings[0]!.message).toContain('<present> on <video>');
    // Anchored at the offending <present> child, not the enclosing <video>.
    expect(warnings[0]!.line).toBe(1);
    expect(warnings[0]!.col).toBe(xml.indexOf('<present>maybe') + 1);
  });

  it('anchors an invalid actor guest attribute at the attribute, not the <actor>', async () => {
    const xml =
      '<tv><programme start="20260717200000 +0000" channel="c"><title>T</title>' +
      '<credits><actor guest="maybe">Someone</actor></credits></programme></tv>';
    const events = await parseAll(xml);
    const programme = events.find((e) => e.type === 'programme')?.value as XmltvProgramme;
    const warnings = events.filter((e) => e.type === 'warning').map((e) => e.value);

    // Invalid yes/no -> left unset, never coerced.
    expect(programme.credits?.actor).toEqual([{ value: 'Someone' }]);
    expect(warnings).toEqual([
      {
        code: 'invalid-attribute',
        message: 'invalid value "maybe" for guest on <actor> dropped (expected yes|no)',
        line: 1,
        col: xml.indexOf('guest=') + 1,
      },
    ]);
  });
});

describe('parseXmltvStream', () => {
  it('throws when the root element is not <tv>', async () => {
    const xml =
      '<guide><programme start="20260717200000 +0000" channel="c">' +
      '<title>T</title></programme></guide>';

    for (const chunkSize of [3, xml.length]) {
      await expect(async () => {
        for await (const _event of parseXmltvStream(rechunk(xml, chunkSize))) {
          // drain
        }
      }).rejects.toThrow(/expected root element <tv>, found <guide>/);
    }
  });

  it('throws if no root element appears within the first megabyte', async () => {
    const filler = ' '.repeat(1_048_577);

    await expect(async () => {
      for await (const _event of parseXmltvStream([filler])) {
        // drain
      }
    }).rejects.toThrow(/No root element/);
  });

  it('honours a custom rootScanLimit', () => {
    const headless = ' '.repeat(500);

    // Below the custom limit: no root, but no throw either — just empty.
    const doc = parseXmltvString(headless, { rootScanLimit: 1000 });
    expect(doc.channels).toEqual([]);
    expect(doc.programmes).toEqual([]);

    // Above it: give up with a message reporting the configured limit.
    expect(() => parseXmltvString(headless, { rootScanLimit: 100 })).toThrow(
      /No root element found within the first 100 characters/,
    );
  });

  it('round-trips a rich document across awkward chunk boundaries', async () => {
    const simple: XmltvProgramme = {
      channel: 'two.example.tv',
      start: new Date('2026-07-18T06:00:00Z'),
      title: [{ value: 'Ráno' }],
    };

    const xml = await collect(
      writeXmltvStream({
        meta: { generatorInfoName: 'epg-tools', date: new Date('2026-07-17T00:00:00Z') },
        channels,
        programmes: [maximalProgramme, simple],
      }),
    );

    for (const chunkSize of [1, 7, 64, xml.length]) {
      const events = await parseAll(xml, chunkSize);

      expect(events[0]).toEqual({
        type: 'meta',
        value: { generatorInfoName: 'epg-tools', date: new Date('2026-07-17T00:00:00Z') },
      });

      const parsedChannels = events.filter((e) => e.type === 'channel').map((e) => e.value);
      const parsedProgrammes = events.filter((e) => e.type === 'programme').map((e) => e.value);

      expect(parsedChannels).toEqual(channels);
      expect(parsedProgrammes).toEqual([maximalProgramme, simple]);
    }
  });

  it('accepts byte chunks split inside multi-byte characters', async () => {
    const xml = await collect(
      writeXmltvStream({
        channels: [channels[0]!],
        programmes: [maximalProgramme],
      }),
    );
    const bytes = new TextEncoder().encode(xml);

    function* byteChunks(): Generator<Uint8Array> {
      for (let i = 0; i < bytes.length; i += 5) {
        yield bytes.slice(i, i + 5);
      }
    }

    const events: XmltvParseEvent[] = [];

    for await (const event of parseXmltvStream(byteChunks())) {
      events.push(event);
    }

    const programme = events.find((e) => e.type === 'programme')?.value as XmltvProgramme;
    expect(programme.title).toEqual(maximalProgramme.title);
    expect(programme.desc).toEqual(maximalProgramme.desc);
  });

  it('decodes entities and numeric references', async () => {
    const xml =
      '<tv><programme start="20260717200000 +0000" channel="c">' +
      '<title>Caf&#233; &amp; Bar &#x1F37A;</title></programme></tv>';
    const events = await parseAll(xml, 3);
    const programme = events.find((e) => e.type === 'programme')?.value as XmltvProgramme;
    expect(programme.title[0]!.value).toBe('Café & Bar 🍺');
  });

  it('handles CDATA sections', async () => {
    const xml =
      '<tv><programme start="20260717200000 +0000" channel="c">' +
      '<title><![CDATA[5 < 6 & 7 > 2]]></title></programme></tv>';
    const events = await parseAll(xml);
    const programme = events.find((e) => e.type === 'programme')?.value as XmltvProgramme;
    expect(programme.title[0]!.value).toBe('5 < 6 & 7 > 2');
  });

  it('skips comments; unknown elements are preserved as extras', async () => {
    const xml =
      '<?xml version="1.0"?><!DOCTYPE tv SYSTEM "xmltv.dtd">' +
      '<tv><!-- a <comment> with tags -->' +
      '<channel id="c"><display-name>C</display-name></channel>' +
      '<programme start="20260717200000 +0000" channel="c">' +
      '<title>T</title>' +
      '<video><present>yes</present><aspect>16:9</aspect></video>' +
      '<mystery-element attr="1"><nested/></mystery-element>' +
      '</programme></tv>';
    const events = await parseAll(xml);
    const programme = events.find((e) => e.type === 'programme')?.value as XmltvProgramme;
    expect(programme).toEqual({
      channel: 'c',
      start: new Date('2026-07-17T20:00:00Z'),
      title: [{ value: 'T' }],
      video: { present: true, aspect: '16:9' },
      extra: [
        { name: 'mystery-element', attributes: { attr: '1' }, children: [{ name: 'nested' }] },
      ],
    });
  });

  describe('provider extensions (tvheadend-style)', () => {
    const extended: XmltvProgramme = {
      channel: 'one.example.tv',
      start: new Date('2026-07-17T20:30:00Z'),
      title: [{ value: 'Show' }],
      category: [{ value: 'Dokumentárny film', lang: 'sk', extraAttributes: { eit: '0x23' } }],
      extraAttributes: { uniqueID: 'ev-123456' },
      extra: [
        { name: 'live' },
        {
          name: 'crid',
          children: [
            { name: 'series', value: 'crid://example.tv/series/9' },
            { name: 'episode', value: 'crid://example.tv/ep/9x04' },
          ],
        },
      ],
    };

    const extendedChannel: XmltvChannel = {
      id: 'one.example.tv',
      displayName: [{ value: 'One' }],
      extraAttributes: { provider: 'antik' },
      extra: [{ name: 'lcn', value: '12' }],
    };

    it('serializes extension attributes and elements', () => {
      const programmeXml = serializeProgramme(extended);
      expect(programmeXml).toContain('uniqueID="ev-123456"');
      expect(programmeXml).toContain('<category lang="sk" eit="0x23">Dokumentárny film</category>');
      expect(programmeXml).toContain('<live/>');
      expect(programmeXml).toContain(
        '<crid><series>crid://example.tv/series/9</series><episode>crid://example.tv/ep/9x04</episode></crid>',
      );

      const channelXml = serializeChannel(extendedChannel);
      expect(channelXml).toContain('<channel id="one.example.tv" provider="antik">');
      expect(channelXml).toContain('<lcn>12</lcn>');
    });

    it('captures unknown children inside <video>/<audio> as extra and round-trips them', () => {
      const xml =
        '<tv><programme start="20260717200000 +0000" channel="c">' +
        '<title>T</title>' +
        '<video><present>yes</present><aspect>16:9</aspect><hdr>dolby-vision</hdr></video>' +
        '<audio><stereo>surround</stereo><codec system="x">eac3</codec></audio>' +
        '</programme></tv>';
      const doc = parseXmltvString(xml);
      const programme = doc.programmes[0]!;

      expect(doc.warnings).toEqual([]);
      expect(programme.video).toEqual({
        present: true,
        aspect: '16:9',
        extra: [{ name: 'hdr', value: 'dolby-vision' }],
      });
      expect(programme.audio).toEqual({
        stereo: 'surround',
        extra: [{ name: 'codec', attributes: { system: 'x' }, value: 'eac3' }],
      });

      // The captured extras survive a serialize + parse round-trip.
      const reparsed = parseXmltvString(`<tv>${serializeProgramme(programme)}</tv>`);
      expect(reparsed.warnings).toEqual([]);
      expect(reparsed.programmes[0]).toEqual(programme);
    });

    it('captures unknown children in rating/subtitles/credits/person as extra and round-trips', () => {
      const xml =
        '<tv><programme start="20260717200000 +0000" channel="c">' +
        '<title>T</title>' +
        // <director> is mixed content, so a provider extension child is preserved;
        // <award> is not a credit role, so it is kept on credits.extra.
        '<credits><director>Jane<medal>gold</medal></director><award>Emmy</award></credits>' +
        '<rating system="MPAA"><value>PG</value><note>mild</note></rating>' +
        '<subtitles type="teletext"><page>888</page></subtitles>' +
        '</programme></tv>';
      const doc = parseXmltvString(xml);
      const programme = doc.programmes[0]!;

      expect(doc.warnings).toEqual([]);
      expect(programme.credits).toEqual({
        director: [{ value: 'Jane', extra: [{ name: 'medal', value: 'gold' }] }],
        extra: [{ name: 'award', value: 'Emmy' }],
      });
      expect(programme.rating).toEqual([
        { system: 'MPAA', value: 'PG', extra: [{ name: 'note', value: 'mild' }] },
      ]);
      expect(programme.subtitles).toEqual([
        { type: 'teletext', extra: [{ name: 'page', value: '888' }] },
      ]);

      const reparsed = parseXmltvString(`<tv>${serializeProgramme(programme)}</tv>`);
      expect(reparsed.warnings).toEqual([]);
      expect(reparsed.programmes[0]).toEqual(programme);
    });

    it('tolerates processing instructions inside extension and credit elements', async () => {
      const xml =
        '<tv><programme start="20260717200000 +0000" channel="c">' +
        '<title>T</title>' +
        '<credits><director><?pi ignore?>Jana Novak</director></credits>' +
        '<mystery><?php echo "x"; ?>value</mystery>' +
        '</programme></tv>';
      const events = await parseAll(xml);
      const programme = events.find((e) => e.type === 'programme')?.value as XmltvProgramme;

      expect(programme.credits).toEqual({ director: ['Jana Novak'] });
      expect(programme.extra).toEqual([{ name: 'mystery', value: 'value' }]);
    });

    it('drops an attribute literally named __proto__ and warns, instead of storing it', async () => {
      // There is no legitimate XMLTV use for this name, and a plain
      // `obj[name] = value` assignment would silently divert to the
      // prototype accessor rather than creating a normal data property —
      // so it's rejected outright rather than special-cased through every
      // consumer of extraAttributes.
      const xml =
        '<tv><programme start="20260717200000 +0000" channel="c" __proto__="evil">' +
        '<title>T</title></programme></tv>';
      const events = await parseAll(xml);
      const programme = events.find((e) => e.type === 'programme')?.value as XmltvProgramme;
      const warnings = events.filter((e) => e.type === 'warning').map((e) => e.value);

      expect(programme.extraAttributes).toBeUndefined();
      expect(warnings).toEqual([
        {
          code: 'invalid-attribute',
          message: 'attribute name "__proto__" is not supported and was dropped',
          line: 1,
          // anchored at the offending attribute, not the enclosing tag's '<'.
          col: xml.indexOf('__proto__') + 1,
        },
      ]);
      // Object.prototype must be untouched.
      expect(({} as Record<string, unknown>).evil).toBeUndefined();

      const out = serializeProgramme(programme);
      expect(out).not.toContain('__proto__');
    });

    it('parses extension elements named like HTML void tags (link, meta, img)', async () => {
      // txml's default selfClosingTags treats these names as childless (HTML
      // behavior) and then throws on their close tags — must be disabled.
      const xml =
        '<tv><programme start="20260717200000 +0000" channel="c">' +
        '<title>T</title>' +
        '<link>https://example.tv/more</link>' +
        '<meta name="provider">antik</meta>' +
        '<img>https://example.tv/x.jpg</img>' +
        '</programme></tv>';
      const events = await parseAll(xml);
      const programme = events.find((e) => e.type === 'programme')?.value as XmltvProgramme;

      expect(programme.extra).toEqual([
        { name: 'link', value: 'https://example.tv/more' },
        { name: 'meta', attributes: { name: 'provider' }, value: 'antik' },
        { name: 'img', value: 'https://example.tv/x.jpg' },
      ]);
    });

    it('round-trips extension attributes on every element type', async () => {
      const deep: XmltvProgramme = {
        channel: 'one.example.tv',
        start: new Date('2026-07-17T20:30:00Z'),
        title: [{ value: 'Deep' }],
        credits: {
          director: [{ value: 'Dir', extraAttributes: { imdb: 'nm1' } }],
          actor: [{ value: 'Act', role: 'lead', extraAttributes: { imdb: 'nm2' } }],
        },
        length: { units: 'minutes', value: 90, extraAttributes: { approx: 'yes' } },
        icon: [{ src: 'https://x.tv/i.png', extraAttributes: { shape: 'wide' } }],
        url: [{ value: 'https://x.tv/p', system: 'tvdb', extraAttributes: { rel: 'canonical' } }],
        episodeNum: [{ system: 'xmltv_ns', value: '0.1.', extraAttributes: { total: '10' } }],
        video: { aspect: '16:9', extraAttributes: { codec: 'h265' } },
        audio: { stereo: 'stereo', extraAttributes: { lang: 'sk' } },
        previouslyShown: { channel: 'one.example.tv', extraAttributes: { count: '2' } },
        subtitles: [{ type: 'teletext', extraAttributes: { page: '888' } }],
        rating: [{ system: 'VCHIP', value: 'TV-PG', extraAttributes: { advisory: 'V' } }],
        starRating: [{ value: '8/10', extraAttributes: { votes: '1234' } }],
        review: [{ type: 'text', value: 'Good', extraAttributes: { stars: '4' } }],
        image: [{ value: 'https://x.tv/p.jpg', type: 'poster', extraAttributes: { dpi: '300' } }],
      };

      const xml = await collect(
        writeXmltvStream({
          meta: { generatorInfoName: 'g', extraAttributes: { 'provider-id': 'antik' } },
          channels: [{ id: 'one.example.tv', displayName: [{ value: 'One' }] }],
          programmes: [deep],
        }),
      );

      expect(xml).toContain('provider-id="antik"');
      expect(xml).toContain('<icon src="https://x.tv/i.png" shape="wide"/>');
      expect(xml).toContain('<video codec="h265">');

      for (const chunkSize of [7, xml.length]) {
        const events = await parseAll(xml, chunkSize);
        const meta = events.find((e) => e.type === 'meta')?.value;
        expect(meta).toEqual({
          generatorInfoName: 'g',
          extraAttributes: { 'provider-id': 'antik' },
        });
        expect(events.find((e) => e.type === 'programme')?.value).toEqual(deep);
        expect(events.filter((e) => e.type === 'warning')).toEqual([]);
      }
    });

    it('round-trips extensions through serialize and chunked parse', async () => {
      const xml = await collect(
        writeXmltvStream({
          channels: [extendedChannel],
          programmes: [extended],
        }),
      );

      for (const chunkSize of [5, xml.length]) {
        const events = await parseAll(xml, chunkSize);
        expect(events.find((e) => e.type === 'channel')?.value).toEqual(extendedChannel);
        expect(events.find((e) => e.type === 'programme')?.value).toEqual(extended);
      }
    });
  });

  it('parses attributes with single quotes and entities', async () => {
    const xml = `<tv><channel id='a&amp;b'><display-name lang='sk'>A &amp; B</display-name></channel></tv>`;
    const events = await parseAll(xml);
    const channel = events.find((e) => e.type === 'channel')?.value as XmltvChannel;
    expect(channel.id).toBe('a&b');
    expect(channel.displayName).toEqual([{ value: 'A & B', lang: 'sk' }]);
  });

  it('detects self-close after an unquoted attribute value (no space before />)', async () => {
    // Tolerated malformed input: unquoted value immediately followed by `/>`.
    // The `/` must close the tag, not be swallowed into the URL — otherwise
    // <icon> stays "open" and eats the rest of the document.
    const xml =
      '<tv><programme start="20260717200000 +0000" channel="c"><title>T</title>' +
      '<icon src=http://foo.com/a/b.jpg/></programme></tv>';

    for (const chunkSize of [1, 8, 16, xml.length]) {
      const events = await parseAll(xml, chunkSize);
      const programme = events.find((e) => e.type === 'programme')?.value as XmltvProgramme;
      const warnings = events.filter((e) => e.type === 'warning');

      // Slashes inside the unquoted URL are preserved; only the self-close
      // slash terminates the value.
      expect(programme.icon).toEqual([{ src: 'http://foo.com/a/b.jpg' }]);
      expect(warnings).toEqual([]);
    }
  });
});

describe('parseXmltvString', () => {
  it('collects meta/channels/programmes/warnings into one document', async () => {
    const xml = await collect(
      writeXmltvStream({
        meta: { generatorInfoName: 'epg-tools' },
        channels,
        programmes: [maximalProgramme],
      }),
    );

    const doc = parseXmltvString(xml);

    expect(doc.meta).toEqual({ generatorInfoName: 'epg-tools' });
    expect(doc.channels).toEqual(channels);
    expect(doc.programmes).toEqual([maximalProgramme]);
    expect(doc.warnings).toEqual([]);
  });

  it('surfaces warnings instead of silently dropping them', () => {
    const xml =
      '<tv><programme start="garbage" channel="c"><title>Bad</title></programme>' +
      '<programme start="20260717200000 +0000" channel="c"><title>Good</title></programme></tv>';

    const doc = parseXmltvString(xml);

    expect(doc.programmes).toHaveLength(1);
    expect(doc.programmes[0]!.title).toEqual([{ value: 'Good' }]);
    expect(doc.warnings).toHaveLength(1);
    expect(doc.warnings[0]!.code).toBe('invalid-programme');
  });

  it('defaults meta to an empty object for a document with no <tv> attributes', () => {
    const doc = parseXmltvString('<tv></tv>');

    expect(doc.meta).toEqual({});
    expect(doc.channels).toEqual([]);
    expect(doc.programmes).toEqual([]);
  });

  it('drops channels/programmes missing their required id by default', () => {
    const xml =
      '<tv><channel><display-name>Only</display-name></channel>' +
      '<programme start="20260717200000 +0000"><title>A</title></programme></tv>';

    const doc = parseXmltvString(xml);

    expect(doc.channels).toEqual([]);
    expect(doc.programmes).toEqual([]);
    expect(doc.warnings.map((w) => w.code)).toEqual(['invalid-element', 'invalid-programme']);
  });

  it('keeps them with empty id/channel when tolerateMissingId is set', () => {
    // A single-channel feed that omits the id/channel reference everywhere;
    // the merge layer can later attach everything to the one known channel.
    const xml =
      '<tv><channel><display-name>Only Channel</display-name></channel>' +
      '<programme start="20260717200000 +0000"><title>A</title></programme>' +
      '<programme start="20260717210000 +0000"><title>B</title></programme></tv>';

    const doc = parseXmltvString(xml, { tolerateMissingId: true });

    expect(doc.warnings).toEqual([]);
    expect(doc.channels).toEqual([{ id: '', displayName: [{ value: 'Only Channel' }] }]);
    expect(doc.programmes).toEqual([
      { channel: '', start: parseXmltvDate('20260717200000 +0000'), title: [{ value: 'A' }] },
      { channel: '', start: parseXmltvDate('20260717210000 +0000'), title: [{ value: 'B' }] },
    ]);
  });

  it('still drops a programme with no start even under tolerateMissingId', () => {
    // The option governs the id/channel key only — `start` stays required.
    const xml = '<tv><programme channel="c"><title>A</title></programme></tv>';

    const doc = parseXmltvString(xml, { tolerateMissingId: true });

    expect(doc.programmes).toEqual([]);
    expect(doc.warnings.map((w) => w.code)).toEqual(['invalid-programme']);
  });
});

describe('real-world fixture (epg-parser basic.xml)', () => {
  async function loadFixture(): Promise<string> {
    return readFile(join(import.meta.dirname, 'fixtures', 'epg-parser-basic.xml'), 'utf8');
  }

  it('parses a real multi-channel guide, whole and chunked, identically', async () => {
    const xml = await loadFixture();
    const whole = parseXmltvString(xml);

    // Also stream it in tiny chunks — the result must be identical.
    const streamed: XmltvParseEvent[] = await parseAll(xml, 13);
    const chunkedChannels = streamed.filter((e) => e.type === 'channel').map((e) => e.value);
    const chunkedProgrammes = streamed.filter((e) => e.type === 'programme').map((e) => e.value);

    expect(whole.warnings).toEqual([]);
    expect(streamed.filter((e) => e.type === 'warning')).toEqual([]);
    expect(chunkedChannels).toEqual(whole.channels);
    expect(chunkedProgrammes).toEqual(whole.programmes);

    // Multi-line root tag: attributes spanning newlines still parse.
    expect(whole.meta).toEqual({
      date: parseXmltvDate('20220401000000 +0000'),
      sourceInfoName: 'example',
      sourceInfoUrl: 'example.com',
      sourceDataUrl: 'example.com/a',
      generatorInfoName: 'Example Generator',
      generatorInfoUrl: 'https://example.com',
    });
  });

  it('parses the rich channel in full, plus a minimal display-name-only one', async () => {
    const { channels } = parseXmltvString(await loadFixture());

    expect(channels).toHaveLength(2);
    // The fully-populated channel (identical to the example in epg-parser's README).
    expect(channels[0]).toEqual({
      id: 'I10436.labs.zap2it.com',
      displayName: [
        { value: '13 KERA', lang: 'fr' },
        { value: '13', lang: 'ar' },
      ],
      icon: [{ src: 'https://example.com/channel_one_icon.jpg', width: 100, height: 100 }],
      url: [
        { value: 'https://example.com/channel_one', system: 'example' },
        { value: 'https://example.com/channel_one_alternate', system: 'other_system' },
      ],
      extra: [{ name: 'lcn', value: '36' }],
    });
    // A channel with nothing but a bare display-name.
    expect(channels[1]).toEqual({
      id: 'I10759.labs.zap2it.com',
      displayName: [{ value: '11 KTVT' }],
    });
  });

  it('parses every DTD field of the rich programme', async () => {
    const { programmes } = parseXmltvString(await loadFixture());

    // Exhaustive assertion over the fully-populated programme — this is the
    // same document epg-parser documents in its README, so it doubles as a
    // real-world compatibility check.
    expect(programmes[0]).toEqual({
      channel: 'I10436.labs.zap2it.com',
      start: parseXmltvDate('20080715003000 -0600'),
      stop: parseXmltvDate('20080715010000 -0600'),
      title: [{ value: 'NOW on PBS', lang: 'en' }],
      subTitle: [{ value: 'Pilot', lang: 'en' }],
      desc: [
        {
          value:
            "Jordan's Queen Rania has made job creation a priority to help curb the staggering unemployment rates among youths in the Middle East.",
          lang: 'en',
        },
      ],
      date: parseXmltvDate('20080711'),
      category: [
        { value: 'Newsmagazine', lang: 'en' },
        { value: 'Interview', lang: 'en' },
      ],
      keyword: [
        { value: 'physical-comedy', lang: 'en' },
        { value: 'romantic', lang: 'en' },
      ],
      language: { value: 'English' },
      origLanguage: { value: 'French', lang: 'en' },
      length: { units: 'minutes', value: 60 },
      url: [
        { value: 'https://example.com/programme_one', system: 'imdb' },
        'https://example.com/programme_one_2',
      ],
      country: [{ value: 'US' }],
      episodeNum: [
        { system: 'dd_progid', value: 'EP01006886.0028' },
        { system: 'onscreen', value: '427' },
      ],
      video: { present: true, colour: false, aspect: '16:9', quality: 'HDTV' },
      audio: { present: true, stereo: 'Dolby Digital' },
      previouslyShown: { start: parseXmltvDate('20080711000000'), channel: 'channel-two.tv' },
      premiere: { value: 'First time on British TV' },
      lastChance: { value: 'Last time on this channel', lang: 'en' },
      new: true,
      subtitles: [
        { type: 'teletext', language: { value: 'English' } },
        { type: 'onscreen', language: { value: 'Spanish', lang: 'en' } },
      ],
      rating: [
        { system: 'BBFC', value: '15' },
        { system: 'MPAA', value: 'NC-17', icon: [{ src: 'NC-17_symbol.png' }] },
      ],
      starRating: [
        { system: 'TV Guide', value: '4/5', icon: [{ src: 'stars.png' }] },
        { system: 'IMDB', value: '8/10' },
      ],
      review: [
        {
          type: 'text',
          source: 'Rotten Tomatoes',
          reviewer: 'Joe Bloggs',
          lang: 'en',
          value: 'This is a fantastic show!',
        },
        {
          type: 'text',
          source: 'IDMB',
          reviewer: 'Jane Doe',
          lang: 'en',
          value: 'I love this show!',
        },
        {
          type: 'url',
          source: 'Rotten Tomatoes',
          reviewer: 'Joe Bloggs',
          lang: 'en',
          value: 'https://example.com/programme_one_review',
        },
      ],
      image: [
        {
          type: 'poster',
          size: '1',
          orient: 'P',
          system: 'tvdb',
          value: 'https://tvdb.com/programme_one_poster_1.jpg',
        },
        {
          type: 'poster',
          size: '2',
          orient: 'P',
          system: 'tmdb',
          value: 'https://tmdb.com/programme_one_poster_2.jpg',
        },
        {
          type: 'backdrop',
          size: '3',
          orient: 'L',
          system: 'tvdb',
          value: 'https://tvdb.com/programme_one_backdrop_3.jpg',
        },
        {
          type: 'backdrop',
          size: '3',
          orient: 'L',
          system: 'tmdb',
          value: 'https://tmdb.com/programme_one_backdrop_3.jpg',
        },
      ],
      credits: {
        actor: [
          { value: '' },
          { value: 'David Thompson', role: 'Walter Johnson' },
          {
            value: 'Ryan Lee',
            role: 'Karl James',
            guest: true,
            image: [{ type: 'person', value: 'https://example.com/xxx.jpg' }],
            url: [{ value: 'https://example.com/person/204', system: 'moviedb' }],
          },
        ],
        director: ['Bart Eskander'],
        producer: ['Roger Dobkowitz'],
        presenter: ['Drew Carey'],
      },
      icon: [
        {
          src: 'http://imageswoapi.whatsonindia.com/WhatsOnTV/images/ProgramImages/xlarge/38B4DE4E9A7132257749051B6C8B4F699DB264F4V.jpg',
          width: 100,
          height: 100,
        },
      ],
    });
  });

  it('keeps a valid-timeslot programme that has no <title> (title+ is not enforced)', async () => {
    const { programmes } = parseXmltvString(await loadFixture());

    expect(programmes).toHaveLength(2);

    // The empty <programme></programme>: start/stop/channel are enough to keep
    // it, with an empty title array. (DTD requires title+, but a bare timeslot
    // is still useful, so it is kept rather than dropped or warned about.)
    expect(programmes[1]).toEqual({
      channel: 'I10759.labs.zap2it.com',
      start: parseXmltvDate('20080715010000 -0600'),
      stop: parseXmltvDate('20080715023000 -0600'),
      title: [],
    });
  });
});

describe('degenerate and empty inputs', () => {
  it.each([
    ['empty string', ''],
    ['whitespace only', '   \n\t  '],
    ['xml declaration only', '<?xml version="1.0" encoding="UTF-8"?>'],
    ['comment only', '<!-- nothing here -->'],
    ['doctype only', '<!DOCTYPE tv SYSTEM "xmltv.dtd">'],
    ['empty root', '<tv></tv>'],
    ['self-closing root', '<tv/>'],
  ])('yields an empty document without warnings or throwing: %s', (_label, xml) => {
    const doc = parseXmltvString(xml);

    expect(doc).toEqual({ meta: {}, channels: [], programmes: [], warnings: [] });
  });

  it('throws only when the root <tv> is the wrong element, not when it is merely absent', async () => {
    // Absent root (only preamble) → empty, no throw.
    expect(parseXmltvString('<?xml version="1.0"?><!-- x -->').programmes).toEqual([]);

    // Present but wrong → throws.
    await expect(async () => {
      for await (const _e of parseXmltvStream(['<guide></guide>'])) {
        /* drain */
      }
    }).rejects.toThrow(/expected root element <tv>/);
  });
});

describe('node stream transforms', () => {
  it('XmltvParseStream parses a byte stream into events, bytes split anywhere', async () => {
    const xml = await readFile(join(import.meta.dirname, 'fixtures', 'epg-parser-basic.xml'));
    // Tiny 5-byte Buffer chunks exercise chunk-boundary handling through the pipe.
    const chunks: Buffer[] = [];
    for (let i = 0; i < xml.length; i += 5) {
      chunks.push(xml.subarray(i, i + 5));
    }

    const events: XmltvParseEvent[] = [];
    const parse = new XmltvParseStream();
    Readable.from(chunks).pipe(parse);
    for await (const event of parse) {
      events.push(event);
    }

    const expected = parseXmltvString(xml.toString('utf8'));
    // Object-mode readable emits meta/channel/programme (and warning) as data.
    expect(events.filter((e) => e.type === 'channel').map((e) => e.value)).toEqual(
      expected.channels,
    );
    expect(events.filter((e) => e.type === 'programme').map((e) => e.value)).toEqual(
      expected.programmes,
    );
    expect(events.filter((e) => e.type === 'warning')).toEqual([]);
  });

  it('XmltvParseStream surfaces a scanner throw as a stream error', async () => {
    const parse = new XmltvParseStream();
    Readable.from(['<guide></guide>']).pipe(parse);

    await expect(async () => {
      for await (const _event of parse) {
        // drain
      }
    }).rejects.toThrow(/expected root element <tv>/);
  });

  it('XmltvSerializeStream serializes a tagged {type,value} event stream and round-trips', async () => {
    const meta = { generatorInfoName: 'epg-tools' };
    const items: XmltvParseEvent[] = [
      { type: 'meta', value: meta },
      ...channels.map((value): XmltvParseEvent => ({ type: 'channel', value })),
      { type: 'programme', value: maximalProgramme },
    ];

    const serialize = new XmltvSerializeStream();
    Readable.from(items).pipe(serialize);
    let xml = '';
    for await (const chunk of serialize) {
      xml += chunk;
    }

    expect(xml).not.toContain('\n'); // compact by default
    const doc = parseXmltvString(xml);
    expect(doc.meta).toEqual(meta); // meta event set the root attributes
    expect(doc.channels).toEqual(channels);
    expect(doc.programmes).toEqual([maximalProgramme]);
    expect(doc.warnings).toEqual([]);
  });

  it('batches streaming output by highWaterMark', async () => {
    const input = { channels, programmes: [maximalProgramme] };

    // writeXmltvStream yields discrete chunks: a huge highWaterMark accumulates
    // everything into one, a tiny one yields per element.
    const bigChunks: string[] = [];
    for await (const chunk of writeXmltvStream(input, { highWaterMark: 10_000_000 })) {
      bigChunks.push(chunk);
    }

    const smallChunks: string[] = [];
    for await (const chunk of writeXmltvStream(input, { highWaterMark: 1 })) {
      smallChunks.push(chunk);
    }

    expect(bigChunks).toHaveLength(1);
    expect(smallChunks.length).toBeGreaterThan(1);
    expect(smallChunks.join('')).toBe(bigChunks.join('')); // same bytes either way

    // For the Transform, the batch size IS its readable buffer size.
    expect(new XmltvSerializeStream({ highWaterMark: 4096 }).readableHighWaterMark).toBe(4096);
  });

  it('merges a meta event with constructor meta, constructor winning per field', async () => {
    const serialize = new XmltvSerializeStream({ meta: { generatorInfoName: 'override' } });
    Readable.from([
      { type: 'meta', value: { generatorInfoName: 'from-event', sourceInfoName: 'The Source' } },
      { type: 'channel', value: channels[0]! },
    ]).pipe(serialize);

    const xml = await collect(serialize);

    // Event supplies sourceInfoName; constructor overrides generatorInfoName.
    expect(parseXmltvString(xml).meta).toEqual({
      generatorInfoName: 'override',
      sourceInfoName: 'The Source',
    });
  });

  it('errors on a meta event that arrives after the header is written', async () => {
    const serialize = new XmltvSerializeStream();
    Readable.from([
      { type: 'channel', value: channels[0]! }, // header written here
      { type: 'meta', value: { generatorInfoName: 'too-late' } },
    ]).pipe(serialize);

    await expect(collect(serialize)).rejects.toThrow(/meta event must precede/);
  });

  it('errors on an unrecognized event type rather than stalling', async () => {
    const serialize = new XmltvSerializeStream();
    Readable.from([{ type: 'nonsense', value: {} }]).pipe(serialize);

    await expect(collect(serialize)).rejects.toThrow(/unexpected event type "nonsense"/);
  });

  it('XmltvSerializeStream re-emits a warning event (typed) instead of writing it to the output', async () => {
    const warning: XmltvWarning = {
      code: 'invalid-programme',
      message: 'dropped',
      line: 3,
      col: 5,
    };
    // The listener parameter is typed as XmltvWarning, so `.code` is checked at compile time.
    const seen: XmltvWarning[] = [];

    const serialize = new XmltvSerializeStream();
    serialize.on('warning', (w) => seen.push(w));
    Readable.from([
      { type: 'warning', value: warning },
      { type: 'channel', value: channels[0]! },
    ]).pipe(serialize);

    let xml = '';
    for await (const chunk of serialize) {
      xml += chunk;
    }

    expect(seen).toEqual([warning]);
    expect(seen[0]!.code).toBe('invalid-programme');
    expect(xml).not.toContain('invalid-programme'); // warning stayed out of the XML
    expect(parseXmltvString(xml).channels).toEqual([channels[0]]);
  });

  it('round-trips a document through a parse -> serialize Node pipeline', async () => {
    const source = await readFile(join(import.meta.dirname, 'fixtures', 'epg-parser-basic.xml'));

    let xml = '';
    await pipeline(
      Readable.from([source]),
      new XmltvParseStream(),
      new XmltvSerializeStream(),
      async (chunks: AsyncIterable<string>) => {
        for await (const chunk of chunks) {
          xml += chunk;
        }
      },
    );

    // Re-serialized output parses back to the same channels and programmes.
    const original = parseXmltvString(source.toString('utf8'));
    const roundTripped = parseXmltvString(xml);
    expect(roundTripped.channels).toEqual(original.channels);
    expect(roundTripped.programmes).toEqual(original.programmes);
  });
});

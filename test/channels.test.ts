import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderChannelReport, reportChannels } from '../src/cli/channels.js';
import { guideChannels, readChannelList } from '../src/cli/lists.js';
import { matchChannels, timeshiftName, timeshiftOf } from '../src/channels/match.js';
import { channelsFromChannelsXml } from '../src/grabber/channels.js';
import { parseChannelsXml } from '../src/channels/parse.js';
import { derivedChannelList } from '../src/merge/derive.js';
import { serializeChannelsXml } from '../src/channels/serialize.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/tvtv-us-slice.channels.xml', import.meta.url));

/** A candidate, written the way a test wants to read one. */
const of = (id: string, name: string) => ({ id, name, value: name });

describe('parseChannelsXml', () => {
  it('reads the four attributes both formats share, and the name', async () => {
    const list = parseChannelsXml(await readFile(FIXTURE, 'utf8'));

    expect(list.entries[4]).toEqual({
      site: 'tvtv.us',
      siteId: '2121',
      lang: 'en',
      xmltvId: 'EuronewsEnglish.fr@SD',
      name: 'Euronews English',
    });
  });

  // iptv-org and WebGrab+Plus write the same document; WGB+ adds `update`,
  // which is its business and not ours, so it round-trips rather than vanishing.
  it('keeps WebGrab+Plus`s update attribute', () => {
    const list = parseChannelsXml(
      '<channels><channel update="i" site="tvprograma.lt" site_id="tv3/42" xmltv_id="TV3">TV3</channel></channels>',
    );

    expect(list.entries[0]).toEqual({
      site: 'tvprograma.lt',
      siteId: 'tv3/42',
      xmltvId: 'TV3',
      name: 'TV3',
      update: 'i',
    });
  });

  it('decodes entities in a name', async () => {
    const list = parseChannelsXml(await readFile(FIXTURE, 'utf8'));

    expect(list.entries[1]?.name).toBe('A&E East');
  });

  // The state these files are actually in: tvtv.us's own list carries 69 of its
  // 2,299 channels unmapped. Not an error — the thing the matching is for.
  it('reports an unmapped channel rather than dropping it', async () => {
    const list = parseChannelsXml(await readFile(FIXTURE, 'utf8'));

    expect(list.warnings).toEqual([
      {
        code: 'unmapped-channel',
        message:
          '"Bally Sports Southeast Georgia" has no xmltv_id, so nothing in a guide can match it',
        line: 3,
      },
    ]);
    expect(list.entries[0]?.xmltvId).toBe('');
  });

  it('reports a channel with no site_id, and a repeated one', () => {
    const list = parseChannelsXml(
      '<channels>' +
        '<channel site="a" site_id="" xmltv_id="x">No Id</channel>' +
        '<channel site="a" site_id="1" xmltv_id="y">One</channel>' +
        '<channel site="a" site_id="1" xmltv_id="z">Again</channel>' +
        '</channels>',
    );

    expect(list.warnings.map((w) => w.code)).toEqual(['missing-site-id', 'duplicate-site-id']);
    // All three are kept: a duplicate is worth saying, not worth losing.
    expect(list.entries).toHaveLength(3);
  });

  // Keyed by a nested map rather than a joined string: a `site_id` may hold
  // very nearly anything — WebGrab+Plus writes them like `tv3/42` — so any
  // separator is one a real id could contain.
  it('does not confuse two channels whose site and site_id merely join the same', () => {
    const list = parseChannelsXml(
      '<channels>' +
        '<channel site="a b" site_id="c" xmltv_id="x">One</channel>' +
        '<channel site="a" site_id="b c" xmltv_id="y">Two</channel>' +
        '</channels>',
    );

    expect(list.warnings).toEqual([]);
  });

  it('sees a duplicate whether the site is inherited or named', () => {
    const list = parseChannelsXml(
      '<channels site="a">' +
        '<channel site_id="1" xmltv_id="x">Inherited</channel>' +
        '<channel site="a" site_id="1" xmltv_id="y">Named</channel>' +
        '</channels>',
    );

    expect(list.warnings.map((w) => w.code)).toEqual(['duplicate-site-id']);
  });

  it('says so when handed something that is not a channel list', () => {
    expect(parseChannelsXml('<?xml version="1.0"?><tv><channel id="a"/></tv>').warnings).toEqual([
      {
        code: 'unexpected-document',
        message: 'no <channels> element: this does not look like a channel list',
        line: 1,
      },
    ]);
  });

  it('reads a self-closing channel, which has no name', () => {
    const list = parseChannelsXml('<channels><channel site_id="1" xmltv_id="a.uk" /></channels>');

    expect(list.entries[0]).toMatchObject({ siteId: '1', xmltvId: 'a.uk', name: '' });
  });
});
// The shorthand for a file describing one source: named once on the root,
// inherited by every channel in it.
it('inherits a site given once on the root', () => {
  const list = parseChannelsXml(
    '<?xml version="1.0" ?>\n<channels site="example.com">\n' +
      '  <channel site_id="cnn-23" xmltv_id="CNN.us">CNN</channel>\n' +
      '  <channel site="other.com" site_id="x" xmltv_id="X.us">X</channel>\n' +
      '</channels>\n',
  );

  expect(list.site).toBe('example.com');
  expect(list.entries[0]?.site).toBe('example.com');
  // A list may name one source and still carry a channel from another.
  expect(list.entries[1]?.site).toBe('other.com');
});

it('reads the per-channel logo, url and lcn', () => {
  const list = parseChannelsXml(
    '<channels>\n<channel\n  site="example.com"\n  site_id="france-24"\n' +
      '  xmltv_id="France24.fr"\n  lang="fr"\n  logo="https://example.com/f24.png"\n' +
      '  url="https://example.com/"\n  lcn="36"\n>France 24</channel>\n</channels>',
  );

  expect(list.entries[0]).toEqual({
    site: 'example.com',
    siteId: 'france-24',
    xmltvId: 'France24.fr',
    lang: 'fr',
    logo: 'https://example.com/f24.png',
    url: 'https://example.com/',
    lcn: '36',
    name: 'France 24',
  });
});

describe('serializeChannelsXml', () => {
  it('round-trips a real file byte for byte', async () => {
    const text = await readFile(FIXTURE, 'utf8');
    const list = parseChannelsXml(text);

    expect(serializeChannelsXml(list)).toBe(text);
  });

  it('puts a root site back on the root rather than on every line', () => {
    const source =
      '<?xml version="1.0" encoding="UTF-8"?>\n<channels site="example.com">\n' +
      '  <channel site_id="cnn-23" xmltv_id="CNN.us">CNN</channel>\n' +
      '  <channel site="other.com" site_id="x" xmltv_id="X.us">X</channel>\n' +
      '</channels>\n';
    const list = parseChannelsXml(source);

    expect(serializeChannelsXml(list)).toBe(source);
  });

  it('keeps an unmapped channel unmapped, attribute and all', () => {
    const out = serializeChannelsXml([{ siteId: '1', xmltvId: '', name: 'Unmapped' }]);

    expect(out).toContain('<channel site_id="1" xmltv_id="">Unmapped</channel>');
  });

  it('escapes what has to be escaped', () => {
    const out = serializeChannelsXml([{ siteId: 'a&b', xmltvId: 'x', name: 'A&E <East>' }]);

    expect(out).toContain('site_id="a&amp;b"');
    expect(out).toContain('>A&amp;E &lt;East&gt;</channel>');
    expect(parseChannelsXml(out).entries[0]?.name).toBe('A&E <East>');
  });
});

describe('matchChannels', () => {
  const available = [
    of('bbcone.uk', 'BBC One'),
    of('bbctwo.uk', 'BBC Two'),
    of('euronews.fr', 'Euronews Français'),
    of('skyone.uk', 'Sky One'),
    of('ae.us', 'A&E'),
  ];

  it('matches an id exactly, whatever the name says', () => {
    const [match] = matchChannels(
      [{ id: 'bbcone.uk', name: 'Something Else', value: 1 }],
      available,
    );

    expect(match).toEqual({ source: 1, matched: 'BBC One', kind: 'id', confidence: 1 });
  });

  it.each([
    ['a picture-quality marker', 'BBC One HD', 'BBC One'],
    ['case and punctuation', 'bbc  two!', 'BBC Two'],
    ['diacritics', 'Euronews Francais', 'Euronews Français'],
    ['an ampersand', 'A&E', 'A&E'],
  ])('matches on %s', (_label, wanted, expected) => {
    const [match] = matchChannels([{ name: wanted, value: wanted }], available);

    expect(match?.matched).toBe(expected);
    expect(match?.kind).toBe('name');
  });

  // The one the backlog got wrong, and the reason to be careful: `+1` is a
  // *different channel*, so folding it into its base would assign a schedule an
  // hour out — confidently, and invisibly.
  it('never matches a timeshifted channel to the one it shifts', () => {
    const [match] = matchChannels([{ name: 'Sky One +1', value: 'want' }], available);

    expect(match?.matched).toBeUndefined();
    expect(match?.kind).toBe('none');
    // But it says what it looks like, which is a derived channel.
    expect(match?.timeshiftOf).toEqual({ channel: 'Sky One', offset: 60 });
  });

  it.each([
    ['Sky One +1', 60],
    ['Sky One +24', 1440],
    ['Sky One -1', -60],
    ['Sky One +1h', 60],
  ])('reads the offset in %s', (name, offset) => {
    expect(timeshiftOf(name)?.offset).toBe(offset);
  });

  it('leaves a name with no offset alone', () => {
    expect(timeshiftOf('Channel 4')).toBeUndefined();
    expect(timeshiftOf('BBC One')).toBeUndefined();
  });

  it.each([
    [60, 'Sky One +1'],
    [-60, 'Sky One -1'],
    [1380, 'Sky One +23'],
  ])('writes %i minutes as the name a playlist uses', (offset, expected) => {
    expect(timeshiftName('Sky One', offset)).toBe(expected);
  });

  // The two are each other's opposite, and this is what says so: whatever a
  // derived channel is named, the recognizer reads the same offset back out —
  // which is why declaring one makes it match by name.
  it.each([60, -60, 120, 1380])('round-trips %i minutes through timeshiftOf', (offset) => {
    const name = timeshiftName('Sky One', offset);

    expect(name).toBeDefined();
    expect(timeshiftOf(name!)).toEqual({ offset, base: 'Sky One' });
  });

  it('declines an offset it cannot spell, rather than inventing one', () => {
    // 90 minutes has no form `TIMESHIFT` would read back, and `Sky One +1.5`
    // would read back as `+1` — an hour out, said confidently.
    expect(timeshiftName('Sky One', 90)).toBeUndefined();
    expect(timeshiftName('Sky One', 0)).toBeUndefined();
    expect(timeshiftName('Sky One', 30.5)).toBeUndefined();
    expect(timeshiftName('  ', 60)).toBeUndefined();
  });

  it('reports rivals rather than picking one', () => {
    const rivals = [of('a', 'Movies'), of('b', 'MOVIES!')];
    const [match] = matchChannels([{ name: 'movies', value: 'want' }], rivals);

    expect(match?.matched).toBeUndefined();
    expect(match?.ambiguous).toEqual(['Movies', 'MOVIES!']);
  });

  it('says nothing matched when nothing does', () => {
    const [match] = matchChannels([{ id: 'nope', name: 'Nothing Here', value: 'want' }], available);

    expect(match).toEqual({ source: 'want', kind: 'none', confidence: 0 });
  });

  it('ignores an empty id rather than matching other empties on it', () => {
    const [match] = matchChannels(
      [{ id: '', name: 'BBC One', value: 'want' }],
      [{ id: '', name: 'Unmapped', value: 'other' }, ...available],
    );

    expect(match?.matched).toBe('BBC One');
  });
});

describe('readChannelList', () => {
  /** The file on disk that the reader needs, since it streams rather than takes text. */
  async function file(name: string, body: string | Uint8Array): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'epg-lists-'));
    const path = join(dir, name);

    await writeFile(path, body);

    return path;
  }

  const GUIDE =
    '<?xml version="1.0"?><tv><channel id="a.uk"><display-name>A</display-name></channel>' +
    '<programme start="20260101000000 +0000" channel="a.uk"><title>T</title></programme></tv>';

  it('reads an M3U playlist, preferring tvg-name over the display name', async () => {
    const list = await readChannelList(
      await file(
        'x.m3u',
        '#EXTM3U\n#EXTINF:-1 tvg-id="a.uk" tvg-name="Proper Name",Display\nhttp://e/1\n',
      ),
    );

    expect(list.channels).toEqual([{ id: 'a.uk', name: 'Proper Name' }]);
  });

  it('reads a channels.xml', async () => {
    const list = await readChannelList(
      await file('x.xml', '<channels><channel site_id="1" xmltv_id="a.uk">A</channel></channels>'),
    );

    expect(list.channels).toEqual([{ id: 'a.uk', name: 'A' }]);
  });

  it('reads a plain list of ids, which no marker announces', async () => {
    const list = await readChannelList(await file('ids.txt', '# mine\na.uk\nb.uk, c.uk\n'));

    expect(list.channels.map((channel) => channel.id)).toEqual(['a.uk', 'b.uk', 'c.uk']);
    // Nowhere to put an answer, so nothing is ever written into one.
    expect(list.map(list.channels[0]!, 'other.uk')).toBe(false);
  });

  // The format that is routinely 90 MiB: its channels come out of a stream, and
  // its programmes are never built.
  it('reads a guide by streaming it', async () => {
    expect((await readChannelList(await file('guide.xml', GUIDE))).channels).toEqual([
      { id: 'a.uk', name: 'A' },
    ]);

    // The same thing over text in hand, which is all `guideChannels` is.
    expect(await guideChannels([GUIDE])).toEqual([{ id: 'a.uk', name: 'A' }]);
  });

  it('decompresses on the way in', async () => {
    const list = await readChannelList(await file('guide.xml.gz', gzipSync(GUIDE)));

    expect(list.channels).toEqual([{ id: 'a.uk', name: 'A' }]);
  });

  // All four get renamed, and `.xml` alone does not say which of two it is.
  it('sniffs the kind rather than trusting the name', async () => {
    await expect(readChannelList(await file('mystery.dat', 'just some <text'))).rejects.toThrow(
      /Cannot tell what/,
    );
  });

  it('refuses to overwrite an id that is already there', async () => {
    const list = await readChannelList(
      await file(
        'x.xml',
        '<channels><channel site_id="1" xmltv_id="mine.uk">A</channel></channels>',
      ),
    );

    expect(list.map(list.channels[0]!, 'other.uk')).toBe(false);
  });
});

describe('reportChannels', () => {
  const available = [
    { xmltvId: 'bbcone.uk', siteId: '1', name: 'BBC One' },
    { xmltvId: 'skyone.uk', siteId: '2', name: 'Sky One' },
  ];

  it('is ok only when every channel matched by id', () => {
    const matched = reportChannels([{ id: 'bbcone.uk', name: 'BBC One' }], available);

    expect(matched.ok).toBe(true);
    expect(matched.counts).toEqual({ wanted: 1, byId: 1, byName: 0, unmatched: 0 });
  });

  // A name match is a suggestion nobody has written down yet, so the channel
  // still shows an empty grid tomorrow — which is what `--check` is for.
  it('is not ok on a name match alone', () => {
    const report = reportChannels([{ id: '', name: 'BBC One HD' }], available);

    expect(report.ok).toBe(false);
    expect(report.rows[0]).toMatchObject({ kind: 'name', matched: { xmltvId: 'bbcone.uk' } });
  });

  it('calls a timeshift what it is', () => {
    const report = reportChannels([{ id: '', name: 'Sky One +1' }], available);

    expect(report.rows[0]?.timeshiftOf).toEqual({ xmltvId: 'skyone.uk', offset: 60 });
    expect(report.rows[0]?.matched).toBeUndefined();
  });
});

describe('derivedChannelList', () => {
  const named = new Map<string, string | undefined>([
    ['skyone.uk', 'Sky One'],
    ['bbcone.uk', 'BBC One'],
  ]);

  it('names a shift the way a playlist does', () => {
    expect(
      derivedChannelList([{ xmltvId: 'skyone.plus1.uk', from: 'skyone.uk', offset: 60 }], named),
    ).toEqual([{ xmltvId: 'skyone.plus1.uk', name: 'Sky One +1' }]);
  });

  it('names a chain from its root, not from what it happens to shift', () => {
    const list = derivedChannelList(
      [
        { xmltvId: 'skyone.plus1.uk', from: 'skyone.uk', offset: 60 },
        { xmltvId: 'skyone.plus2.uk', from: 'skyone.plus1.uk', offset: 60 },
      ],
      named,
    );

    expect(list).toEqual([
      { xmltvId: 'skyone.plus1.uk', name: 'Sky One +1' },
      { xmltvId: 'skyone.plus2.uk', name: 'Sky One +2' },
    ]);
  });

  it('leaves out one whose source nothing produces', () => {
    expect(derivedChannelList([{ xmltvId: 'a.plus1', from: 'nope', offset: 60 }], named)).toEqual(
      [],
    );
  });

  // The whole reason the report has to know about these: the report is what
  // sends you to declare one, so it must stop asking once you have.
  it('is what turns a timeshift hint into a match', () => {
    const available = [{ xmltvId: 'skyone.uk', siteId: '2', name: 'Sky One' }];
    const wanted = [{ id: '', name: 'Sky One +1' }];

    expect(reportChannels(wanted, available).rows[0]?.timeshiftOf).toEqual({
      xmltvId: 'skyone.uk',
      offset: 60,
    });

    const derived = derivedChannelList(
      [{ xmltvId: 'skyone.plus1.uk', from: 'skyone.uk', offset: 60 }],
      new Map([['skyone.uk', 'Sky One']]),
    ).map((channel) => ({ ...channel, siteId: '' }));
    const after = reportChannels(wanted, [...available, ...derived]);

    expect(after.rows[0]).toMatchObject({
      kind: 'name',
      matched: { xmltvId: 'skyone.plus1.uk' },
    });
    expect(after.rows[0]?.timeshiftOf).toBeUndefined();
  });
});

describe('renderChannelReport', () => {
  const available = [{ xmltvId: 'bbcone.uk', siteId: '1', name: 'BBC One' }];

  it('says nothing about the channels that are fine', () => {
    const text = renderChannelReport(reportChannels([{ id: 'bbcone.uk', name: 'x' }], available));

    expect(text).toContain('Every channel has a guide behind it.');
    expect(text).not.toContain('bbcone.uk —');
  });

  it('names the near miss and what to do about it', () => {
    const text = renderChannelReport(reportChannels([{ id: '', name: 'BBC One HD' }], available));

    expect(text).toContain('looks like bbcone.uk (BBC One) — set its id to confirm');
    expect(text).toContain('1 wanted, 0 matched by id, 1 by name');
  });

  it('says plainly when nothing produces a channel', () => {
    const text = renderChannelReport(reportChannels([{ id: 'no.uk', name: 'Nope' }], available));

    expect(text).toContain('✗ Nope (no.uk)');
    expect(text).toContain('nothing produces this');
  });
});

describe('channelsFromChannelsXml', () => {
  const entries = parseChannelsXml(
    '<channels site="example.com">' +
      '<channel site_id="1" xmltv_id="a.uk" lang="en" logo="http://e/a.png" lcn="101" url="http://e/a">A</channel>' +
      '<channel site_id="2" xmltv_id="">Unmapped</channel>' +
      '<channel site="other.com" site_id="3" xmltv_id="c.uk">C</channel>' +
      '<channel site_id="1" xmltv_id="d.uk">Repeat</channel>' +
      '</channels>',
  ).entries;

  // The tidier of the two mappings: a playlist has one `tvg-id` doing both
  // jobs, while this format keeps the ids a grab needs apart.
  it('maps site_id and xmltv_id to the two ids a grab uses', async () => {
    const [channel] = await channelsFromChannelsXml(entries)();

    expect(channel).toEqual({
      siteId: '1',
      xmltvId: 'a.uk',
      name: 'A',
      lang: 'en',
      logo: 'http://e/a.png',
      preset: '101',
      // The two things a `GrabberChannel` has no field for.
      data: { site: 'example.com', url: 'http://e/a' },
    });
  });

  it('carries only what a GrabberChannel has no field for', async () => {
    const [plain] = await channelsFromChannelsXml(
      parseChannelsXml('<channels><channel site_id="1" xmltv_id="a.uk">A</channel></channels>')
        .entries,
    )();

    // Neither a site nor a url, so no `data` at all rather than an empty object.
    expect(plain).not.toHaveProperty('data');
    expect(plain).toEqual({ siteId: '1', xmltvId: 'a.uk', name: 'A' });
  });

  it('skips what cannot become a channel, and says why', async () => {
    const skipped: string[] = [];
    const channels = await channelsFromChannelsXml(entries, {
      site: 'example.com',
      onSkipped: (entry, reason) => skipped.push(`${entry.name}:${reason}`),
    })();

    expect(channels.map((c) => c.xmltvId)).toEqual(['a.uk']);
    expect(skipped).toEqual(['Unmapped:unmapped', 'C:other-site', 'Repeat:duplicate-site-id']);
  });

  // Kept for the reason the reader keeps it: a list built from a WebGrab+Plus
  // file and written back would otherwise reset everyone's refresh policy.
  it('carries WebGrab+Plus`s update through', async () => {
    const [channel] = await channelsFromChannelsXml(
      parseChannelsXml(
        '<channels><channel update="i" site="wgb.example" site_id="1" xmltv_id="a.uk">A</channel></channels>',
      ).entries,
    )();

    expect(channel?.data).toEqual({ site: 'wgb.example', update: 'i' });
  });

  it('keeps the first of a repeated site_id', async () => {
    const skipped: string[] = [];

    await channelsFromChannelsXml(entries, {
      onSkipped: (entry, reason) => skipped.push(`${entry.name}:${reason}`),
    })();

    expect(skipped).toContain('Repeat:duplicate-site-id');
  });
});

describe('channelsFromChannelsXml, from a path', () => {
  it('reads the file when the list is resolved, not when the config loads', async () => {
    const channels = await channelsFromChannelsXml(FIXTURE)();

    // The fixture's unmapped channel cannot become one; the other four can.
    expect(channels).toHaveLength(4);
    expect(channels[0]).toMatchObject({ siteId: '10035', xmltvId: 'AE.us@East', name: 'A&E East' });
  });

  it('reports what the file has to say through the site`s own warn', async () => {
    const said: string[] = [];

    await channelsFromChannelsXml(FIXTURE)({
      http: undefined as never,
      log: () => {},
      warn: (message) => said.push(message),
    });

    expect(said).toHaveLength(1);
    expect(said[0]).toContain('has no xmltv_id');
  });

  // A document where a path belongs would otherwise fail as a filename several
  // kilobytes long, which says nothing about the mistake.
  it('says so when handed a document instead of a path', async () => {
    await expect(channelsFromChannelsXml('<channels></channels>')()).rejects.toThrow(
      /takes a path or entries, not a document/,
    );
  });
});

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { matchChannels, timeshiftOf } from '../src/channels/match.js';
import { parseChannelList } from '../src/channels/parse.js';
import { serializeChannelList } from '../src/channels/serialize.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/tvtv-us-slice.channels.xml', import.meta.url));

/** A candidate, written the way a test wants to read one. */
const of = (id: string, name: string) => ({ id, name, value: name });

describe('parseChannelList', () => {
  it('reads the four attributes both formats share, and the name', async () => {
    const list = parseChannelList(await readFile(FIXTURE, 'utf8'));

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
    const list = parseChannelList(
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
    const list = parseChannelList(await readFile(FIXTURE, 'utf8'));

    expect(list.entries[1]?.name).toBe('A&E East');
  });

  // The state these files are actually in: tvtv.us's own list carries 69 of its
  // 2,299 channels unmapped. Not an error — the thing the matching is for.
  it('reports an unmapped channel rather than dropping it', async () => {
    const list = parseChannelList(await readFile(FIXTURE, 'utf8'));

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
    const list = parseChannelList(
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
    const list = parseChannelList(
      '<channels>' +
        '<channel site="a b" site_id="c" xmltv_id="x">One</channel>' +
        '<channel site="a" site_id="b c" xmltv_id="y">Two</channel>' +
        '</channels>',
    );

    expect(list.warnings).toEqual([]);
  });

  it('sees a duplicate whether the site is inherited or named', () => {
    const list = parseChannelList(
      '<channels site="a">' +
        '<channel site_id="1" xmltv_id="x">Inherited</channel>' +
        '<channel site="a" site_id="1" xmltv_id="y">Named</channel>' +
        '</channels>',
    );

    expect(list.warnings.map((w) => w.code)).toEqual(['duplicate-site-id']);
  });

  it('says so when handed something that is not a channel list', () => {
    expect(parseChannelList('<?xml version="1.0"?><tv><channel id="a"/></tv>').warnings).toEqual([
      {
        code: 'unexpected-document',
        message: 'no <channels> element: this does not look like a channel list',
        line: 1,
      },
    ]);
  });

  it('reads a self-closing channel, which has no name', () => {
    const list = parseChannelList('<channels><channel site_id="1" xmltv_id="a.uk" /></channels>');

    expect(list.entries[0]).toMatchObject({ siteId: '1', xmltvId: 'a.uk', name: '' });
  });
});
// The shorthand for a file describing one source: named once on the root,
// inherited by every channel in it.
it('inherits a site given once on the root', () => {
  const list = parseChannelList(
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
  const list = parseChannelList(
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

describe('serializeChannelList', () => {
  it('round-trips a real file byte for byte', async () => {
    const text = await readFile(FIXTURE, 'utf8');
    const list = parseChannelList(text);

    expect(serializeChannelList(list)).toBe(text);
  });

  it('puts a root site back on the root rather than on every line', () => {
    const source =
      '<?xml version="1.0" encoding="UTF-8"?>\n<channels site="example.com">\n' +
      '  <channel site_id="cnn-23" xmltv_id="CNN.us">CNN</channel>\n' +
      '  <channel site="other.com" site_id="x" xmltv_id="X.us">X</channel>\n' +
      '</channels>\n';
    const list = parseChannelList(source);

    expect(serializeChannelList(list)).toBe(source);
  });

  it('keeps an unmapped channel unmapped, attribute and all', () => {
    const out = serializeChannelList([{ siteId: '1', xmltvId: '', name: 'Unmapped' }]);

    expect(out).toContain('<channel site_id="1" xmltv_id="">Unmapped</channel>');
  });

  it('escapes what has to be escaped', () => {
    const out = serializeChannelList([{ siteId: 'a&b', xmltvId: 'x', name: 'A&E <East>' }]);

    expect(out).toContain('site_id="a&amp;b"');
    expect(out).toContain('>A&amp;E &lt;East&gt;</channel>');
    expect(parseChannelList(out).entries[0]?.name).toBe('A&E <East>');
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

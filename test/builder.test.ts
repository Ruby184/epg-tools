import { describe, expect, it } from 'vitest';
import {
  ChannelBuilder,
  getXmltvOffset,
  getXmltvPrecision,
  ProgrammeBuilder,
  XmltvDocumentBuilder,
  parseXmltvDate,
  parseXmltvString,
  serializeChannel,
  serializeProgramme,
  writeXmltvStream,
} from '../src/xmltv/main.js';

async function collect(input: Parameters<typeof writeXmltvStream>[0]): Promise<string> {
  let out = '';
  for await (const chunk of writeXmltvStream(input)) out += chunk;
  return out;
}

describe('ProgrammeBuilder', () => {
  it('builds a minimal programme from required fields', () => {
    const programme = new ProgrammeBuilder({
      channel: 'one.tv',
      start: '20260717200000 +0000',
      title: 'News',
    }).build();

    expect(programme).toEqual({
      channel: 'one.tv',
      start: parseXmltvDate('20260717200000 +0000'),
      title: [{ value: 'News' }],
    });
  });

  it('exposes a positional `of` factory equivalent to the base-object constructor', () => {
    const start = '20260717200000 +0000';

    expect(
      ProgrammeBuilder.of('one.tv', start, 'News', {
        stop: '20260717210000 +0000',
        lang: 'en',
      }).build(),
    ).toEqual(
      new ProgrammeBuilder({
        channel: 'one.tv',
        start,
        stop: '20260717210000 +0000',
        title: 'News',
        lang: 'en',
      }).build(),
    );

    // Chains like any other builder; options default to empty.
    expect(ProgrammeBuilder.of('one.tv', start, 'News').desc('Story').build()).toEqual(
      new ProgrammeBuilder({ channel: 'one.tv', start, title: 'News' }).desc('Story').build(),
    );
  });

  it('accepts a unix-seconds timestamp and offset/precision date options', () => {
    // A number is a unix timestamp in seconds.
    const programme = ProgrammeBuilder.of('one.tv', 1_216_081_800, 'News')
      .stop(1_216_085_400, { offset: 120 })
      .date('1999')
      .build();

    expect(programme.start.getTime()).toBe(1_216_081_800_000);
    expect(getXmltvOffset(programme.stop!)).toBe(120);
    // A bare-year <date> keeps year precision, so it re-emits as "1999".
    expect(getXmltvPrecision(programme.date!)).toBe(4);
    expect(serializeProgramme(programme)).toContain('<date>1999</date>');
    expect(serializeProgramme(programme)).toContain('stop="20080715033000 +0200"');
  });

  it('sets the optional programme attributes fluently, matching the constructor form', () => {
    const start = '20260717200000 +0000';
    const stop = '20260717210000 +0000';

    const chained = new ProgrammeBuilder({ channel: 'c', start, title: 'T' })
      .stop(stop)
      .pdcStart('20260717200500 +0000')
      .vpsStart('20260717200600 +0000')
      .showview('12345')
      .videoplus('67890')
      .clumpidx('0/2')
      .build();

    const viaConstructor = new ProgrammeBuilder({
      channel: 'c',
      start,
      title: 'T',
      stop,
      pdcStart: '20260717200500 +0000',
      vpsStart: '20260717200600 +0000',
      showview: '12345',
      videoplus: '67890',
      clumpidx: '0/2',
    }).build();

    expect(chained).toEqual(viaConstructor);
    expect(chained.stop).toEqual(parseXmltvDate(stop));
    expect(chained.clumpidx).toBe('0/2');
  });

  it('applies a default lang to language-taggable fields unless overridden', () => {
    const programme = new ProgrammeBuilder({
      channel: 'one.tv',
      start: '20260717200000 +0000',
      title: 'News',
      lang: 'en',
    })
      .subTitle('Pilot')
      .category('News')
      .keyword('live', 'sk')
      .language('English', '')
      .build();

    expect(programme.subTitle).toEqual([{ value: 'Pilot', lang: 'en' }]);
    expect(programme.category).toEqual([{ value: 'News', lang: 'en' }]);
    expect(programme.keyword).toEqual([{ value: 'live', lang: 'sk' }]);
    expect(programme.language).toEqual({ value: 'English' });
  });

  it('adds a second <title> for multi-language guides', () => {
    const programme = new ProgrammeBuilder({
      channel: 'c',
      start: '20260717200000 +0000',
      title: 'News',
      lang: 'en',
    })
      .title('Správy', 'sk')
      .build();

    expect(programme.title).toEqual([
      { value: 'News', lang: 'en' },
      { value: 'Správy', lang: 'sk' },
    ]);
  });

  it('generates both xmltv_ns and onscreen entries from season/episode', () => {
    const programme = new ProgrammeBuilder({
      channel: 'c',
      start: '20260717200000 +0000',
      title: 'T',
    })
      .episode(5, 2)
      .build();

    expect(programme.episodeNum).toEqual([
      { system: 'xmltv_ns', value: '1.4.0/1' },
      { system: 'onscreen', value: 'S02E05' },
    ]);
  });

  it('defaults season to 1 when omitted', () => {
    const programme = new ProgrammeBuilder({
      channel: 'c',
      start: '20260717200000 +0000',
      title: 'T',
    })
      .episode(5)
      .build();

    expect(programme.episodeNum).toEqual([
      { system: 'xmltv_ns', value: '0.4.0/1' },
      { system: 'onscreen', value: 'S01E05' },
    ]);
  });

  it('adds xmltv_ns episode/season totals and part counts via options', () => {
    const build = (opts: Parameters<ProgrammeBuilder['episode']>[2]) =>
      new ProgrammeBuilder({ channel: 'c', start: '20260717200000 +0000', title: 'T' })
        .episode(6, 2, opts)
        .build().episodeNum ?? [];

    const xmltvNs = (opts: Parameters<ProgrammeBuilder['episode']>[2]) => build(opts)[0];
    const onscreen = (opts: Parameters<ProgrammeBuilder['episode']>[2]) => build(opts)[1];

    // Total episodes in the season.
    expect(xmltvNs({ episodes: 13 })).toEqual({ system: 'xmltv_ns', value: '1.5/13.0/1' });
    // Total seasons too.
    expect(xmltvNs({ episodes: 13, seasons: 3 })).toEqual({
      system: 'xmltv_ns',
      value: '1/3.5/13.0/1',
    });
    // A multi-part episode: part 1 of 2.
    expect(xmltvNs({ parts: 2 })).toEqual({ system: 'xmltv_ns', value: '1.5.0/2' });
    // An explicit later part.
    expect(xmltvNs({ part: 2, parts: 2 })).toEqual({ system: 'xmltv_ns', value: '1.5.1/2' });

    // onscreen stays plain for a single part, and shows a 1-based ratio when multi-part.
    expect(onscreen({ episodes: 13 })).toEqual({ system: 'onscreen', value: 'S02E06' });
    expect(onscreen({ parts: 2 })).toEqual({ system: 'onscreen', value: 'S02E06 (1/2)' });
    expect(onscreen({ part: 2, parts: 2 })).toEqual({ system: 'onscreen', value: 'S02E06 (2/2)' });
  });

  it('keeps episodeNum as an explicit escape hatch alongside the season/episode shortcut', () => {
    const programme = new ProgrammeBuilder({
      channel: 'c',
      start: '20260717200000 +0000',
      title: 'T',
    })
      .episodeNum('dd_progid', 'EP01006886.0028')
      .episode(5)
      .build();

    expect(programme.episodeNum).toEqual([
      { system: 'dd_progid', value: 'EP01006886.0028' },
      { system: 'xmltv_ns', value: '0.4.0/1' },
      { system: 'onscreen', value: 'S01E05' },
    ]);
  });

  it('accepts yes/no strings and booleans interchangeably for video/audio/actor.guest', () => {
    const programme = new ProgrammeBuilder({
      channel: 'c',
      start: '20260717200000 +0000',
      title: 'T',
    })
      .video({ present: 'yes', colour: false })
      .audio({ present: true })
      .actor('Ryan Lee', { guest: 'yes' })
      .build();

    expect(programme.video).toEqual({ present: true, colour: false });
    expect(programme.audio).toEqual({ present: true });
    expect(programme.credits?.actor?.[0]?.guest).toBe(true);
  });

  it('merges video/audio across multiple calls instead of overwriting', () => {
    const programme = new ProgrammeBuilder({
      channel: 'c',
      start: '20260717200000 +0000',
      title: 'T',
    })
      .video({ present: true })
      .video({ aspect: '16:9' })
      .build();

    expect(programme.video).toEqual({ present: true, aspect: '16:9' });
  });

  it('sets the new flag as a boolean; false is stored but emits no tag', () => {
    const builder = new ProgrammeBuilder({
      channel: 'c',
      start: '20260717200000 +0000',
      title: 'T',
    }).new();

    expect(builder.build().new).toBe(true);

    builder.new(false);
    expect(builder.build().new).toBe(false);

    // A falsy flag serializes to nothing.
    expect(serializeProgramme(builder.build())).not.toContain('<new');
  });

  it('defaults premiere/lastChance to a bare flag when no text is given', () => {
    const programme = new ProgrammeBuilder({
      channel: 'c',
      start: '20260717200000 +0000',
      title: 'T',
    })
      .premiere()
      .lastChance('Last time on this channel', 'en')
      .build();

    expect(programme.premiere).toBe(true);
    expect(programme.lastChance).toEqual({ value: 'Last time on this channel', lang: 'en' });
  });

  it('collapses url/person entries to a plain string unless extra fields are set', () => {
    const programme = new ProgrammeBuilder({
      channel: 'c',
      start: '20260717200000 +0000',
      title: 'T',
    })
      .url('https://example.com/programme_one_2')
      .url('https://example.com/programme_one', { system: 'imdb' })
      .director('Bart Eskander')
      .actor('Ryan Lee', {
        role: 'Karl James',
        guest: true,
        image: ['https://example.com/xxx.jpg'],
        url: ['https://example.com/person/204'],
      })
      .build();

    expect(programme.url).toEqual([
      'https://example.com/programme_one_2',
      { value: 'https://example.com/programme_one', system: 'imdb' },
    ]);
    expect(programme.credits?.director).toEqual(['Bart Eskander']);
    expect(programme.credits?.actor?.[0]).toEqual({
      value: 'Ryan Lee',
      role: 'Karl James',
      guest: true,
      image: [{ value: 'https://example.com/xxx.jpg' }],
      url: ['https://example.com/person/204'],
    });
  });

  it('attaches extraAttributes to every kind of element via the trailing argument', () => {
    const programme = new ProgrammeBuilder({
      channel: 'c',
      start: '20260717200000 +0000',
      title: 'T',
    })
      .desc('Plot', 'en', { src: 'tmdb' })
      .url('https://example.com', undefined, { role: 'main' })
      .director('Jane Doe', {}, { 'data-id': '42' })
      .icon('https://example.com/i.png', { width: 32 }, { foo: 'bar' })
      .episodeNum('dd_progid', 'EP01', { generator: 'x' })
      .length(90, 'minutes', { source: 'guide' })
      .rating('PG', { system: 'BBFC' }, { locale: 'gb' })
      .video({ present: true }, { codec: 'h264' })
      .build();

    // A text value keeps its lang and gains the attribute.
    expect(programme.desc).toEqual([
      { value: 'Plot', lang: 'en', extraAttributes: { src: 'tmdb' } },
    ]);
    // A url that would otherwise collapse to a string stays an object once it has attributes.
    expect(programme.url).toEqual([
      { value: 'https://example.com', extraAttributes: { role: 'main' } },
    ]);
    // Likewise a credit person that would otherwise be a bare name.
    expect(programme.credits?.director).toEqual([
      { value: 'Jane Doe', extraAttributes: { 'data-id': '42' } },
    ]);
    expect(programme.icon).toEqual([
      { src: 'https://example.com/i.png', width: 32, extraAttributes: { foo: 'bar' } },
    ]);
    expect(programme.episodeNum).toEqual([
      { system: 'dd_progid', value: 'EP01', extraAttributes: { generator: 'x' } },
    ]);
    expect(programme.length).toEqual({
      units: 'minutes',
      value: 90,
      extraAttributes: { source: 'guide' },
    });
    expect(programme.rating).toEqual([
      { value: 'PG', system: 'BBFC', extraAttributes: { locale: 'gb' } },
    ]);
    expect(programme.video).toEqual({ present: true, extraAttributes: { codec: 'h264' } });
  });

  it('merges the positional extraAttributes with the options ones (positional wins on conflict)', () => {
    const programme = new ProgrammeBuilder({
      channel: 'c',
      start: '20260717200000 +0000',
      title: 'T',
    })
      .icon(
        'https://example.com/i.png',
        { width: 32, extraAttributes: { foo: 'opts', keep: 'opts' } },
        { foo: 'arg', extra: 'arg' },
      )
      .build();

    expect(programme.icon).toEqual([
      {
        src: 'https://example.com/i.png',
        width: 32,
        extraAttributes: { keep: 'opts', foo: 'arg', extra: 'arg' },
      },
    ]);
  });

  it('carries extraAttributes on nested elements through their options object', () => {
    const programme = new ProgrammeBuilder({
      channel: 'c',
      start: '20260717200000 +0000',
      title: 'T',
    })
      .director('Jane Doe', {
        image: [
          ['https://example.com/j.jpg', { system: 'tmdb', extraAttributes: { crop: 'face' } }],
        ],
        url: [['https://example.com/person/1', { extraAttributes: { lang: 'en' } }]],
      })
      .rating('PG', {
        system: 'BBFC',
        icon: [['https://example.com/pg.png', { extraAttributes: { theme: 'dark' } }]],
      })
      .build();

    expect(programme.credits?.director).toEqual([
      {
        value: 'Jane Doe',
        image: [
          { value: 'https://example.com/j.jpg', system: 'tmdb', extraAttributes: { crop: 'face' } },
        ],
        url: [{ value: 'https://example.com/person/1', extraAttributes: { lang: 'en' } }],
      },
    ]);
    expect(programme.rating?.[0]?.icon).toEqual([
      { src: 'https://example.com/pg.png', extraAttributes: { theme: 'dark' } },
    ]);
  });

  it('round-trips element extraAttributes through serialize + parse', () => {
    const built = new ProgrammeBuilder({ channel: 'c', start: '20260717200000 +0000', title: 'T' })
      .url('https://example.com', undefined, { role: 'main' })
      .rating('PG', { system: 'BBFC' }, { locale: 'gb' })
      .build();

    const doc = parseXmltvString(`<tv>${serializeProgramme(built)}</tv>`);

    expect(doc.warnings).toEqual([]);
    expect(doc.programmes).toEqual([built]);
  });

  it('sets programme extraAttributes one at a time and merged', () => {
    const programme = new ProgrammeBuilder({
      channel: 'c',
      start: '20260717200000 +0000',
      title: 'T',
    })
      .extraAttribute('data-source', 'grabber')
      .extraAttribute('data-run', '7')
      .extraAttributes({ 'data-run': '8', 'data-locale': 'gb' })
      .build();

    // Later writes win on collision; the single-attribute helper merges rather than replaces.
    expect(programme.extraAttributes).toEqual({
      'data-source': 'grabber',
      'data-run': '8',
      'data-locale': 'gb',
    });
  });

  it('produces a programme that round-trips through serialize + parse', () => {
    const built = new ProgrammeBuilder({
      channel: 'one.tv',
      start: '20260717200000 +0000',
      stop: '20260717210000 +0000',
      title: 'News',
      lang: 'en',
    })
      .desc('Evening news bulletin')
      .category('News')
      .episode(3)
      .rating('PG', { system: 'BBFC' })
      .actor('Ryan Lee', { role: 'Host', guest: true })
      .video({ present: true, colour: true, aspect: '16:9' })
      .new()
      .build();

    const xml = `<tv>${serializeProgramme(built)}</tv>`;
    const doc = parseXmltvString(xml);

    expect(doc.warnings).toEqual([]);
    expect(doc.programmes).toEqual([built]);
  });
});

describe('ChannelBuilder', () => {
  it('builds a minimal channel from id + first display name', () => {
    const channel = new ChannelBuilder({ id: 'one.tv', displayName: 'One' }).build();

    expect(channel).toEqual({ id: 'one.tv', displayName: [{ value: 'One' }] });
  });

  it('exposes a positional `of` factory equivalent to the base-object constructor', () => {
    expect(ChannelBuilder.of('one.tv', 'One', 'en').build()).toEqual(
      new ChannelBuilder({ id: 'one.tv', displayName: 'One', lang: 'en' }).build(),
    );

    // Chains like any other builder.
    expect(ChannelBuilder.of('two.tv', 'Two').icon('two.png').build()).toEqual({
      id: 'two.tv',
      displayName: [{ value: 'Two' }],
      icon: [{ src: 'two.png' }],
    });
  });

  it('adds multi-language display names, icons and urls with the default lang', () => {
    const channel = new ChannelBuilder({ id: 'one.tv', displayName: 'One', lang: 'en' })
      .displayName('Jeden', 'sk')
      .displayName('1') // call sign, no lang
      .icon('https://example.com/one.png', { width: 64, height: 64 })
      .url('https://example.com', { system: 'website' })
      .extraAttribute('data-src', 'grabber')
      .build();

    expect(channel).toEqual({
      id: 'one.tv',
      displayName: [
        { value: 'One', lang: 'en' },
        { value: 'Jeden', lang: 'sk' },
        { value: '1', lang: 'en' },
      ],
      icon: [{ src: 'https://example.com/one.png', width: 64, height: 64 }],
      url: [{ value: 'https://example.com', system: 'website' }],
      extraAttributes: { 'data-src': 'grabber' },
    });
  });

  it('round-trips through serialize + parse', () => {
    const built = new ChannelBuilder({ id: 'one.tv', displayName: 'One', lang: 'en' })
      .displayName('Jeden', 'sk')
      .icon('https://example.com/one.png', { width: 64 })
      .build();

    const doc = parseXmltvString(`<tv>${serializeChannel(built)}</tv>`);

    expect(doc.warnings).toEqual([]);
    expect(doc.channels).toEqual([built]);
  });
});

describe('XmltvDocumentBuilder', () => {
  it('accepts base fields or standalone builders and produces serializer input', () => {
    const doc = new XmltvDocumentBuilder()
      .meta({ generatorInfoName: 'epg-tools' })
      .meta({ sourceInfoName: 'Example' }) // merges
      .channel(new ChannelBuilder({ id: 'one.tv', displayName: 'One' })) // standalone builder
      .channel({ id: 'two.tv', displayName: 'Two' }) // base fields
      .programme(
        new ProgrammeBuilder({ channel: 'one.tv', start: '20260717200000 +0000', title: 'News' }),
      )
      .build();

    expect(doc.meta).toEqual({ generatorInfoName: 'epg-tools', sourceInfoName: 'Example' });
    expect(doc.channels).toHaveLength(2);
    expect(doc.programmes).toHaveLength(1);
  });

  it('sets root <tv> meta through shortcut methods', () => {
    const doc = new XmltvDocumentBuilder()
      .date('20260717000000 +0000')
      .sourceInfo('Example TV', 'https://example.com')
      .sourceDataUrl('https://example.com/data')
      .generatorInfo('epg-tools') // name only
      .build();

    expect(doc.meta).toEqual({
      date: parseXmltvDate('20260717000000 +0000'),
      sourceInfoName: 'Example TV',
      sourceInfoUrl: 'https://example.com',
      sourceDataUrl: 'https://example.com/data',
      generatorInfoName: 'epg-tools',
    });
  });

  it('sets extraAttributes on the root <tv> and round-trips them', async () => {
    const built = new XmltvDocumentBuilder()
      .meta({ generatorInfoName: 'epg-tools' })
      .extraAttribute('data-run', '7')
      .extraAttributes({ 'data-locale': 'gb' })
      .channel({ id: 'one.tv', displayName: 'One' })
      .build();

    expect(built.meta).toEqual({
      generatorInfoName: 'epg-tools',
      extraAttributes: { 'data-run': '7', 'data-locale': 'gb' },
    });

    const parsed = parseXmltvString(await collect(built));

    expect(parsed.warnings).toEqual([]);
    expect(parsed.meta).toEqual(built.meta);
  });

  it('adds channels/programmes via the configure callback and stays on the document builder', () => {
    const doc = new XmltvDocumentBuilder()
      .channel({ id: 'one.tv', displayName: 'One', lang: 'en' }, (c) =>
        c.displayName('Jeden', 'sk').icon('one.png'),
      )
      .programme({ channel: 'one.tv', start: '20260717200000 +0000', title: 'News' }, (p) =>
        p.desc('Evening news').episode(3),
      )
      .build();

    expect(doc.channels).toEqual([
      {
        id: 'one.tv',
        displayName: [
          { value: 'One', lang: 'en' },
          { value: 'Jeden', lang: 'sk' },
        ],
        icon: [{ src: 'one.png' }],
      },
    ]);
    expect(doc.programmes).toEqual([
      new ProgrammeBuilder({ channel: 'one.tv', start: '20260717200000 +0000', title: 'News' })
        .desc('Evening news')
        .episode(3)
        .build(),
    ]);
  });

  it('adds channels/programmes via addChannel/addProgramme and .end() back to the document', () => {
    const doc = new XmltvDocumentBuilder()
      .addChannel({ id: 'one.tv', displayName: 'One', lang: 'en' })
      .displayName('Jeden', 'sk')
      .icon('one.png')
      .end()
      .addProgramme({ channel: 'one.tv', start: '20260717200000 +0000', title: 'News' })
      .desc('Evening news')
      .episode(3)
      .end()
      .build();

    expect(doc.channels).toEqual([
      {
        id: 'one.tv',
        displayName: [
          { value: 'One', lang: 'en' },
          { value: 'Jeden', lang: 'sk' },
        ],
        icon: [{ src: 'one.png' }],
      },
    ]);
    expect(doc.programmes).toEqual([
      new ProgrammeBuilder({ channel: 'one.tv', start: '20260717200000 +0000', title: 'News' })
        .desc('Evening news')
        .episode(3)
        .build(),
    ]);
  });

  it('emits tagged {type,value} events via toEvents', () => {
    const events = new XmltvDocumentBuilder()
      .generatorInfo('epg-tools')
      .channel({ id: 'one.tv', displayName: 'One' })
      .programme({ channel: 'one.tv', start: '20260717200000 +0000', title: 'News' })
      .toEvents();

    expect(events.map((e) => e.type)).toEqual(['meta', 'channel', 'programme']);
    expect(events[0]).toEqual({ type: 'meta', value: { generatorInfoName: 'epg-tools' } });
    expect(events[1]).toMatchObject({ type: 'channel', value: { id: 'one.tv' } });
    expect(events[2]).toMatchObject({ type: 'programme', value: { channel: 'one.tv' } });
  });

  it('serializes to an XML string via toXml, matching the stream output', async () => {
    const builder = new XmltvDocumentBuilder()
      .generatorInfo('epg-tools')
      .channel({ id: 'one.tv', displayName: 'One' }, (c) => c.icon('one.png'))
      .programme({ channel: 'one.tv', start: '20260717200000 +0000', title: 'News' }, (p) =>
        p.desc('Story'),
      );

    const xml = builder.toXml();

    // Same bytes as the streamed serializer, and parses back to the source document.
    expect(xml).toBe(await collect(builder.build()));

    const parsed = parseXmltvString(xml);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.channels).toEqual(builder.build().channels);
    expect(parsed.programmes).toEqual(builder.build().programmes);

    // Honors serialize options (pretty-print).
    expect(builder.toXml({ indent: 2 })).toContain('\n');
  });

  it('produces a pipeable XML stream via toStream that parses back', async () => {
    const builder = new XmltvDocumentBuilder()
      .generatorInfo('epg-tools')
      .channel({ id: 'one.tv', displayName: 'One' })
      .programme({ channel: 'one.tv', start: '20260717200000 +0000', title: 'News' });

    let xml = '';
    for await (const chunk of builder.toStream()) xml += chunk;

    const parsed = parseXmltvString(xml);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.channels).toEqual(builder.build().channels);
    expect(parsed.programmes).toEqual(builder.build().programmes);
  });

  it('assembles a whole document that round-trips through writeXmltvStream + parse', async () => {
    const built = new XmltvDocumentBuilder()
      .meta({ generatorInfoName: 'epg-tools', date: parseXmltvDate('20260717000000 +0000') })
      .channel(
        new ChannelBuilder({ id: 'one.tv', displayName: 'One', lang: 'en' }).icon(
          'https://example.com/one.png',
        ),
      )
      .programme(
        // pass a standalone builder
        new ProgrammeBuilder({
          channel: 'one.tv',
          start: '20260717200000 +0000',
          stop: '20260717210000 +0000',
          title: 'News',
          lang: 'en',
        })
          .desc('Evening news')
          .episode(3),
      )
      .build();

    const parsed = parseXmltvString(await collect(built));

    expect(parsed.warnings).toEqual([]);
    expect(parsed.meta).toEqual(built.meta);
    expect(parsed.channels).toEqual(built.channels);
    expect(parsed.programmes).toEqual(built.programmes);
  });
});

describe('the whole supported tree', () => {
  /**
   * Every place the model allows a non-DTD child element, in one document.
   * The parser produces all of them and the serializer emits all of them, so
   * the builder has to be able to say all of them too — otherwise a guide can
   * be read and written but not constructed.
   */
  const XML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv>
<programme start="20260807060000 +0000" channel="one.example.tv">
<title lang="en">Show</title>
<credits>
<director>Ada<image type="person">https://example.tv/ada.png</image><url system="imdb">https://imdb.example/ada</url><person-id>nm1</person-id></director>
<actor role="Lead">Bo<character-id>ch1</character-id></actor>
<crid>credits-level</crid>
</credits>
<video><present>yes</present><colour>yes</colour><aspect>16:9</aspect><quality>HDTV</quality><hdr format="HLG"/></video>
<audio><present>yes</present><stereo>stereo</stereo><codec>aac</codec></audio>
<subtitles type="teletext"><language lang="en" origin="provider">English</language><page>888</page></subtitles>
<rating system="MPAA"><value>PG</value><icon src="https://example.tv/pg.png" width="16"/><authority>x</authority></rating>
<star-rating system="tv.com"><value>8/10</value><icon src="https://example.tv/star.png"/><votes>42</votes></star-rating>
<live/>
</programme>
</tv>
`;

  it('parses into a programme the builder can reproduce exactly', () => {
    const { programmes } = parseXmltvString(XML);
    const parsed = programmes[0];

    const built = new ProgrammeBuilder({
      channel: 'one.example.tv',
      start: parseXmltvDate('20260807060000 +0000'),
      title: 'Show',
      lang: 'en',
    })
      .director('Ada', {
        image: [['https://example.tv/ada.png', { type: 'person' }]],
        url: [['https://imdb.example/ada', { system: 'imdb' }]],
        extra: { name: 'person-id', value: 'nm1' },
      })
      .actor('Bo', { role: 'Lead', extra: { name: 'character-id', value: 'ch1' } })
      .creditsExtra({ name: 'crid', value: 'credits-level' })
      .video({
        present: true,
        colour: true,
        aspect: '16:9',
        quality: 'HDTV',
        extra: { name: 'hdr', attributes: { format: 'HLG' } },
      })
      .audio({ present: true, stereo: 'stereo', extra: { name: 'codec', value: 'aac' } })
      .subtitles({
        type: 'teletext',
        language: ['English', { extraAttributes: { origin: 'provider' } }],
        extra: { name: 'page', value: '888' },
      })
      .rating('PG', {
        system: 'MPAA',
        icon: [['https://example.tv/pg.png', { width: 16 }]],
        extra: { name: 'authority', value: 'x' },
      })
      .starRating('8/10', {
        system: 'tv.com',
        icon: 'https://example.tv/star.png',
        extra: { name: 'votes', value: '42' },
      })
      .extra({ name: 'live' })
      .build();

    expect(built).toEqual(parsed);
  });

  it('reproduces a channel with its extensions too', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<tv>
<channel id="one.example.tv" source="provider">
<display-name lang="en" origin="epg">One</display-name>
<icon src="https://example.tv/one.png" width="32" height="32" role="logo"/>
<url system="site">https://example.tv/one</url>
<lcn>101</lcn>
</channel>
</tv>
`;

    const parsed = parseXmltvString(xml).channels[0];

    const built = new ChannelBuilder({
      id: 'one.example.tv',
      // The tuple form: the constructor's display name carries its own
      // attributes, which calling `.displayName()` again could not do — that
      // would add a second one rather than amend the first.
      displayName: ['One', { extraAttributes: { origin: 'epg' } }],
      lang: 'en',
    })
      .extraAttribute('source', 'provider')
      .icon('https://example.tv/one.png', { width: 32, height: 32 }, { role: 'logo' })
      .url('https://example.tv/one', { system: 'site' })
      .extra({ name: 'lcn', value: '101' })
      .build();

    expect(built).toEqual(parsed);
  });

  it('treats an empty extras map as having said nothing', () => {
    const base = { channel: 'c', start: parseXmltvDate('20260807060000 +0000'), title: 'T' };

    const withEmpties = new ProgrammeBuilder(base)
      .url('https://example.tv/one', { extraAttributes: {} })
      .director('Ada', {}, {})
      .category('drama', undefined, {})
      .icon('https://example.tv/i.png', { extraAttributes: {} })
      .video({ aspect: '16:9', extra: [] })
      .extraAttributes({})
      .build();

    const withNothing = new ProgrammeBuilder(base)
      .url('https://example.tv/one')
      .director('Ada')
      .category('drama')
      .icon('https://example.tv/i.png')
      .video({ aspect: '16:9' })
      .build();

    // `{}` is truthy, so without care it becomes a real `extraAttributes: {}` —
    // which the parser never produces, and which would keep `<url>` and a
    // credit name in their object form instead of collapsing to a string.
    expect(withEmpties).toEqual(withNothing);
    expect(withEmpties.url).toEqual(['https://example.tv/one']);
    expect(withEmpties.credits?.director).toEqual(['Ada']);
    expect(withEmpties.extraAttributes).toBeUndefined();
    expect(withEmpties.video?.extra).toBeUndefined();
  });

  it('treats an attribute with no value as one that was not mentioned', () => {
    const base = { channel: 'c', start: parseXmltvDate('20260807060000 +0000'), title: 'T' };

    // Extras built from optional data, as JavaScript or revived JSON can hold.
    const p = new ProgrammeBuilder(base)
      .extraAttributes({ uniqueID: 'u1', eit: undefined as unknown as string })
      .category('drama', undefined, { code: null as unknown as string })
      .url('https://example.tv/one', {
        extraAttributes: { system: undefined as unknown as string },
      })
      .build();

    expect(Object.keys(p.extraAttributes!)).toEqual(['uniqueID']);
    // Not `{ code: null }`, which would serialize as code="null".
    expect(p.category).toEqual([{ value: 'drama' }]);
    // And nothing left to stop the url collapsing to a plain string.
    expect(p.url).toEqual(['https://example.tv/one']);

    expect(serializeProgramme(p).trim()).toBe(
      '<programme start="20260807060000 +0000" channel="c" uniqueID="u1">' +
        '<title>T</title><category>drama</category><url>https://example.tv/one</url></programme>',
    );
  });

  it('lets a subtitles language name its own lang, over the subtitles-level one', () => {
    const base = {
      channel: 'c',
      start: parseXmltvDate('20260807060000 +0000'),
      title: 'T',
      lang: 'en',
    };

    const p = new ProgrammeBuilder(base)
      .subtitles({ language: 'Deutsch', lang: 'de' })
      .subtitles({ language: ['Français', { lang: 'fr' }], lang: 'de' })
      .build();

    expect(p.subtitles?.map((sub) => sub.language?.lang)).toEqual(['de', 'fr']);
  });

  it('does not let a missing value overwrite the other source', () => {
    const base = { channel: 'c', start: parseXmltvDate('20260807060000 +0000'), title: 'T' };

    // The positional argument wins where it says something, and stays out of
    // the way where it has no value.
    const p = new ProgrammeBuilder(base)
      .icon(
        'https://example.tv/i.png',
        { extraAttributes: { role: 'logo', size: 'sm' } },
        {
          role: undefined as unknown as string,
          size: 'lg',
        },
      )
      .build();

    expect(p.icon?.[0]?.extraAttributes).toEqual({ role: 'logo', size: 'lg' });
  });

  it('never writes a null attribute out, however the model was built', () => {
    // Bypassing the builder: the guard belongs in the serializer too.
    const xml = serializeProgramme({
      channel: 'c',
      start: parseXmltvDate('20260807060000 +0000'),
      title: [{ value: 'T' }],
      extraAttributes: { uniqueID: 'u1', eit: null as unknown as string },
    });

    expect(xml).toContain('uniqueID="u1"');
    expect(xml).not.toContain('null');
  });

  it('round-trips every one of them through serialize and parse', () => {
    const { programmes } = parseXmltvString(XML);
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?><tv>` + serializeProgramme(programmes[0]!) + `</tv>`;

    // Not a string comparison against the source: whitespace between elements
    // is not content. What must survive is the tree, extensions included.
    expect(parseXmltvString(xml).programmes[0]).toEqual(programmes[0]);
    expect(parseXmltvString(xml).warnings).toEqual([]);
  });
});

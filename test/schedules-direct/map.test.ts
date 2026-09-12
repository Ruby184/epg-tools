import { describe, expect, it } from 'vitest';
import {
  buildProgramme,
  channelIdOf,
  schedulesDirectChannelExtras,
  schedulesDirectProgramme,
  schedulesDirectStation,
} from '../../src/grabber/schedules-direct/map.js';
import type {
  WireAiring,
  WireProgram,
  WireStation,
} from '../../src/grabber/schedules-direct/wire.js';
import { ChannelBuilder } from '../../src/xmltv/builder.js';

const STATION: WireStation = {
  stationID: '20454',
  name: 'WBBMDT (WBBM-DT)',
  callsign: 'WBBMDT',
  affiliate: 'CBS',
  broadcastLanguage: ['en'],
  descriptionLanguage: ['en'],
  logo: { URL: 'https://example.test/wbbm.png', width: 360, height: 270 },
};

const AIRING: WireAiring = {
  programID: 'EP012801050074',
  airDateTime: '2026-09-12T20:00:00Z',
  duration: 3600,
  md5: 'abc',
  new: true,
  audioProperties: ['stereo', 'cc'],
  videoProperties: ['hdtv'],
};

const PROGRAM: WireProgram = {
  programID: 'EP012801050074',
  titles: [{ title120: 'Blue Bloods', titleLanguage: 'en' }],
  episodeTitle150: 'Drawing Dead',
  descriptions: {
    description1000: [{ descriptionLanguage: 'en', description: 'A Wall Street executive.' }],
    description100: [{ descriptionLanguage: 'en', description: 'Short one.' }],
  },
  originalAirDate: '2013-11-08',
  showType: 'Series',
  entityType: 'Episode',
  genres: ['Crime drama'],
  metadata: [{ Gracenote: { season: 4, episode: 7 } }],
  cast: [{ billingOrder: '01', role: 'Actor', name: 'Tom Selleck', characterName: 'Frank Reagan' }],
  crew: [{ billingOrder: '01', role: 'Executive Producer', name: 'Leonard Goldberg' }],
  contentRating: [{ body: 'USA Parental Rating', code: 'TV-14' }],
};

/** The station as everything downstream sees it. */
const station = schedulesDirectStation(STATION, '002')!.data!;

/** One built programme, for a case to look inside. */
function built(airing: Partial<WireAiring> = {}, program: Partial<WireProgram> = {}) {
  const normalised = schedulesDirectProgramme(
    { ...AIRING, ...airing },
    { ...PROGRAM, ...program },
    station,
  );

  return buildProgramme('I20454.json.schedulesdirect.org', normalised!).build();
}

describe('a station', () => {
  it('takes the id the reference grabber writes, so two guides can be merged', () => {
    const channel = schedulesDirectStation(STATION, '002');

    expect(channel).toMatchObject({
      xmltvId: 'I20454.json.schedulesdirect.org',
      // What its schedules are asked for by, which is not what the guide calls it.
      siteId: '20454',
      name: 'WBBMDT (WBBM-DT)',
      lang: 'en',
      logo: 'https://example.test/wbbm.png',
      preset: '002',
    });
  });

  it('takes another format, for a guide that has always used one', () => {
    expect(channelIdOf(station, 'I%s.labs.zap2it.com')).toBe('I20454.labs.zap2it.com');
    expect(channelIdOf(station, '%s')).toBe('20454');
    expect(channelIdOf(station, (one) => `${one.callsign ?? one.stationID}.us`)).toBe('WBBMDT.us');
  });

  it('is not a channel at all without an id to ask about it by', () => {
    expect(schedulesDirectStation({ name: 'Nameless' }, '001')).toBeUndefined();
  });

  it('keeps what the DTD has no place for as extensions', () => {
    const element = ChannelBuilder.of('I20454.json.schedulesdirect.org', 'WBBMDT');

    schedulesDirectChannelExtras(element, station);

    expect(element.build()).toMatchObject({
      extraAttributes: { stationId: '20454', callsign: 'WBBMDT', affiliate: 'CBS' },
    });
  });
});

describe('a programme', () => {
  it('writes what the DTD has elements for', () => {
    const programme = built();

    expect(programme).toMatchObject({
      channel: 'I20454.json.schedulesdirect.org',
      title: [{ value: 'Blue Bloods', lang: 'en' }],
      subTitle: [{ value: 'Drawing Dead' }],
      desc: [{ value: 'A Wall Street executive.', lang: 'en' }],
      new: true,
    });
    // An hour after it started, from the duration in seconds.
    expect(programme.stop).toEqual(expect.objectContaining({}));
    expect(programme.rating).toEqual([{ value: 'TV-14', system: 'USA Parental Rating' }]);
    expect(programme.video).toMatchObject({ quality: 'HDTV' });
    expect(programme.audio).toMatchObject({ stereo: 'stereo' });
    // `cc` is closed captioning, which is a `<subtitles>` rather than an audio
    // property once it reaches the DTD.
    expect(programme.subtitles).toEqual([{ type: 'teletext' }]);
  });

  it('is nothing at all when it cannot be written', () => {
    // No title is the case that matters: `<title>` is the one child the DTD
    // requires, so a programme the service refused to describe takes its airing
    // with it rather than becoming an untitled entry.
    expect(schedulesDirectProgramme(AIRING, undefined, station)).toBeUndefined();
    expect(schedulesDirectProgramme(AIRING, { ...PROGRAM, titles: [] }, station)).toBeUndefined();

    // An airing with no start, which is what the field being absent means.
    const { airDateTime: _start, ...undated } = AIRING;

    expect(schedulesDirectProgramme(undated, PROGRAM, station)).toBeUndefined();
  });

  describe('and its numbering', () => {
    it('writes the Gracenote season and episode in both systems at once', () => {
      const systems = new Map(
        built().episodeNum?.map((entry) => [entry.system, entry.value]) ?? [],
      );

      // Zero-based for `xmltv_ns`, one-based for people.
      expect(systems.get('xmltv_ns')).toBe('3.6.0/1');
      expect(systems.get('onscreen')).toBe('S04E07');
    });

    it('writes the service`s id as the dd_progid it is', () => {
      const systems = new Map(
        built().episodeNum?.map((entry) => [entry.system, entry.value]) ?? [],
      );

      expect(systems.get('dd_progid')).toBe('EP01280105.0074');
      // And never as a number: the tail of an `EP` id is which broadcast this
      // is, not which episode — Seinfeld S09E17 carries 0196.
      expect(systems.get('xmltv_ns')).not.toContain('73');
    });

    it('says which part of a multi-part episode an airing is', () => {
      const systems = new Map(
        built({ multipart: { partNumber: 1, totalParts: 2 } }).episodeNum?.map((entry) => [
          entry.system,
          entry.value,
        ]) ?? [],
      );

      expect(systems.get('xmltv_ns')).toBe('3.6.0/2');
      expect(systems.get('onscreen')).toContain('S04E07');
    });

    it('writes no numbering at all for something the service did not number', () => {
      const systems = new Map(
        built({}, { metadata: [] }).episodeNum?.map((entry) => [entry.system, entry.value]) ?? [],
      );

      expect(systems.has('xmltv_ns')).toBe(false);
      // The id is still worth writing: it is what a consumer matches on.
      expect(systems.get('dd_progid')).toBe('EP01280105.0074');
    });
  });

  describe('and its categories', () => {
    it('writes the service`s own terms, untranslated', () => {
      // Gracenote's vocabulary verbatim. Mapping it onto DVB is the output
      // profile's job, at serialize time, where it can be changed without
      // refetching anything.
      expect(built().category).toEqual([
        { value: 'Crime drama', lang: 'en' },
        { value: 'Series', lang: 'en' },
      ]);
    });

    it('calls them English even on a station that is not', () => {
      const spanish = schedulesDirectStation(
        { ...STATION, broadcastLanguage: ['es'], descriptionLanguage: ['es'] },
        '002',
      )!.data!;
      const programme = buildProgramme(
        'I20454.json.schedulesdirect.org',
        schedulesDirectProgramme(
          AIRING,
          { ...PROGRAM, titles: [{ title120: 'Sangre Azul', titleLanguage: 'es' }] },
          spanish,
        )!,
      ).build();

      expect(programme.title).toEqual([{ value: 'Sangre Azul', lang: 'es' }]);
      // The genre is still Gracenote's English term, and saying it is Spanish
      // because the station is would be a lie that reads as consistency.
      expect(programme.category).toEqual([
        { value: 'Crime drama', lang: 'en' },
        { value: 'Series', lang: 'en' },
      ]);
    });
  });

  describe('and its people', () => {
    it('puts each on the element its role belongs to', () => {
      const programme = built();

      expect(programme.credits?.actor).toEqual([{ value: 'Tom Selleck', role: 'Frank Reagan' }]);
      // `Executive Producer` is a producer as far as the DTD is concerned — and
      // a credit with nothing to say but a name is written as one.
      expect(programme.credits?.producer).toEqual(['Leonard Goldberg']);
    });

    it('keeps a role the DTD has no element for rather than the name', () => {
      const programme = built({}, { crew: [{ role: 'Casting Director', name: 'Jane Doe' }] });

      expect(programme.credits?.extra).toEqual([
        { name: 'credit', attributes: { role: 'Casting Director' }, value: 'Jane Doe' },
      ]);
    });

    it('keeps the ones the service billed first, and no more', () => {
      const cast = Array.from({ length: 12 }, (_, index) => ({
        billingOrder: String(index + 1).padStart(2, '0'),
        role: 'Actor',
        name: `Actor ${String(index + 1)}`,
      }));
      // Out of order on the wire, which is the case a sort is for.
      const programme = built({}, { cast: cast.toReversed() });

      expect(programme.credits?.actor).toHaveLength(8);
      expect(programme.credits?.actor?.[0]).toMatchObject({ value: 'Actor 1' });
      expect(programme.credits?.actor?.at(-1)).toMatchObject({ value: 'Actor 8' });
    });

    it('leaves them out when asked to', () => {
      const normalised = schedulesDirectProgramme(AIRING, PROGRAM, station, { credits: false })!;

      expect(normalised.cast).toEqual([]);
      expect(buildProgramme('x', normalised).build().credits).toBeUndefined();
    });
  });

  describe('and what it says about the broadcast', () => {
    it('calls a repeat previously shown, on the day it first went out', () => {
      // Without the flag rather than with it set to nothing: an airing the
      // service did not call new is what a repeat looks like on the wire.
      const { new: _isNew, ...repeat } = AIRING;
      const programme = buildProgramme(
        'I20454.json.schedulesdirect.org',
        schedulesDirectProgramme(repeat, PROGRAM, station)!,
      ).build();

      expect(programme.new).toBeUndefined();
      expect(programme.previouslyShown).toMatchObject({});
      // The production date is written either way.
      expect(programme.date).toBeDefined();
    });

    it('tells a premiere from a finale', () => {
      expect(built({ isPremiereOrFinale: 'Series Premiere' }).premiere).toMatchObject({
        value: 'Series Premiere',
      });
      expect(built({ isPremiereOrFinale: 'Season Finale' }).lastChance).toMatchObject({
        value: 'Season Finale',
      });
    });

    it('keeps the service`s own ids and flags as extensions', () => {
      expect(built({ liveTapeDelay: 'Live' }).extraAttributes).toMatchObject({
        programId: 'EP012801050074',
        entityType: 'Episode',
        live: 'Live',
      });
    });
  });

  describe('and its description', () => {
    it('prefers the long one, and falls back to the short', () => {
      expect(built().desc).toEqual([{ value: 'A Wall Street executive.', lang: 'en' }]);
      // With no language of its own it takes the programme's, which is the
      // station's — text inherits, rather than being labelled twice.
      expect(
        built({}, { descriptions: { description100: [{ description: 'Short one.' }] } }).desc,
      ).toEqual([{ value: 'Short one.', lang: 'en' }]);
    });

    it('takes the short one when that is what was asked for', () => {
      const normalised = schedulesDirectProgramme(AIRING, PROGRAM, station, {
        descriptions: 'short',
      })!;

      expect(normalised.description).toBe('Short one.');
    });

    it('prefers the language the station describes itself in', () => {
      const normalised = schedulesDirectProgramme(
        AIRING,
        {
          ...PROGRAM,
          descriptions: {
            description1000: [
              { descriptionLanguage: 'fr', description: 'En français.' },
              { descriptionLanguage: 'en', description: 'In English.' },
            ],
          },
        },
        station,
      )!;

      expect(normalised.description).toBe('In English.');
      expect(normalised.descriptionLanguage).toBe('en');
    });
  });
});

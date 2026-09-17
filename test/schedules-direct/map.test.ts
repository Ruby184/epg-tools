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
  // 58 of 148 real stations carry this, and it is what a content rating is
  // chosen by when the caller names no country.
  broadcaster: { city: 'London', country: 'GBR' },
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

  it('writes every logo the service holds, for a consumer to choose between', () => {
    const many = schedulesDirectStation(
      {
        ...STATION,
        stationLogo: [
          { URL: 'https://example.test/wbbm.png', width: 360, height: 270 },
          { URL: 'https://example.test/wbbm-dark.png', category: 'dark' },
        ],
      },
      '002',
    )!;
    const element = ChannelBuilder.of('I20454.json.schedulesdirect.org', 'WBBMDT');

    schedulesDirectChannelExtras(element, many.data!);

    // The primary is the one `GrabberChannel.logo` carries and is written once,
    // not twice, though the service lists it in both places.
    expect(many.logo).toBe('https://example.test/wbbm.png');
    expect(many.data!.logos).toHaveLength(2);
    expect(element.build().icon).toEqual([
      { src: 'https://example.test/wbbm-dark.png', extraAttributes: { category: 'dark' } },
    ]);
  });

  it('keeps what the DTD has no place for as extensions', () => {
    const element = ChannelBuilder.of('I20454.json.schedulesdirect.org', 'WBBMDT');

    schedulesDirectChannelExtras(element, station);

    expect(element.build()).toMatchObject({
      extraAttributes: {
        stationId: '20454',
        callsign: 'WBBMDT',
        affiliate: 'CBS',
        country: 'GBR',
        city: 'London',
      },
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
      desc: [
        { value: 'A Wall Street executive.', lang: 'en' },
        { value: 'Short one.', lang: 'en' },
      ],
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

      // All of them, billed order first: how many a guide shows is what
      // `keep: { 'programme/credits/actor': 8 }` answers, without a refetch.
      expect(programme.credits?.actor).toHaveLength(12);
      expect(programme.credits?.actor?.[0]).toMatchObject({ value: 'Actor 1' });
      expect(programme.credits?.actor?.at(-1)).toMatchObject({ value: 'Actor 12' });
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

  describe('and its ratings', () => {
    // A census of 300 real programmes found ratings from 26 countries — 292
    // Canadian ones on a British lineup. Writing them all is seven `<rating>`
    // elements a programme, of which a viewer recognises one.
    const many = {
      contentRating: [
        { body: 'Canadian Parental Rating', code: '14+', country: 'CAN' },
        { body: 'British Board of Film Classification', code: 'PG', country: 'GBR' },
        {
          body: 'Mediakasvatus- ja kuvaohjelmayksikkö',
          code: 'K12',
          country: 'FIN',
          contentWarning: ['Violence'],
        },
      ],
    };

    it('writes every board`s, so a profile can choose between them', () => {
      // Which one a guide shows is a question about the consumer reading it,
      // and the cache serves all of them at once. Narrowing it here would be a
      // refetch away from being undone.
      const normalised = schedulesDirectProgramme(AIRING, { ...PROGRAM, ...many }, station)!;

      expect(normalised.ratings).toHaveLength(3);
    });

    it('names the board in `system`, not the country', () => {
      // tvheadend matches this against the `authority` of its own rating
      // labels; a country there would match nothing.
      const programme = built(
        {},
        {
          contentRating: [
            { body: 'British Board of Film Classification', code: 'PG', country: 'GBR' },
          ],
        },
      );

      expect(programme.rating).toEqual([
        {
          value: 'PG',
          system: 'British Board of Film Classification',
          extraAttributes: { country: 'GBR' },
        },
      ]);
    });

    it('carries the country as an extension, which is what narrows them', () => {
      const all = buildProgramme(
        'x',
        schedulesDirectProgramme(AIRING, { ...PROGRAM, ...many }, station)!,
      ).build().rating!;

      expect(all.filter((one) => one.extraAttributes?.country === 'FIN')).toEqual([
        expect.objectContaining({ value: 'K12' }),
      ]);
    });

    it('writes what a board warned about, which the DTD has no field for', () => {
      const programme = built(
        {},
        {
          contentRating: [
            {
              body: 'Mediakasvatus- ja kuvaohjelmayksikkö',
              code: 'K12',
              contentWarning: ['Violence'],
            },
          ],
        },
      );

      expect(programme.rating).toEqual([
        expect.objectContaining({ extra: [{ name: 'warning', value: 'Violence' }] }),
      ]);
    });

    it('keeps an untagged rating rather than dropping the only one there is', () => {
      // An airing's own `ratings` carry no country, and older programmes carry
      // none either.
      const programme = built({}, { contentRating: [{ body: 'UK Content Provider', code: '12' }] });

      expect(programme.rating).toEqual([{ value: '12', system: 'UK Content Provider' }]);
    });

    it('writes how long the programme runs, which is not how long the slot is', () => {
      // A 3000-second programme in a 3600-second slot: the padding is real and
      // the DTD keeps the two apart.
      const programme = built({ duration: 3600 }, { duration: 3000 });

      expect(programme.length).toEqual({ units: 'seconds', value: 3000 });
      expect(programme.stop).toEqual(new Date('2026-09-12T21:00:00Z'));
    });

    it('takes a film`s runtime from where the service keeps it', () => {
      expect(built({}, { movie: { year: '1957', duration: 5580 } }).length).toEqual({
        units: 'seconds',
        value: 5580,
      });
    });

    it('writes how it was made and what it is shown for as keywords', () => {
      // Neither is a genre: one is the medium and the other is the occasion.
      const programme = built({}, { animation: 'Animated', holiday: 'Halloween' });

      expect(programme.keyword).toEqual([
        { value: 'Animated', lang: 'en' },
        { value: 'Halloween', lang: 'en' },
      ]);
    });

    it('hangs an advisory off the board that gave it, and the rest on the programme', () => {
      const programme = built(
        {},
        {
          contentRating: [
            { body: 'USA Parental Rating', code: 'TV-14', contentAdvisory: ['Dialog'] },
          ],
          contentAdvisory: ['Adult Language'],
        },
      );

      expect(programme.rating).toEqual([
        expect.objectContaining({ extra: [{ name: 'advisory', value: 'Dialog' }] }),
      ]);
      // No board is named for these, so there is no `<rating>` to hang them off.
      expect(programme.extraAttributes).toMatchObject({ advisory: 'Adult Language' });
    });

    it('keeps the ids the service knows it and its series by', () => {
      const programme = built(
        { continued: true },
        { programGUID: 'a-guid', parentGUID: 'series-guid', resourceID: '186614' },
      );

      expect(programme.extraAttributes).toMatchObject({
        programGuid: 'a-guid',
        seriesGuid: 'series-guid',
        resourceId: '186614',
        // It finishes on the next day's schedule, which a one-day guide cannot
        // otherwise tell.
        continued: 'true',
      });
    });

    it('dates a film by the year it was made, since it has no first broadcast', () => {
      // 235 films in a real three-day guide and not one `originalAirDate`
      // between them: without this a film carries no date at all.
      const { originalAirDate: _none, ...undated } = PROGRAM;
      const film = buildProgramme(
        'x',
        schedulesDirectProgramme(AIRING, { ...undated, movie: { year: '1957' } }, station)!,
      ).build();

      expect(film.date).toEqual(new Date('1957-01-01T00:00:00Z'));
    });

    it('prefers the first broadcast to the year when it has both', () => {
      expect(built({}, { movie: { year: '1957' } }).date).toEqual(new Date('2013-11-08T00:00:00Z'));
    });

    it('writes a season the service numbered without an episode', () => {
      const { metadata: _none, ...unnumbered } = PROGRAM;
      const programme = built({}, { ...unnumbered, metadata: [{ Gracenote: { season: 75 } }] });

      // Zero-based, and the dimensions it does not know left empty — which is
      // what `xmltv_ns` is shaped for.
      expect(programme.episodeNum).toContainEqual({ system: 'xmltv_ns', value: '74..' });
    });

    it('writes a movie`s score on the scale it was given on', () => {
      const programme = built(
        {},
        {
          movie: {
            year: '1989',
            qualityRating: [
              { ratingsBody: 'Gracenote', rating: '3', minRating: '1', maxRating: '4' },
            ],
          },
        },
      );

      // The scale is part of the value: `<star-rating>` has no field for it.
      expect(programme.starRating).toEqual([{ value: '3/4', system: 'Gracenote' }]);
    });
  });

  describe('and how it is carried', () => {
    /** What the mapping decided, before the builder turns it into elements. */
    const carried = (extra: Partial<WireAiring>) =>
      schedulesDirectProgramme({ ...AIRING, ...extra }, PROGRAM, station)!.subtitles;

    it('says which language it is subtitled in, which `cc` cannot', () => {
      // On 284 of 305 real airings, where `cc` was on far fewer.
      expect(carried({ subtitledLanguage: ['en-GB'] })).toEqual([
        { type: 'teletext', language: 'en-GB' },
      ]);
      // And reaches the element as a code rather than as English text.
      expect(built({ subtitledLanguage: ['en-GB'] }).subtitles).toEqual([
        { type: 'teletext', language: { value: 'en-GB' } },
      ]);
    });

    // The wire sends one string where the documentation's examples suggest a
    // list. Taken for the other, `und` becomes three subtitle elements reading
    // `u`, `n` and `d` — which is what shipped before a real guide was read.
    it('reads one language as one language, not as three letters', () => {
      expect(carried({ subtitledLanguage: 'en-GB' })).toEqual([
        { type: 'teletext', language: 'en-GB' },
      ]);
    });

    it('says a programme is subtitled without inventing a language called und', () => {
      // ISO 639-2 for "undetermined", and what the service sends on every
      // subtitled airing of a real day.
      expect(carried({ subtitledLanguage: 'und' })).toEqual([{ type: 'teletext' }]);
    });

    it('finds a signed presentation in the audio properties too', () => {
      // Where the flag beside it is not set: 27 real airings said it here and
      // nowhere else, alongside `subtitled`.
      expect(carried({ audioProperties: ['subtitled', 'signed'] })).toEqual([
        { type: 'teletext' },
        { type: 'deaf-signed' },
      ]);
    });

    it('falls back to the audio property when the service named no language', () => {
      // `cc` and nothing else, which is the older half of the wire.
      expect(carried({})).toEqual([{ type: 'teletext' }]);
    });

    it('says a signed presentation in the word the DTD has for it', () => {
      expect(carried({ signed: true, subtitledLanguage: ['en-GB'] })).toEqual([
        { type: 'teletext', language: 'en-GB' },
        { type: 'deaf-signed' },
      ]);
    });

    it('writes where it was made, and where to read about it', () => {
      const programme = built(
        {},
        { country: ['FRA'], officialURL: 'https://example.test/just-mercy' },
      );

      // No language on it: `FRA` is an ISO code, and tagging it `en` would
      // claim it is a word in English.
      expect(programme.country).toEqual([{ value: 'FRA' }]);
      expect(programme.url).toEqual(['https://example.test/just-mercy']);
    });
  });

  describe('and its numbering across vocabularies', () => {
    it('takes an episode from another vocabulary when Gracenote has only a season', () => {
      // Real shape: Gracenote `{ season: 2026 }` beside TVmaze
      // `{ season: 2026, episode: 36, url }`.
      const programme = built(
        {},
        {
          metadata: [
            { TVmaze: { season: 2026, episode: 36, url: 'https://tvmaze.test/36' } },
            { Gracenote: { season: 2026 } },
          ],
        },
      );
      const systems = new Map(programme.episodeNum?.map((one) => [one.system, one.value]) ?? []);

      expect(systems.get('onscreen')).toBe('S2026E36');
      // And the episode page it came with, which is not the programme's own site.
      expect(programme.url).toEqual(['https://tvmaze.test/36']);
    });

    it('refuses to make a number out of two vocabularies` halves', () => {
      const programme = built(
        {},
        {
          metadata: [{ TVmaze: { season: 12, episode: 3 } }, { Gracenote: { season: 2026 } }],
        },
      );
      const systems = new Map(programme.episodeNum?.map((one) => [one.system, one.value]) ?? []);

      // They disagree about the season, so neither is used: a number that is
      // nobody's is worse than none.
      expect(systems.has('onscreen')).toBe(false);
    });
  });

  describe('and its description', () => {
    it('prefers the long one, and falls back to the short', () => {
      // Both, the long one first — the short is separately written, not a
      // truncation, and `keep: { 'programme/desc': 1 }` takes the long one.
      expect(built().desc).toEqual([
        { value: 'A Wall Street executive.', lang: 'en' },
        { value: 'Short one.', lang: 'en' },
      ]);
      // With no language of its own it takes the programme's, which is the
      // station's — text inherits, rather than being labelled twice.
      expect(
        built({}, { descriptions: { description100: [{ description: 'Short one.' }] } }).desc,
      ).toEqual([{ value: 'Short one.', lang: 'en' }]);
    });

    it('writes the same words once, however many places the service wrote them', () => {
      const twice = {
        description1000: [{ descriptionLanguage: 'en', description: 'The same.' }],
        description100: [{ descriptionLanguage: 'en', description: 'The same.' }],
      };

      expect(built({}, { descriptions: twice }).desc).toEqual([{ value: 'The same.', lang: 'en' }]);
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

      expect(normalised.descriptions[0]).toEqual({ value: 'In English.', lang: 'en' });
    });
  });
});

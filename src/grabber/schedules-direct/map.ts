/**
 * Turning what Schedules Direct sends into what XMLTV means.
 *
 * Pure, and its own file: it is the largest part of the adapter and the part
 * with the most small decisions in it, and none of them need a server to be
 * tested. A station or an airing goes in; a `GrabberChannel` or a
 * `ProgrammeBuilder` comes out.
 *
 * Nothing here maps a genre onto the DVB vocabulary, deliberately. The output
 * profiles already alias Gracenote's terms at serialize time — which is where
 * it has to happen, since the same cache serves a `tvheadend` guide and a plain
 * one — so doing it here would be doing it twice, in the half that cannot be
 * changed without refetching.
 */

import { ChannelBuilder, ProgrammeBuilder, type ProgrammeOptions } from '../../xmltv/builder.js';
import { formatDdProgidEpisodeNum, parseDdProgidEpisodeNum } from '../../xmltv/episode-num.js';
import type { GrabberChannel } from '../types.js';
import type { WireAiring, WirePerson, WireProgram, WireStation } from './wire.js';

/**
 * What `tv_grab_zz_sdjson` builds a channel id from, and the two others it
 * offers.
 *
 * A guide built here may well be merged with one built there — the same account,
 * the same stations — so the ids have to agree, and `%s` is the station id for
 * the same reason it is there: it is the only identifier the service guarantees
 * is unique and stable.
 */
export const SCHEDULES_DIRECT_CHANNEL_ID = 'I%s.json.schedulesdirect.org';

/** How a station becomes an id in the guide. */
export type ChannelIdFormat = string | ((station: SchedulesDirectStation) => string);

/** One station of a lineup, as everything downstream sees it. */
export interface SchedulesDirectStation {
  /** The service's own id, which is what its schedules are asked for by. */
  stationID: string;
  name: string;
  callsign?: string;
  /** The network it carries, where it carries one. */
  affiliate?: string;
  /** Where it sits in this lineup, as the lineup's map says. */
  channel?: string;
  /** What it broadcasts in — the default language for its programmes' text. */
  broadcastLanguage?: string;
  /** What its descriptions arrive in, which need not be the same. */
  descriptionLanguage?: string;
  logo?: { url: string; width?: number; height?: number };
  /** Its own site, where it gave one. */
  url?: string;
  /** Where the broadcaster is, which is one way a content rating is chosen. */
  country?: string;
  /** The lineup it came from — `GBR-1000014-DEFAULT`, and so a British guide. */
  lineup?: string;
  isRadioStation?: boolean;
  isCommercialFree?: boolean;
}

/** One person of a programme, normalised. */
export interface SchedulesDirectPerson {
  name: string;
  /** `Actor`, `Director`, `Executive Producer`, … — the service names many. */
  role?: string;
  characterName?: string;
}

/** One airing, with everything known about the programme on it. */
export interface SchedulesDirectProgramme {
  /** The service's own id, which is also a `dd_progid`. */
  programID: string;
  start: Date;
  stop?: Date;
  title: string;
  titleLanguage?: string;
  episodeTitle?: string;
  description?: string;
  descriptionLanguage?: string;
  season?: number;
  episode?: number;
  /** Which part of a multi-part episode this airing is. */
  part?: { number: number; total: number };
  /** First broadcast, as `YYYY-MM-DD`. */
  originalAirDate?: string;
  genres: string[];
  showType?: string;
  entityType?: string;
  /** Where it was made, as ISO-3166 three-letter codes. */
  countries: string[];
  /** Its own page, and the episode page of whichever vocabulary gave one. */
  urls: string[];
  /** A score on its own scale: `3/4`, by `Gracenote`. */
  starRating?: { value: string; system?: string };
  /** The languages it is subtitled in, and whether it is signed. */
  subtitles: { type: string; language?: string }[];
  cast: SchedulesDirectPerson[];
  crew: SchedulesDirectPerson[];
  ratings: { body?: string; code: string; country?: string; warnings?: string[] }[];
  audioProperties: string[];
  videoProperties: string[];
  isNew: boolean;
  /** `Series Premiere`, `Season Finale`, … */
  premiereOrFinale?: string;
  /** `Live`, `Tape` or `Delay`. */
  liveTapeDelay?: string;
  free?: boolean;
  educational?: boolean;
  subjectToBlackout?: boolean;
}

/** How much of what the service sends is worth writing. */
export interface SchedulesDirectMapOptions {
  /**
   * How many of each to keep, in the service's own billing order.
   *
   * It ships whole call sheets — forty names on a film — and unbounded they are
   * most of a guide's bytes, for a field most consumers show three of. `false`
   * leaves credits out altogether.
   */
  credits?: false | { cast?: number | false; crew?: number | false };
  /**
   * Which description to write. `long` prefers the 1000-character one and falls
   * back to the short; `both` writes each, since `<desc>` may repeat.
   */
  descriptions?: 'short' | 'long' | 'both';
  /** What to call the language of a text the service did not label. */
  language?: string;
  /**
   * Whose content ratings to write, as an ISO-3166 three-letter code.
   *
   * The service carries every board's opinion — two dozen countries on a
   * well-known film, of which a British guide wants one. Unset, the station's
   * own country decides, and failing that every rating is written, which is
   * honest but noisy. `false` writes none.
   */
  ratingCountry?: string | false;
  /** See {@link SCHEDULES_DIRECT_CHANNEL_ID}. */
  channelId?: ChannelIdFormat;
  /** Replaces {@link schedulesDirectProgrammeExtras}; `false` writes no extensions. */
  programmeExtras?:
    | false
    | ((element: ProgrammeBuilder, programme: SchedulesDirectProgramme) => void);
  /** Replaces {@link schedulesDirectChannelExtras}; `false` writes no extensions. */
  channelExtras?: false | ((element: ChannelBuilder, station: SchedulesDirectStation) => void);
}

const DEFAULT_CREDITS = { cast: 8, crew: 6 } as const;

/**
 * An `originalAirDate` as XMLTV writes a date.
 *
 * The service sends `2013-11-08`; XMLTV wants `20131108`, and the difference is
 * not cosmetic — read as an XMLTV datetime, `2013-11-08` is a year followed by
 * `-11-08`, which the parser reaches for as a timezone offset and rejects at
 * index 4. Day precision is deliberate too: `<date>` is when a programme was
 * made or first shown, and a first broadcast has no time of day worth claiming.
 */
function asXmltvDay(date: string): string {
  return date.slice(0, 10).replaceAll('-', '');
}

/** The id this station appears under in the guide. */
export function channelIdOf(
  station: SchedulesDirectStation,
  format: ChannelIdFormat = SCHEDULES_DIRECT_CHANNEL_ID,
): string {
  return typeof format === 'function' ? format(station) : format.replace('%s', station.stationID);
}

/** A station and its channel number, as the grabber holds one. */
export function schedulesDirectStation(
  wire: WireStation,
  channel: string | undefined,
  options: SchedulesDirectMapOptions = {},
  lineup?: string,
): GrabberChannel<SchedulesDirectStation> | undefined {
  const stationID = wire.stationID;

  if (stationID === undefined || stationID === '') {
    // Nothing can be asked for on its behalf, so it is not a channel.
    return undefined;
  }

  const logo = wire.logo ?? wire.stationLogo?.[0];
  const station: SchedulesDirectStation = {
    stationID,
    name: wire.name ?? wire.callsign ?? stationID,
    ...(wire.callsign === undefined ? {} : { callsign: wire.callsign }),
    ...(wire.affiliate === undefined ? {} : { affiliate: wire.affiliate }),
    ...(channel === undefined ? {} : { channel }),
    ...(wire.broadcastLanguage?.[0] === undefined
      ? {}
      : { broadcastLanguage: wire.broadcastLanguage[0] }),
    ...(wire.descriptionLanguage?.[0] === undefined
      ? {}
      : { descriptionLanguage: wire.descriptionLanguage[0] }),
    ...(logo?.URL === undefined
      ? {}
      : {
          logo: {
            url: logo.URL,
            ...(logo.width === undefined ? {} : { width: logo.width }),
            ...(logo.height === undefined ? {} : { height: logo.height }),
          },
        }),
    ...(wire.URL === undefined || wire.URL === ''
      ? {}
      : // Upper-cased as often as not on the wire: a host is not case-sensitive
        // but a url in a guide is read by people.
        { url: wire.URL.toLowerCase() }),
    ...(wire.broadcaster?.country === undefined ? {} : { country: wire.broadcaster.country }),
    ...(lineup === undefined ? {} : { lineup }),
    ...(wire.isRadioStation === undefined ? {} : { isRadioStation: wire.isRadioStation }),
    ...(wire.isCommercialFree === undefined ? {} : { isCommercialFree: wire.isCommercialFree }),
  };

  return {
    xmltvId: channelIdOf(station, options.channelId),
    siteId: stationID,
    name: station.name,
    ...(station.broadcastLanguage === undefined ? {} : { lang: station.broadcastLanguage }),
    ...(station.logo === undefined ? {} : { logo: station.logo.url }),
    // The number a box shows it at, which is what `preset` is.
    ...(channel === undefined ? {} : { preset: channel }),
    data: station,
  };
}

/** What the service has no DTD element for, kept as provider extensions. */
export function schedulesDirectChannelExtras(
  element: ChannelBuilder,
  station: SchedulesDirectStation,
): void {
  if (station.url !== undefined) {
    // A DTD element rather than an extension: `<channel>` has had `<url>` all
    // along, and a fifth of stations give one.
    element.url(station.url);
  }

  element.extraAttributes({
    stationId: station.stationID,
    ...(station.callsign === undefined ? {} : { callsign: station.callsign }),
    ...(station.affiliate === undefined ? {} : { affiliate: station.affiliate }),
    ...(station.country === undefined ? {} : { country: station.country }),
    ...(station.isRadioStation === undefined ? {} : { radio: String(station.isRadioStation) }),
    ...(station.isCommercialFree === undefined
      ? {}
      : { commercialFree: String(station.isCommercialFree) }),
  });
}

/** The same for a programme: the service's own ids, and what an airing was. */
export function schedulesDirectProgrammeExtras(
  element: ProgrammeBuilder,
  programme: SchedulesDirectProgramme,
): void {
  element.extraAttributes({
    // Two the DTD has no word for, and both on hundreds of real airings:
    // `dvs` is audio description, `letterbox` is how it is framed — which is
    // not an aspect ratio, whatever it implies about one.
    ...(programme.audioProperties.some((one) => one.toLowerCase() === 'dvs')
      ? { audioDescribed: 'yes' }
      : {}),
    ...(programme.videoProperties.some((one) => one.toLowerCase() === 'letterbox')
      ? { letterbox: 'yes' }
      : {}),
    programId: programme.programID,
    ...(programme.entityType === undefined ? {} : { entityType: programme.entityType }),
    ...(programme.liveTapeDelay === undefined ? {} : { live: programme.liveTapeDelay }),
    ...(programme.free === undefined ? {} : { free: String(programme.free) }),
    ...(programme.educational === undefined ? {} : { educational: String(programme.educational) }),
    ...(programme.subjectToBlackout === undefined
      ? {}
      : { blackout: String(programme.subjectToBlackout) }),
  });
}

/** The first text of a list that has one, preferring the station's language. */
function textOf(
  entries: { description?: string; descriptionLanguage?: string }[] | undefined,
  prefer: string | undefined,
): { value: string; lang?: string } | undefined {
  const usable = entries?.filter((entry) => (entry.description ?? '') !== '') ?? [];
  const wanted =
    prefer === undefined
      ? undefined
      : usable.find((entry) => entry.descriptionLanguage?.startsWith(prefer) === true);
  const chosen = wanted ?? usable[0];

  return chosen === undefined
    ? undefined
    : {
        value: chosen.description!,
        ...(chosen.descriptionLanguage === undefined ? {} : { lang: chosen.descriptionLanguage }),
      };
}

/** The people of one list, in the order the service billed them, capped. */
function people(
  entries: WirePerson[] | undefined,
  limit: number | false | undefined,
): SchedulesDirectPerson[] {
  if (limit === false || entries === undefined) {
    return [];
  }

  return (
    entries
      .filter((entry) => (entry.name ?? '') !== '')
      // `billingOrder` is a zero-padded string, so it sorts correctly as text —
      // but only while the padding holds, and a missing one must not come first.
      .toSorted((left, right) =>
        (left.billingOrder ?? '99').localeCompare(right.billingOrder ?? '99'),
      )
      .slice(0, limit ?? Number.POSITIVE_INFINITY)
      .map((entry) => ({
        name: entry.name!,
        ...(entry.role === undefined ? {} : { role: entry.role }),
        ...(entry.characterName === undefined ? {} : { characterName: entry.characterName }),
      }))
  );
}

/**
 * Whose content rating this station's viewers want.
 *
 * The **lineup** first: `GBR-1000014-DEFAULT` is a British lineup, and a British
 * lineup carrying CNN wants the British rating for it rather than the American
 * one — so where the broadcaster sits is the weaker answer, and only used when
 * the lineup does not say. With neither, nothing is chosen and every rating is
 * written, which is noisy but not a guess.
 */
export function ratingCountryFor(
  station: SchedulesDirectStation | undefined,
  options: SchedulesDirectMapOptions = {},
): string | undefined {
  if (options.ratingCountry === false) {
    return undefined;
  }

  return (
    options.ratingCountry ?? /^([A-Z]{3})-/.exec(station?.lineup ?? '')?.[1] ?? station?.country
  );
}

/** What an `audioProperties` entry has to say about subtitling. */
const TELETEXT = new Set(['cc', 'subtitled']);

/**
 * ISO 639-2 for "we do not know which language", which is what the service
 * sends on every subtitled airing of a real day.
 *
 * It says the airing *is* subtitled, which is worth writing — and says nothing
 * about the language, so writing `und` into a `<language>` would be inventing a
 * language called `und`.
 */
const UNDETERMINED = 'und';

/**
 * The ratings worth writing, of every board's opinion the service holds.
 *
 * A well-known film carries two dozen, from Canada to Indonesia, and a guide
 * wants the one its viewers recognise. The country is the caller's if it named
 * one, else the station's own — and with neither to go on every rating is
 * written, which is noisy but not a guess.
 */
function ratingsOf(
  ratings: { body?: string; code?: string; country?: string; contentWarning?: string[] }[],
  options: SchedulesDirectMapOptions,
  station: SchedulesDirectStation | undefined,
): SchedulesDirectProgramme['ratings'] {
  if (options.ratingCountry === false) {
    return [];
  }

  const wanted = ratingCountryFor(station, options);
  const usable = ratings.filter((rating) => (rating.code ?? '') !== '');
  const mine = wanted === undefined ? [] : usable.filter((rating) => rating.country === wanted);
  // Nothing for this country: the ones that named no country at all, which is
  // what an airing's own `ratings` are and what older data is throughout. A
  // rating with no country is not somebody else's — it is just untagged, and
  // dropping it would lose the only one some programmes have.
  const kept =
    wanted === undefined
      ? usable
      : mine.length > 0
        ? mine
        : usable.filter((rating) => rating.country === undefined);

  return kept.map((rating) => ({
    code: rating.code!,
    ...(rating.body === undefined ? {} : { body: rating.body }),
    ...(rating.country === undefined ? {} : { country: rating.country }),
    ...(rating.contentWarning === undefined || rating.contentWarning.length === 0
      ? {}
      : { warnings: rating.contentWarning }),
  }));
}

/**
 * How this airing is carried for those who cannot hear it.
 *
 * `subtitledLanguage` is on nearly every airing where `cc` is on some, and it
 * says which language as well — so it is the better source, and `cc` only
 * stands in when it is absent. `signed` is its own kind of subtitling, and the
 * DTD has a word for it.
 */
function subtitlesOf(airing: WireAiring): SchedulesDirectProgramme['subtitles'] {
  const out: SchedulesDirectProgramme['subtitles'] = [];
  const said = airing.subtitledLanguage ?? [];
  // One string or a list of them. Taken for the other, `und` becomes three
  // subtitle elements reading `u`, `n` and `d` — which is what a real guide
  // showed before this read the wire rather than the documentation.
  const languages = (typeof said === 'string' ? [said] : said).filter((one) => one !== '');

  for (const language of languages) {
    out.push({
      type: 'teletext',
      // `und` is ISO 639-2 for "undetermined": it says the airing is subtitled
      // and says nothing about the language, so writing it into a `<language>`
      // would be inventing a language called `und`.
      ...(language.toLowerCase() === UNDETERMINED ? {} : { language }),
    });
  }

  const audio = (airing.audioProperties ?? []).map((one) => one.toLowerCase());

  if (out.length === 0 && audio.some((one) => TELETEXT.has(one))) {
    out.push({ type: 'teletext' });
  }

  // Said in two places on the wire, and the one that is populated is not the
  // flag: 27 real airings said `signed` here and nowhere else.
  if (airing.signed === true || audio.includes('signed')) {
    out.push({ type: 'deaf-signed' });
  }

  return out;
}

/**
 * One airing and its programme, normalised.
 *
 * `undefined` when it cannot be written at all: an airing with no start is not
 * an airing, and `<title>` is the one child the DTD requires — which is why a
 * programme the service refused to describe (a `6000`) takes its airing with it
 * rather than becoming a titleless entry.
 */
export function schedulesDirectProgramme(
  airing: WireAiring,
  program: WireProgram | undefined,
  station: SchedulesDirectStation | undefined,
  options: SchedulesDirectMapOptions = {},
): SchedulesDirectProgramme | undefined {
  const at = airing.airDateTime === undefined ? Number.NaN : Date.parse(airing.airDateTime);
  const title = program?.titles?.find((entry) => (entry.title120 ?? '') !== '');

  if (Number.isNaN(at) || title?.title120 === undefined || airing.programID === undefined) {
    return undefined;
  }

  const prefer = options.language ?? station?.descriptionLanguage;
  const long = textOf(program?.descriptions?.description1000, prefer);
  const short = textOf(program?.descriptions?.description100, prefer);
  const description = options.descriptions === 'short' ? (short ?? long) : (long ?? short);
  // Gracenote first, then whatever else numbered it: `TVmaze` turns up beside
  // it and sometimes carries the episode where Gracenote has only the season.
  // Only a vocabulary that gives *both* can stand in, and only when Gracenote
  // gives neither or agrees about the season — two vocabularies' halves make a
  // number that is nobody's.
  const vocabularies = (program?.metadata ?? []).flatMap((entry) => Object.entries(entry));
  const gracenote = vocabularies.find(([name]) => name === 'Gracenote')?.[1];
  const numbering =
    gracenote?.episode !== undefined
      ? gracenote
      : (vocabularies.find(
          ([name, one]) =>
            name !== 'Gracenote' &&
            one.episode !== undefined &&
            one.season !== undefined &&
            (gracenote?.season === undefined || gracenote.season === one.season),
        )?.[1] ?? gracenote);
  const credits = options.credits === false ? false : (options.credits ?? DEFAULT_CREDITS);
  const part = airing.multipart;
  const scored = program?.movie?.qualityRating?.find((one) => (one.rating ?? '') !== '');
  // `3` out of `1` to `4` becomes `3/4`, which is what `<star-rating>` means by
  // a value: the scale is part of the number, not a separate field.
  const quality =
    scored === undefined
      ? undefined
      : {
          value:
            scored.maxRating === undefined
              ? scored.rating!
              : `${scored.rating!}/${scored.maxRating}`,
          ...(scored.ratingsBody === undefined ? {} : { system: scored.ratingsBody }),
        };

  return {
    programID: airing.programID,
    start: new Date(at),
    ...(airing.duration === undefined || airing.duration <= 0
      ? {}
      : { stop: new Date(at + airing.duration * 1000) }),
    title: title.title120,
    ...(title.titleLanguage === undefined ? {} : { titleLanguage: title.titleLanguage }),
    ...(program?.episodeTitle150 === undefined || program.episodeTitle150 === ''
      ? {}
      : { episodeTitle: program.episodeTitle150 }),
    ...(description === undefined
      ? {}
      : {
          description: description.value,
          ...(description.lang === undefined ? {} : { descriptionLanguage: description.lang }),
        }),
    ...(numbering?.season === undefined ? {} : { season: numbering.season }),
    ...(numbering?.episode === undefined ? {} : { episode: numbering.episode }),
    ...(part?.partNumber === undefined || part.totalParts === undefined
      ? {}
      : { part: { number: part.partNumber, total: part.totalParts } }),
    ...(program?.originalAirDate === undefined || program.originalAirDate === ''
      ? {}
      : { originalAirDate: program.originalAirDate }),
    genres: program?.genres?.filter((genre) => genre !== '') ?? [],
    ...(program?.showType === undefined ? {} : { showType: program.showType }),
    ...(program?.entityType === undefined ? {} : { entityType: program.entityType }),
    cast: credits === false ? [] : people(program?.cast, credits.cast),
    crew: credits === false ? [] : people(program?.crew, credits.crew),
    ratings: ratingsOf(
      [...(program?.contentRating ?? []), ...(airing.ratings ?? [])],
      options,
      station,
    ),
    countries: program?.country?.filter((one) => one !== '') ?? [],
    urls: [
      ...(program?.officialURL === undefined || program.officialURL === ''
        ? []
        : [program.officialURL]),
      // The episode page a vocabulary gave, which is a different thing from the
      // programme's own site and worth both.
      ...vocabularies.flatMap(([, one]) => (one.url === undefined ? [] : [one.url])),
    ],
    ...(quality === undefined ? {} : { starRating: quality }),
    subtitles: subtitlesOf(airing),
    audioProperties: airing.audioProperties ?? [],
    videoProperties: airing.videoProperties ?? [],
    isNew: airing.new === true,
    ...(airing.isPremiereOrFinale === undefined
      ? {}
      : { premiereOrFinale: airing.isPremiereOrFinale }),
    ...(airing.liveTapeDelay === undefined ? {} : { liveTapeDelay: airing.liveTapeDelay }),
    ...(airing.free === undefined ? {} : { free: airing.free }),
    ...(airing.educational === undefined ? {} : { educational: airing.educational }),
    ...(airing.subjectToBlackout === undefined
      ? {}
      : { subjectToBlackout: airing.subjectToBlackout }),
  };
}

type CreditElement =
  | 'director'
  | 'writer'
  | 'producer'
  | 'composer'
  | 'editor'
  | 'presenter'
  | 'commentator'
  | 'guest'
  | 'adapter';

/**
 * Which element a crew role belongs on, where the DTD has one.
 *
 * Taken from what the service actually sends rather than from a guess at what
 * it might: a census of three hundred programmes found `Executive Producer`
 * most common of all, then `Writer`, `Producer`, `Director`, `Creator` and
 * `Screenwriter` — and a long tail of `Art Director`, `Casting` and
 * `Cinematography`, which the DTD has nowhere to put and which become
 * extensions rather than being dropped.
 */
const CREW: Record<string, CreditElement> = {
  director: 'director',
  'first assistant director': 'director',
  'voice director': 'director',
  writer: 'writer',
  screenwriter: 'writer',
  creator: 'writer',
  'writer (novel)': 'writer',
  'writer (book)': 'writer',
  producer: 'producer',
  'executive producer': 'producer',
  'consulting producer': 'producer',
  'supervising producer': 'producer',
  'coordinating producer': 'producer',
  'associate producer': 'producer',
  'co-producer': 'producer',
  composer: 'composer',
  music: 'composer',
  'original music': 'composer',
  'original song': 'composer',
  'musical director': 'composer',
  editor: 'editor',
  'film editing': 'editor',
  'film editor': 'editor',
  host: 'presenter',
  presenter: 'presenter',
  anchor: 'presenter',
  narrator: 'commentator',
  commentator: 'commentator',
  adapter: 'adapter',
};

/**
 * The same for a cast role.
 *
 * `Actor` dominates, then `Voice`, `Host`, `Guest Star`, `Self`, `Guest Voice`
 * and `Narrator`. All but the last three are someone playing a part, which is
 * what `<actor>` is for — with a `characterName` where there is one.
 */
const CAST: Record<string, CreditElement> = {
  host: 'presenter',
  narrator: 'commentator',
  guest: 'guest',
};

/** The quality a `videoProperties` entry names, in the DTD's spelling. */
const QUALITY: Record<string, string> = {
  sdtv: 'SDTV',
  hdtv: 'HDTV',
  uhdtv: 'UHDTV',
  '3d': '3D',
};

/** What an `audioProperties` entry means for `<audio><stereo>`. */
const STEREO: Record<string, string> = {
  mono: 'mono',
  stereo: 'stereo',
  surround: 'surround',
  dolby: 'dolby',
  'dolby digital': 'dolby digital',
  atmos: 'surround',
};

/**
 * One programme, as a `<programme>`.
 *
 * The language of the text is the station's, said explicitly rather than left to
 * the builder's default — except for the genres, which are Gracenote's English
 * terms whatever the station broadcasts in. A Spanish station's guide claiming
 * `<category lang="es">Sports</category>` is the kind of wrong that survives
 * review because it looks consistent.
 */
export function buildProgramme(
  channelId: string,
  programme: SchedulesDirectProgramme,
  options: SchedulesDirectMapOptions = {},
): ProgrammeBuilder {
  const lang = programme.titleLanguage ?? options.language;
  const element = ProgrammeBuilder.of(channelId, programme.start, programme.title, {
    ...(lang === undefined ? {} : { lang }),
  } satisfies ProgrammeOptions);

  if (programme.stop !== undefined) {
    element.stop(programme.stop);
  }

  if (programme.episodeTitle !== undefined) {
    element.subTitle(programme.episodeTitle);
  }

  if (programme.description !== undefined) {
    element.desc(programme.description, programme.descriptionLanguage);
  }

  if (programme.season !== undefined && programme.episode !== undefined) {
    // Both `xmltv_ns` and `onscreen`, in one call.
    element.episode(programme.episode, programme.season, {
      ...(programme.part === undefined
        ? {}
        : { part: programme.part.number, parts: programme.part.total }),
    });
  }

  // The service's id *is* a `dd_progid`, which is where the convention came
  // from — but only the part of it that parses as one, and never read for an
  // episode number: the tail of an `EP` id is a broadcast, not an episode.
  const ddProgid = parseDdProgidEpisodeNum(programme.programID);

  if (ddProgid !== undefined) {
    element.episodeNum('dd_progid', formatDdProgidEpisodeNum(ddProgid));
  }

  for (const genre of programme.genres) {
    element.category(genre, 'en');
  }

  if (programme.showType !== undefined) {
    element.category(programme.showType, 'en');
  }

  for (const person of programme.cast) {
    const method = CAST[person.role?.toLowerCase() ?? ''];

    if (method === undefined) {
      element.actor(person.name, {
        ...(person.characterName === undefined ? {} : { role: person.characterName }),
        // A guest star is an actor who is also a guest, and the DTD can say both.
        ...(person.role?.toLowerCase().includes('guest') === true ? { guest: true } : {}),
      });
    } else {
      element[method](person.name);
    }
  }

  for (const person of programme.crew) {
    const method = CREW[person.role?.toLowerCase() ?? ''];

    if (method === undefined) {
      // A role the DTD has no element for — the service names dozens — kept as
      // an extension rather than dropped, since a name is worth more than the
      // schema's opinion of its job title.
      element.creditsExtra({
        name: 'credit',
        ...(person.role === undefined ? {} : { attributes: { role: person.role } }),
        value: person.name,
      });
    } else {
      element[method](person.name);
    }
  }

  if (programme.originalAirDate !== undefined) {
    element.date(asXmltvDay(programme.originalAirDate));
  }

  for (const rating of programme.ratings) {
    element.rating(rating.code, {
      ...(rating.body === undefined ? {} : { system: rating.body }),
      // What the board warned about, which the DTD has no field for and a
      // parental control has every use for.
      ...(rating.warnings === undefined
        ? {}
        : { extra: rating.warnings.map((value) => ({ name: 'warning', value })) }),
    });
  }

  if (programme.starRating !== undefined) {
    element.starRating(programme.starRating.value, {
      ...(programme.starRating.system === undefined ? {} : { system: programme.starRating.system }),
    });
  }

  for (const country of programme.countries) {
    // No language on it: `USA` is an ISO code, and tagging it `en` claims it is
    // a word in English. An empty `lang` is how the builder is told to leave the
    // attribute off entirely.
    element.country(country, '');
  }

  for (const url of programme.urls) {
    element.url(url);
  }

  for (const subtitles of programme.subtitles) {
    element.subtitles({
      type: subtitles.type as 'teletext' | 'deaf-signed',
      // The same as a country: a language tag is a code, not English text.
      ...(subtitles.language === undefined ? {} : { language: subtitles.language, lang: '' }),
    });
  }

  for (const property of programme.videoProperties) {
    const quality = QUALITY[property.toLowerCase()];

    if (quality !== undefined) {
      element.video({ quality });
    }
  }

  for (const property of programme.audioProperties) {
    const stereo = STEREO[property.toLowerCase()];

    if (stereo !== undefined) {
      element.audio({ stereo });
    }
  }

  if (programme.isNew) {
    element.new();
  } else if (programme.originalAirDate !== undefined) {
    // Not new and first shown on a day the service named: a repeat of something
    // datable, which is what `previously-shown` says.
    element.previouslyShown({ start: asXmltvDay(programme.originalAirDate) });
  }

  if (programme.premiereOrFinale !== undefined) {
    if (programme.premiereOrFinale.toLowerCase().includes('finale')) {
      element.lastChance(programme.premiereOrFinale);
    } else {
      element.premiere(programme.premiereOrFinale);
    }
  }

  const extras = options.programmeExtras ?? schedulesDirectProgrammeExtras;

  if (extras !== false) {
    extras(element, programme);
  }

  return element;
}

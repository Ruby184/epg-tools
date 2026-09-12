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
  cast: SchedulesDirectPerson[];
  crew: SchedulesDirectPerson[];
  ratings: { body?: string; code: string }[];
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
  element.extraAttributes({
    stationId: station.stationID,
    ...(station.callsign === undefined ? {} : { callsign: station.callsign }),
    ...(station.affiliate === undefined ? {} : { affiliate: station.affiliate }),
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
  const gracenote = program?.metadata?.find((entry) => entry['Gracenote'] !== undefined)?.[
    'Gracenote'
  ];
  const credits = options.credits === false ? false : (options.credits ?? DEFAULT_CREDITS);
  const part = airing.multipart;

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
    ...(gracenote?.season === undefined ? {} : { season: gracenote.season }),
    ...(gracenote?.episode === undefined ? {} : { episode: gracenote.episode }),
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
    ratings: [...(program?.contentRating ?? []), ...(airing.ratings ?? [])]
      .filter((rating) => (rating.code ?? '') !== '')
      .map((rating) => ({
        code: rating.code!,
        ...(rating.body === undefined ? {} : { body: rating.body }),
      })),
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

/** Which builder method a crew role belongs on, where the DTD has one. */
const CREW: Record<
  string,
  | 'director'
  | 'writer'
  | 'producer'
  | 'composer'
  | 'editor'
  | 'presenter'
  | 'commentator'
  | 'adapter'
> = {
  director: 'director',
  writer: 'writer',
  producer: 'producer',
  'executive producer': 'producer',
  composer: 'composer',
  'musical director': 'composer',
  editor: 'editor',
  'film editor': 'editor',
  host: 'presenter',
  presenter: 'presenter',
  anchor: 'presenter',
  narrator: 'commentator',
  commentator: 'commentator',
  adapter: 'adapter',
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
    element.actor(person.name, {
      ...(person.characterName === undefined ? {} : { role: person.characterName }),
    });
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
    element.rating(rating.code, { ...(rating.body === undefined ? {} : { system: rating.body }) });
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

    if (property.toLowerCase() === 'cc' || property.toLowerCase() === 'subtitled') {
      element.subtitles({ type: 'teletext' });
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

/**
 * What Schedules Direct's JSON service actually sends, and what its codes mean.
 *
 * Declared apart from the adapter because there is a lot of it and because the
 * test fixture answers with these very shapes — one declaration, so a stand-in
 * server cannot drift from what the client expects. Only the fields this package
 * reads are here: the service sends a good deal more, and a field nobody reads is
 * a claim nobody checks.
 *
 * Everything the service can leave out is optional, which is nearly everything —
 * the wire is reconstructed from its own documentation and its clients, so the
 * types say "may not be there" wherever the docs do not promise otherwise, and
 * the normalising happens on the way out of here.
 *
 * @see https://github.com/SchedulesDirect/JSON-Service/wiki/API-20141201
 */

/**
 * The service, and the version of it this package speaks.
 *
 * Pinned in the default rather than assembled from a version option, so moving
 * to another one is a visible edit. It is a `ky` prefix, so the trailing slash
 * is optional — but it is written here, since the version is a path segment and
 * a reader should not have to know that to see it.
 */
export const SCHEDULES_DIRECT_URL = 'https://json.schedulesdirect.org/20141201/';

/**
 * The codes this adapter acts on, rather than every code there is.
 *
 * They arrive at HTTP 200 as often as not — a refused account, a station-day
 * outside the window and a programme still being generated are all "successful"
 * responses carrying a non-zero `code`, which is why every answer is read for
 * one rather than trusted because it parsed.
 */
export const SD_OK = 0;
/** The account has run out. Fatal for the site: nothing will be served. */
export const SD_ACCOUNT_EXPIRED = 4001;
/** Wrong username or password. Fatal, and said in the service's own words. */
export const SD_INVALID_ACCOUNT = 4003;
/** Too many failed logins; the account is locked for a while. Fatal. */
export const SD_ACCOUNT_LOCKOUT = 4004;
/** The token has expired — re-authenticate once and replay the call. */
export const SD_TOKEN_EXPIRED = 4006;
/** A programme id the service will never know. Drop the airing. */
export const SD_PROGRAM_INVALID = 6000;
/** A programme the service is still generating. Worth asking again, once. */
export const SD_PROGRAM_QUEUED = 6001;
/** A day outside what this station has. Carries `minDate`/`maxDate`. */
export const SD_DATE_OUT_OF_RANGE = 7020;
/** A schedule queued for generation: not missing, not ready. */
export const SD_SCHEDULE_QUEUED = 7100;

/** What every answer may carry, whatever else is in it. */
export interface WireResponse {
  code?: number;
  message?: string;
  response?: string;
  /** On {@link SD_DATE_OUT_OF_RANGE}: the window this station does have. */
  minDate?: string;
  maxDate?: string;
}

/** `POST /token`. */
export interface WireToken extends WireResponse {
  token?: string;
  /** Epoch **seconds**, which is what the service sends and what it documents. */
  tokenExpires?: number;
}

/** One lineup on the account, as `GET /status` lists it. */
export interface WireAccountLineup {
  lineup?: string;
  /** What a person calls it — `Freeview` for `GBR-1000014-DEFAULT`. */
  name?: string;
  /** When the lineup itself last changed — not its schedules. */
  modified?: string;
  uri?: string;
}

/** `GET /status`: the account, and what it is subscribed to. */
export interface WireStatus extends WireResponse {
  account?: {
    /** When the subscription runs out, as an ISO timestamp. */
    expires?: string;
    /** Notices from the service, worth passing on to whoever is watching. */
    messages?: { message?: string; date?: string }[];
    maxLineups?: number;
  };
  lineups?: WireAccountLineup[];
  /**
   * How the service says it is, which its own documentation asks clients to
   * read: `Online` when all is well, and something else when a run is about to
   * go badly for reasons that are nobody's fault locally.
   */
  systemStatus?: { date?: string; status?: string; message?: string }[];
}

/** A station's logo, which carries its own dimensions. */
export interface WireLogo {
  URL?: string;
  width?: number;
  height?: number;
  md5?: string;
}

/** One station of a lineup. */
export interface WireStation {
  stationID?: string;
  name?: string;
  callsign?: string;
  affiliate?: string;
  /** The language it broadcasts in, which is the default for its programmes' text. */
  broadcastLanguage?: string[];
  /** The language its descriptions arrive in, which need not be the same. */
  descriptionLanguage?: string[];
  /** Its own site, upper-cased as often as not: `WWW.BBC.CO.UK`. */
  URL?: string;
  /** Who runs it, and from where — the country is what a rating is chosen by. */
  broadcaster?: { city?: string; state?: string; postalcode?: string; country?: string };
  /** Radio carried on a television lineup, which a guide is entitled to know. */
  isRadioStation?: boolean;
  logo?: WireLogo;
  /** The same logo in `dark`, `light`, `white` and `gray`. */
  stationLogo?: (WireLogo & { category?: string; source?: string })[];
  isCommercialFree?: boolean;
}

/** `GET /lineups/{id}`: which station sits on which channel, and what each one is. */
export interface WireLineup extends WireResponse {
  /** The channel numbers, as a separate list keyed by station. */
  map?: { stationID?: string; channel?: string }[];
  stations?: WireStation[];
}

/**
 * One headend of `GET /headends`, and the lineups it offers.
 *
 * The one call that answers before an account has a lineup on it, which is what
 * makes it the way to find one to add.
 */
export interface WireHeadend extends WireResponse {
  headend?: string;
  /** `Antenna`, `Cable`, `Satellite`, `IPTV`. */
  transport?: string;
  location?: string;
  lineups?: { name?: string; lineup?: string; uri?: string }[];
}

/** One station-day of `POST /schedules/md5`. */
export interface WireMd5 extends WireResponse {
  lastModified?: string;
  md5?: string;
}

/** `POST /schedules/md5`, keyed by station and then by day. */
export type WireMd5Response = Record<string, Record<string, WireMd5> | undefined>;

/** One airing of one station-day. */
export interface WireAiring {
  programID?: string;
  /** The instant it starts, ISO and always UTC. */
  airDateTime?: string;
  /** How long it runs, in seconds. */
  duration?: number;
  /** What this airing hashes to — not the programme's own md5. */
  md5?: string;
  new?: boolean;
  premiere?: boolean;
  repeat?: boolean;
  educational?: boolean;
  subjectToBlackout?: boolean;
  free?: boolean;
  /** `Live`, `Tape` or `Delay`. */
  liveTapeDelay?: string;
  /** `Series Premiere`, `Season Finale`, and the rest of that vocabulary. */
  isPremiereOrFinale?: string;
  audioProperties?: string[];
  videoProperties?: string[];
  /**
   * What it is subtitled in — on nearly every airing, unlike `cc`.
   *
   * A **string** on the wire (`und`, meaning undetermined, on all 425 of a real
   * day's airings), though a list is the shape its own examples suggest. Read as
   * either, since one of them iterates into letters if taken for the other.
   */
  subtitledLanguage?: string | string[];
  /** Presented in sign language — said here, and again in `audioProperties`. */
  signed?: boolean;
  ratings?: { body?: string; code?: string; country?: string }[];
  multipart?: { partNumber?: number; totalParts?: number };
  /** It runs past midnight, and the rest of it is on the next day's schedule. */
  continued?: boolean;
  /** The same programme's stable identifier, beside the `programID`. */
  programGUID?: string;
}

/** One station's answer to `POST /schedules`. */
export interface WireSchedule extends WireResponse {
  stationID?: string;
  programs?: WireAiring[];
  metadata?: { modified?: string; md5?: string; startDate?: string; days?: number };
}

/** One person of a programme's cast or crew. */
export interface WirePerson {
  personId?: string;
  name?: string;
  role?: string;
  characterName?: string;
  /** Zero-padded, and a string: `"01"` comes before `"10"` only by number. */
  billingOrder?: string;
}

/** `POST /programs`: everything about a programme that is not about an airing. */
export interface WireProgram extends WireResponse {
  programID?: string;
  titles?: { title120?: string; titleLanguage?: string }[];
  episodeTitle150?: string;
  descriptions?: {
    description100?: { descriptionLanguage?: string; description?: string }[];
    description1000?: { descriptionLanguage?: string; description?: string }[];
  };
  originalAirDate?: string;
  genres?: string[];
  /** `Series`, `Movie`, `Sports event`, … */
  showType?: string;
  /** `Episode`, `Show`, `Movie`, `Sports`, … */
  entityType?: string;
  /**
   * Where the season and episode live, and why this is an array of one-key
   * objects: the service keys it by the vocabulary that assigned the numbers.
   * `Gracenote` is the usual one and `TVmaze` turns up beside it — sometimes
   * with an episode where Gracenote has only a season.
   */
  metadata?: Record<
    string,
    { season?: number; episode?: number; totalEpisodes?: number; url?: string }
  >[];
  /** Where it was made, as ISO-3166 three-letter codes. */
  country?: string[];
  /** How long the programme is, in seconds — not how long this airing of it is. */
  duration?: number;
  cast?: WirePerson[];
  crew?: WirePerson[];
  /**
   * Every board's opinion, from every country the service covers — two dozen of
   * them on a well-known film. Which is why one is chosen by country rather than
   * all of them written out.
   */
  contentRating?: {
    body?: string;
    code?: string;
    country?: string;
    /** Why the board rated it so — `Violence`, `Linguagem Imprópria`. */
    contentWarning?: string[];
    /** The same in the board's own shorthand — `Dialog`, `Adult Situations`. */
    contentAdvisory?: string[];
  }[];
  movie?: {
    year?: string;
    duration?: number;
    /** A score with its own scale — `3` of `1` to `4`, by `Gracenote`. */
    qualityRating?: {
      ratingsBody?: string;
      rating?: string;
      minRating?: string;
      maxRating?: string;
      increment?: string;
    }[];
  };
  /** The programme's own page, where it has one. */
  officialURL?: string;
  /** Advisories no board is named for — `Adult Language`, `Graphic Violence`. */
  contentAdvisory?: string[];
  /** That it is animated, and how — `Animated`, `Anime`, `Live Action/Animated`. */
  animation?: string;
  /** The occasion it is shown for — `Halloween`, `Christmas`. */
  holiday?: string;
  /** This programme's stable identifier; `parentGUID` is its series'. */
  programGUID?: string;
  parentGUID?: string;
  /** Gracenote's own id for the thing behind it, shared by every episode. */
  resourceID?: string;
  /**
   * That artwork exists for it, which is what saves asking about the ones with
   * none — on all 500 programmes of a real day, in the case of the first.
   */
  hasImageArtwork?: boolean;
  hasMovieArtwork?: boolean;
  hasSeriesArtwork?: boolean;
  hasSeasonArtwork?: boolean;
  hasEpisodeArtwork?: boolean;
  md5?: string;
}

/** One image of one programme. */
export interface WireImage {
  /** A bare filename as often as a url — see {@link imageUrl}. */
  uri?: string;
  width?: number | string;
  height?: number | string;
  /** `Iconic`, `Poster Art`, `Banner-L1`, … — see `IMAGE_TYPES` in `map.ts`. */
  category?: string;
  /**
   * How specific it is: `Episode`, `Season`, `Series`.
   *
   * Absent on some — 702 of 15,927 in a census of 400 real programmes — which
   * is why it does not decide whether an image is kept.
   */
  tier?: string;
  /** `2x3`, `16x9`, `1x1`. {@link ratio} is the same thing written `2:3`. */
  aspect?: string;
  ratio?: string;
  /** When the picture last changed, ISO. Not every answer carries one. */
  lastUpdate?: string;
  /** Documented, and absent from every image of a 15,927-image census. */
  size?: string;
  primary?: string;
}

/**
 * `POST /metadata/programs/`, one entry per programme asked about.
 *
 * The refusal is **inside `data`**, not beside it: a programme whose artwork
 * the service cannot find answers `{ programID, data: { code: 6000, … } }`,
 * with no code on the entry itself. 11 of 300 real programmes that said they
 * had artwork came back like this, so it is the ordinary case rather than the
 * exceptional one — and reading `data` as a list without looking would throw.
 */
export interface WireArtwork extends WireResponse {
  programID?: string;
  data?: WireImage[] | WireResponse;
}

/**
 * The code an answer carries, or {@link SD_OK} when it carries none.
 *
 * An answer with no `code` is the normal successful shape for the endpoints that
 * return a list, so absence has to read as success rather than as a problem —
 * while an answer that is not an object at all (a proxy's error page that parsed
 * as JSON somehow) is not success and must not read as it.
 */
export function codeOf(payload: unknown): number {
  if (payload === null || typeof payload !== 'object') {
    return Number.NaN;
  }

  const code = (payload as WireResponse).code;

  return code === undefined ? SD_OK : code;
}

/** Whether this answer says something went wrong. */
export function isWireError(payload: unknown): boolean {
  return codeOf(payload) !== SD_OK;
}

/**
 * What the service said, as a sentence — its own words where it gave any.
 *
 * `message` is where the useful half lives (`"Invalid username or password."`),
 * and the code is kept beside it because the message is sometimes only `"ERROR"`.
 */
export function wireMessage(payload: unknown): string {
  const code = codeOf(payload);
  const said =
    payload !== null && typeof payload === 'object' ? (payload as WireResponse).message : undefined;

  return said === undefined || said === ''
    ? `code ${String(code)}`
    : `${said} (code ${String(code)})`;
}

/**
 * A base url with the trailing slash resolution needs.
 *
 * Without one the last segment is resolved *away* — `…/20141201` and `image/`
 * make `/image/`, losing the version — and a base is a `ky` prefix everywhere
 * else here, where the slash is optional. So both functions below put it back
 * rather than trusting whoever built the base.
 */
function ending(url: URL | string): string {
  const href = typeof url === 'string' ? url : url.href;

  return href.endsWith('/') ? href : `${href}/`;
}

/** Where this service's images live, for a relative `uri` to be resolved against. */
export function imageBase(url: URL | string = SCHEDULES_DIRECT_URL): URL {
  return new URL('image/', ending(url));
}

/**
 * An image's `uri` as something a consumer can fetch.
 *
 * `/metadata/programs` answers with a bare filename far more often than with a
 * url, and an `<icon src="a1b2….jpg">` resolves nowhere. Resolving rather than
 * concatenating is what makes one function do both: a relative uri lands under
 * the image path, and an absolute one — the other half of the service's answers
 * — wins over the base and is handed back as it came.
 *
 * A site pointed at a mirror passes `imageBase(url)`, so its images come from
 * the mirror too.
 */
export function imageUrl(uri: string, base: URL | string = imageBase()): string {
  try {
    return new URL(uri, ending(base)).href;
  } catch {
    // Neither a url nor a path: handed back unchanged, as a playlist's stream
    // urls are. This is a guide, not a validator.
    return uri;
  }
}

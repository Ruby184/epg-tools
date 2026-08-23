/**
 * XMLTV data model, following the XMLTV DTD
 * (https://github.com/XMLTV/xmltv/blob/master/xmltv.dtd).
 *
 * Text elements that can repeat per language are modeled as arrays of
 * {@link XmltvTextValue} so multi-language guides can be represented and
 * merged.
 */

import type { XmltvDate, XmltvTimezoneOffsets } from './date.js';

/**
 * Carried by every element that can have non-DTD extension attributes —
 * e.g. `eit` codes on `<category>`, `uniqueID` on `<programme>`.
 */
export interface XmltvExtraAttributes {
  /** Non-DTD extension attributes, preserved through parse/serialize. */
  extraAttributes?: Record<string, string>;
}

/**
 * A non-DTD extension element, preserved verbatim through parse/serialize
 * so consumers like tvheadend can extract provider extensions via XPath —
 * e.g. `<crid><series>…</series><episode>…</episode></crid>` or `<live/>`.
 */
export interface XmltvExtraElement {
  name: string;
  attributes?: Record<string, string>;
  value?: string;
  children?: XmltvExtraElement[];
}

/**
 * Carried by elements whose DTD content model allows unknown child
 * elements after the known ones — e.g. `<lcn>` after a channel's `<url>`,
 * `<crid>`/`<live/>` after a programme's `<image>`.
 */
export interface XmltvExtraElements extends XmltvExtraAttributes {
  /** Non-DTD child elements, preserved through parse/serialize. */
  extra?: XmltvExtraElement[];
}

/** A text element with an optional `lang` attribute. */
export interface XmltvTextValue extends XmltvExtraAttributes {
  value: string;
  lang?: string;
}

export interface XmltvIcon extends XmltvExtraAttributes {
  src: string;
  width?: number;
  height?: number;
}

/** A `<url>` element; an object form carries the optional `system` attribute. */
export interface XmltvUrl extends XmltvExtraAttributes {
  value: string;
  system?: string;
}

/** `<url>` content: plain string, or {@link XmltvUrl} when `system` is set. */
export type XmltvUrlValue = string | XmltvUrl;

export interface XmltvChannel extends XmltvExtraElements {
  id: string;
  displayName: XmltvTextValue[];
  icon?: XmltvIcon[];
  url?: XmltvUrlValue[];
}

export interface XmltvEpisodeNum extends XmltvExtraAttributes {
  system?: string;
  value: string;
}

/**
 * A credits person. The DTD allows `<image>` and `<url>` children inside
 * every credit element (`(#PCDATA | image | url)*`).
 */
export interface XmltvPerson extends XmltvExtraElements {
  value: string;
  image?: XmltvImage[];
  url?: XmltvUrlValue[];
}

/** Credit entry: plain string, or {@link XmltvPerson} with image/url children. */
export type XmltvPersonValue = string | XmltvPerson;

export interface XmltvActor extends XmltvPerson {
  role?: string;
  guest?: boolean;
}

export interface XmltvCredits {
  director?: XmltvPersonValue[];
  actor?: XmltvActor[];
  writer?: XmltvPersonValue[];
  adapter?: XmltvPersonValue[];
  producer?: XmltvPersonValue[];
  composer?: XmltvPersonValue[];
  editor?: XmltvPersonValue[];
  presenter?: XmltvPersonValue[];
  commentator?: XmltvPersonValue[];
  guest?: XmltvPersonValue[];
  /** Non-DTD extension elements found among the credit entries. */
  extra?: XmltvExtraElement[];
}

export interface XmltvLength extends XmltvExtraAttributes {
  units: 'seconds' | 'minutes' | 'hours';
  value: number;
}

export interface XmltvSubtitles extends XmltvExtraElements {
  type?: 'teletext' | 'onscreen' | 'deaf-signed';
  language?: XmltvTextValue;
}

export interface XmltvRating extends XmltvExtraElements {
  system?: string;
  value: string;
  icon?: XmltvIcon[];
}

export interface XmltvStarRating extends XmltvExtraElements {
  system?: string;
  value: string;
  icon?: XmltvIcon[];
}

export interface XmltvReview extends XmltvExtraAttributes {
  type: 'text' | 'url';
  source?: string;
  reviewer?: string;
  lang?: string;
  value: string;
}

export interface XmltvImage extends XmltvExtraAttributes {
  type?: 'poster' | 'backdrop' | 'still' | 'person' | 'character';
  /** `1` = small, `2` = medium, `3` = large. */
  size?: '1' | '2' | '3';
  /** `P` = portrait, `L` = landscape. */
  orient?: 'P' | 'L';
  system?: string;
  value: string;
}

export interface XmltvPreviouslyShown extends XmltvExtraAttributes {
  start?: XmltvDate;
  channel?: string;
}

/** `<video>` details; `present`/`colour` map yes/no to booleans. */
export interface XmltvVideo extends XmltvExtraElements {
  present?: boolean;
  colour?: boolean;
  /** e.g. `16:9` */
  aspect?: string;
  /** e.g. `HDTV` */
  quality?: string;
}

/** `<audio>` details; `present` maps yes/no to a boolean. */
export interface XmltvAudio extends XmltvExtraElements {
  present?: boolean;
  /** e.g. `stereo`, `dolby digital`, `surround` */
  stereo?: string;
}

export interface XmltvProgramme extends XmltvExtraElements {
  channel: string;
  start: XmltvDate;
  stop?: XmltvDate;
  /** PDC broadcast start time (`pdc-start` attribute). */
  pdcStart?: XmltvDate;
  /** VPS broadcast start time (`vps-start` attribute). */
  vpsStart?: XmltvDate;
  showview?: string;
  videoplus?: string;
  /** Clump index for shared timeslots, e.g. `0/2`. */
  clumpidx?: string;
  title: XmltvTextValue[];
  subTitle?: XmltvTextValue[];
  desc?: XmltvTextValue[];
  credits?: XmltvCredits;
  /** Production/copyright date (`<date>`), e.g. `1999` or `20260807` — no timezone. */
  date?: XmltvDate;
  category?: XmltvTextValue[];
  keyword?: XmltvTextValue[];
  language?: XmltvTextValue;
  origLanguage?: XmltvTextValue;
  length?: XmltvLength;
  icon?: XmltvIcon[];
  url?: XmltvUrlValue[];
  country?: XmltvTextValue[];
  episodeNum?: XmltvEpisodeNum[];
  video?: XmltvVideo;
  audio?: XmltvAudio;
  previouslyShown?: XmltvPreviouslyShown;
  premiere?: XmltvTextValue | true;
  lastChance?: XmltvTextValue | true;
  /** `<new/>` flag. Only a truthy value is serialized, so `false` emits no tag. */
  new?: boolean;
  subtitles?: XmltvSubtitles[];
  rating?: XmltvRating[];
  starRating?: XmltvStarRating[];
  review?: XmltvReview[];
  image?: XmltvImage[];
}

/** Attributes for the root `<tv>` element. */
export interface XmltvDocumentMeta extends XmltvExtraAttributes {
  date?: XmltvDate;
  sourceInfoName?: string;
  sourceInfoUrl?: string;
  sourceDataUrl?: string;
  generatorInfoName?: string;
  generatorInfoUrl?: string;
}

/**
 * A non-fatal problem encountered while parsing, emitted as a `warning`
 * event in the parse stream. Parsing always continues: a programme with a
 * missing/invalid `start` is skipped, bad attribute values are dropped,
 * malformed markup is stepped over, truncated input is reported.
 */
export interface XmltvWarning {
  code:
    | 'invalid-programme'
    | 'invalid-attribute'
    | 'invalid-element'
    | 'malformed-markup'
    | 'unknown-element'
    | 'truncated-input';
  message: string;
  /** 1-based line of the construct the warning is anchored to. */
  line: number;
  /** 1-based column (in characters) on that line. */
  col: number;
}

/**
 * Where a processing instruction sits relative to the root `<tv>` element —
 * the three places XML allows one at the top level.
 *
 * `prolog` is before the root (after the XML declaration, which must come
 * first), `root` is inside it among the channels and programmes, and `epilog`
 * is after the closing tag. The parser reports where it found one and the
 * serializer puts it back there.
 */
export type XmltvProcessingInstructionPosition = 'prolog' | 'root' | 'epilog';

/**
 * A processing instruction — `<?target data?>` — as XML's way of carrying
 * something for one particular reader past every other one.
 *
 * Not part of XMLTV, and not constrained by its DTD, which is the point: a
 * document can say something to whoever understands the target and stay a valid
 * XMLTV document to everyone else. The XML declaration is not one of these.
 *
 * `data` is whatever stood between the target and the `?>`, verbatim: XML
 * recognizes no markup and no entities in there, so nothing is decoded on the
 * way in and nothing may be escaped on the way out.
 */
export interface XmltvProcessingInstruction {
  target: string;
  data: string;
  /**
   * Required, because it is the whole of where this goes: an instruction whose
   * position went unsaid would be placed by a default rather than by intent,
   * and a document that came from a parse would be written back somewhere else.
   * {@link XmltvDocumentBuilder.processingInstruction} defaults it to `root`
   * for the common case, which is the place to be brief about it.
   */
  position: XmltvProcessingInstructionPosition;
}

/** Event emitted by the streaming parser. */
export type XmltvParseEvent =
  | { type: 'meta'; value: XmltvDocumentMeta }
  | { type: 'processing-instruction'; value: XmltvProcessingInstruction }
  | { type: 'channel'; value: XmltvChannel }
  | { type: 'programme'; value: XmltvProgramme }
  | { type: 'warning'; value: XmltvWarning };

/** A fully materialized XMLTV document — the whole-document counterpart to `parseXmltvStream`. */
export interface XmltvDocument {
  meta: XmltvDocumentMeta;
  /** Processing instructions, in the order they appeared. */
  processingInstructions: XmltvProcessingInstruction[];
  channels: XmltvChannel[];
  programmes: XmltvProgramme[];
  /** Non-fatal problems encountered while parsing; see {@link XmltvWarning}. */
  warnings: XmltvWarning[];
}

export type AnyIterable<T> = Iterable<T> | AsyncIterable<T>;

/** Options shared by every parse entry point. */
export interface XmltvParseOptions {
  /**
   * The DTD marks `<channel id>` and `<programme channel>` as `#REQUIRED`, so
   * by default an element missing its key is dropped with a warning (like a
   * `<programme>` missing `start`). Set this to keep such elements instead,
   * with the missing attribute left as an empty string — handy for
   * single-channel feeds that omit the reference on every programme, leaving
   * the merge layer to fill in the one known channel. Default: `false`.
   */
  tolerateMissingId?: boolean;

  /**
   * Maximum number of characters buffered while searching for the root
   * `<tv>` element before giving up with a `TypeError`. Guards against
   * unbounded buffering of a non-XML or headerless stream; raise it for
   * documents with an unusually large preamble, or lower it to fail faster
   * on untrusted input. Default: `1_048_576` (1 MiB).
   */
  rootScanLimit?: number;

  /**
   * Named timezone abbreviations → UTC offset in minutes (UPPERCASE keys),
   * e.g. `{ BST: 60, CET: 60, CEST: 120 }`. `GMT`/`UTC`/`UT`/`Z` are always
   * understood; any other named zone in a datetime must be listed here or the
   * value is dropped with an `invalid-*` warning naming the unknown zone — so
   * an unmapped abbreviation is surfaced and fixed rather than silently
   * assumed to be UTC. Numeric `±HHMM` offsets never need this.
   */
  timezones?: XmltvTimezoneOffsets;
}

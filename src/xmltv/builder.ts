import { Readable } from 'node:stream';
import { xmltvDate } from './date.js';
import type { DateInput, XmltvDateOptions } from './date.js';
import {
  serializeChannel,
  serializeDocumentFooter,
  serializeDocumentHeader,
  serializeProgramme,
  writeXmltvStream,
} from './serialize.js';
import type { SerializeOptions, XmltvStreamInput } from './serialize.js';
import type {
  XmltvActor,
  XmltvAudio,
  XmltvChannel,
  XmltvCredits,
  XmltvDocumentMeta,
  XmltvEpisodeNum,
  XmltvExtraAttributes,
  XmltvExtraElement,
  XmltvExtraElements,
  XmltvIcon,
  XmltvImage,
  XmltvLength,
  XmltvParseEvent,
  XmltvPerson,
  XmltvPersonValue,
  XmltvPreviouslyShown,
  XmltvProgramme,
  XmltvRating,
  XmltvReview,
  XmltvSubtitles,
  XmltvTextValue,
  XmltvUrl,
  XmltvUrlValue,
  XmltvVideo,
} from './types.js';

type Many<T> = T | T[];
type YesNo = boolean | 'yes' | 'no';

/** Non-standard attributes to emit verbatim on an element (mirrors {@link XmltvExtraAttributes}). */
type ExtraAttributes = Record<string, string>;

export interface ImageOptions {
  type?: XmltvImage['type'];
  size?: XmltvImage['size'];
  orient?: XmltvImage['orient'];
  system?: string;
  /** For nested use (a credit's `image`), where there's no positional argument for it. */
  extraAttributes?: ExtraAttributes;
}

export interface UrlOptions {
  system?: string;
  /** For nested use (a credit's `url`), where there's no positional argument for it. */
  extraAttributes?: ExtraAttributes;
}

/** A text child reached only by nesting, where there is no positional argument. */
export interface TextOptions {
  lang?: string;
  extraAttributes?: ExtraAttributes;
}

export interface IconOptions {
  width?: number;
  height?: number;
  /** For nested use (a rating's `icon`), where there's no positional argument for it. */
  extraAttributes?: ExtraAttributes;
}

export interface PersonOptions {
  image?: Many<string | [string, ImageOptions]>;
  url?: Many<string | [string, UrlOptions]>;
  /** Non-DTD child elements of this credit, kept verbatim. */
  extra?: Many<XmltvExtraElement>;
}

export interface ActorOptions extends PersonOptions {
  role?: string;
  guest?: YesNo;
}

type PersonRole = Exclude<keyof XmltvCredits, 'actor'>;

export interface ProgrammeBuilderBase {
  channel: string;
  start: DateInput;
  stop?: DateInput;
  pdcStart?: DateInput;
  vpsStart?: DateInput;
  showview?: string;
  videoplus?: string;
  clumpidx?: string;
  /** The first `<title>`; the tuple form carries its own lang and attributes. */
  title: string | [string, TextOptions];
  /** Default `lang` applied by every method below unless it's given its own. */
  lang?: string;
}

/** The optional {@link ProgrammeBuilderBase} fields — the trailing arg of the positional constructor. */
export type ProgrammeOptions = Omit<ProgrammeBuilderBase, 'channel' | 'start' | 'title'>;

export interface ChannelBuilderBase {
  id: string;
  /** The first `<display-name>`; the tuple form carries its own lang and attributes. */
  displayName: string | [string, TextOptions];
  /** Default `lang` applied to display names unless one is given its own. */
  lang?: string;
}

export interface VideoOptions {
  present?: YesNo;
  colour?: YesNo;
  aspect?: string;
  quality?: string;
  /** Non-DTD child elements of `<video>`, kept verbatim. Appended across calls. */
  extra?: Many<XmltvExtraElement>;
}

export interface AudioOptions {
  present?: YesNo;
  stereo?: string;
  /** Non-DTD child elements of `<audio>`, kept verbatim. Appended across calls. */
  extra?: Many<XmltvExtraElement>;
}

export interface PreviouslyShownOptions {
  start?: DateInput;
  channel?: string;
}

export interface SubtitlesOptions {
  type?: XmltvSubtitles['type'];
  /** The `<language>` child; the tuple form carries its own attributes. */
  language?: string | [string, TextOptions];
  lang?: string;
  /** Non-DTD child elements of `<subtitles>`, kept verbatim. */
  extra?: Many<XmltvExtraElement>;
}

export interface RatingOptions {
  system?: string;
  icon?: Many<string | [string, IconOptions]>;
  /** Non-DTD child elements of the rating, kept verbatim. */
  extra?: Many<XmltvExtraElement>;
}

export interface ReviewOptions {
  source?: string;
  reviewer?: string;
  lang?: string;
}

/** Extra `xmltv_ns` dimensions for {@link ProgrammeBuilder.episode} beyond season/episode. */
export interface EpisodeOptions {
  /** Total episodes in the season — emits the `episode/total` form. */
  episodes?: number;
  /** Total number of seasons — emits the `season/total` form. */
  seasons?: number;
  /** 1-based part within a multi-part episode (default `1`). */
  part?: number;
  /** Total parts in the episode (default `1`). */
  parts?: number;
}

/**
 * Base for anything that carries non-standard attributes on a single node —
 * an element ({@link ProgrammeBuilder}, {@link ChannelBuilder}) or the root
 * `<tv>` ({@link XmltvDocumentBuilder}). Subclasses point {@link extraAttributesTarget}
 * at the node they build; the merge behaviour lives here once.
 */
abstract class ExtraAttributesBuilder {
  /** The node whose `extraAttributes` the methods below merge into. */
  protected abstract get extraAttributesTarget(): XmltvExtraAttributes;

  /**
   * Combine an element's two extra-attribute sources — a positional argument
   * and its options' `extraAttributes` — with `primary` winning per key.
   *
   * An entry with no value is dropped, and a result with none left is
   * `undefined`: `{}` is truthy, so storing one would keep a `<url>` or a
   * credit name in its object form instead of collapsing to a plain string.
   */
  protected mergeExtra(
    primary?: ExtraAttributes,
    fallback?: ExtraAttributes,
  ): ExtraAttributes | undefined {
    // Filtered before merging, so a valueless entry cannot overwrite the other
    // source. `null` is off the type but reachable from JS and from JSON.
    const present = (attrs: ExtraAttributes | undefined): [string, string][] =>
      Object.entries(attrs ?? {}).filter(([, value]) => value !== undefined && value !== null);

    const merged = [...present(fallback), ...present(primary)];

    return merged.length > 0 ? Object.fromEntries(merged) : undefined;
  }

  /** Merges non-standard attributes onto this builder's node (later calls win per key). */
  extraAttributes(attrs: ExtraAttributes): this {
    const target = this.extraAttributesTarget;
    const merged = this.mergeExtra(attrs, target.extraAttributes);

    if (merged) target.extraAttributes = merged;

    return this;
  }

  /** Sets a single non-standard attribute (merges with any already set). */
  extraAttribute(name: string, value: string): this {
    return this.extraAttributes({ [name]: value });
  }
}

/**
 * Shared value coercions for the element builders ({@link ProgrammeBuilder},
 * {@link ChannelBuilder}): the default-`lang` text value, `<icon>`/`<url>`
 * children, and the extra-attribute copy — everything both need to turn plain
 * arguments into DTD-shaped nodes.
 */
abstract class XmltvElementBuilder extends ExtraAttributesBuilder {
  protected readonly lang: string | undefined;

  constructor(lang: string | undefined) {
    super();
    this.lang = lang;
  }

  /** Copies non-standard attributes onto a freshly built element. */
  protected extraAttrs<T extends XmltvExtraAttributes>(
    target: T,
    extraAttributes?: ExtraAttributes,
  ): T {
    const attrs = this.mergeExtra(extraAttributes);

    if (attrs) target.extraAttributes = attrs;

    return target;
  }

  /** A text value, applying the builder's default `lang` unless overridden. */
  protected text(value: string, lang?: string, extraAttributes?: ExtraAttributes): XmltvTextValue {
    const resolved = lang ?? this.lang;
    const text: XmltvTextValue = resolved ? { value, lang: resolved } : { value };
    return this.extraAttrs(text, extraAttributes);
  }

  /**
   * A text value from either form a nested or constructor-supplied one can
   * take. `defaultLang` is what to use when the tuple names no language of its
   * own — falling back, as ever, to the builder's.
   */
  protected textValue(input: string | [string, TextOptions], defaultLang?: string): XmltvTextValue {
    const [value, opts]: [string, TextOptions?] = Array.isArray(input) ? input : [input];

    return this.text(value, opts?.lang ?? defaultLang, opts?.extraAttributes);
  }

  protected toIcon(
    value: string,
    opts: IconOptions = {},
    extraAttributes?: ExtraAttributes,
  ): XmltvIcon {
    const icon: XmltvIcon = { src: value };

    if (opts.width !== undefined) icon.width = opts.width;
    if (opts.height !== undefined) icon.height = opts.height;

    return this.extraAttrs(icon, this.mergeExtra(extraAttributes, opts.extraAttributes));
  }

  protected toUrlValue(
    value: string,
    opts: UrlOptions = {},
    extraAttributes?: ExtraAttributes,
  ): XmltvUrlValue {
    const extra = this.mergeExtra(extraAttributes, opts.extraAttributes);

    // Collapse to a bare string only when there's nothing but the URL text.
    if (!opts.system && !extra) {
      return value;
    }

    const url: XmltvUrl = { value };

    if (opts.system) url.system = opts.system;

    return this.extraAttrs(url, extra);
  }
}

/**
 * Fluent helper for building a fully-typed {@link XmltvProgramme}: construct
 * with the required base fields, chain the optional/repeatable ones, and
 * call `build()`. `.episode(episode, season)` is the shortcut most worth
 * having — it generates both the `xmltv_ns` and `onscreen` episode-num
 * entries from plain 1-based season/episode numbers.
 *
 * Every element method takes a trailing `extraAttributes` argument for
 * non-standard attributes on that element; `.extraAttributes()` sets them on
 * the `<programme>` itself. Elements reachable only by nesting (a credit's
 * image/url, a rating's icon) carry them in their options object instead.
 */
export class ProgrammeBuilder extends XmltvElementBuilder {
  readonly #programme: XmltvProgramme;

  /** Positional shorthand for `new ProgrammeBuilder({ channel, start, title, ...options })`. */
  static of(
    channel: string,
    start: DateInput,
    title: string,
    options: ProgrammeOptions = {},
  ): ProgrammeBuilder {
    return new ProgrammeBuilder({ channel, start, title, ...options });
  }

  constructor(base: ProgrammeBuilderBase) {
    super(base.lang);

    this.#programme = {
      channel: base.channel,
      start: xmltvDate(base.start),
      title: [this.textValue(base.title)],
    };

    if (base.stop !== undefined) this.stop(base.stop);
    if (base.pdcStart !== undefined) this.pdcStart(base.pdcStart);
    if (base.vpsStart !== undefined) this.vpsStart(base.vpsStart);
    if (base.showview) this.showview(base.showview);
    if (base.videoplus) this.videoplus(base.videoplus);
    if (base.clumpidx) this.clumpidx(base.clumpidx);
  }

  /** Sets the `stop` time (end of the programme). */
  stop(value: DateInput, options?: XmltvDateOptions): this {
    this.#programme.stop = xmltvDate(value, options);
    return this;
  }

  /** Sets the `pdc-start` (Programme Delivery Control) time. */
  pdcStart(value: DateInput, options?: XmltvDateOptions): this {
    this.#programme.pdcStart = xmltvDate(value, options);
    return this;
  }

  /** Sets the `vps-start` (Video Programme System) time. */
  vpsStart(value: DateInput, options?: XmltvDateOptions): this {
    this.#programme.vpsStart = xmltvDate(value, options);
    return this;
  }

  /** Sets the `showview` code. */
  showview(value: string): this {
    this.#programme.showview = value;
    return this;
  }

  /** Sets the `videoplus` code. */
  videoplus(value: string): this {
    this.#programme.videoplus = value;
    return this;
  }

  /** Sets the `clumpidx` (clump index for shared timeslots, e.g. `0/2`). */
  clumpidx(value: string): this {
    this.#programme.clumpidx = value;
    return this;
  }

  /** Adds another `<title>` (e.g. for a second language). */
  title(value: string, lang?: string, extraAttributes?: ExtraAttributes): this {
    this.#programme.title.push(this.text(value, lang, extraAttributes));
    return this;
  }

  subTitle(value: string, lang?: string, extraAttributes?: ExtraAttributes): this {
    (this.#programme.subTitle ??= []).push(this.text(value, lang, extraAttributes));
    return this;
  }

  desc(value: string, lang?: string, extraAttributes?: ExtraAttributes): this {
    (this.#programme.desc ??= []).push(this.text(value, lang, extraAttributes));
    return this;
  }

  /**
   * Sets the production `<date>`. Precision is preserved, so a bare year like
   * `"2026"` round-trips as `2026` ("sometime in 2026", not Jan 1st) rather
   * than a full datetime. Accepts a {@link DateInput}; the `<date>` element has
   * no timezone, so any offset is ignored on serialization.
   */
  date(value: DateInput, options?: XmltvDateOptions): this {
    this.#programme.date = xmltvDate(value, options);
    return this;
  }

  category(value: string, lang?: string, extraAttributes?: ExtraAttributes): this {
    (this.#programme.category ??= []).push(this.text(value, lang, extraAttributes));
    return this;
  }

  keyword(value: string, lang?: string, extraAttributes?: ExtraAttributes): this {
    (this.#programme.keyword ??= []).push(this.text(value, lang, extraAttributes));
    return this;
  }

  language(value: string, lang?: string, extraAttributes?: ExtraAttributes): this {
    this.#programme.language = this.text(value, lang, extraAttributes);
    return this;
  }

  origLanguage(value: string, lang?: string, extraAttributes?: ExtraAttributes): this {
    this.#programme.origLanguage = this.text(value, lang, extraAttributes);
    return this;
  }

  length(
    value: number,
    units: 'seconds' | 'minutes' | 'hours' = 'minutes',
    extraAttributes?: ExtraAttributes,
  ): this {
    this.#programme.length = this.extraAttrs<XmltvLength>({ units, value }, extraAttributes);
    return this;
  }

  icon(value: string, opts?: IconOptions, extraAttributes?: ExtraAttributes): this {
    (this.#programme.icon ??= []).push(this.toIcon(value, opts, extraAttributes));
    return this;
  }

  url(value: string, opts?: UrlOptions, extraAttributes?: ExtraAttributes): this {
    (this.#programme.url ??= []).push(this.toUrlValue(value, opts, extraAttributes));
    return this;
  }

  country(value: string, lang?: string, extraAttributes?: ExtraAttributes): this {
    (this.#programme.country ??= []).push(this.text(value, lang, extraAttributes));
    return this;
  }

  /** Explicit escape hatch for an `episode-num` system not covered by {@link episode}. */
  episodeNum(system: string, value: string, extraAttributes?: ExtraAttributes): this {
    (this.#programme.episodeNum ??= []).push(
      this.extraAttrs<XmltvEpisodeNum>({ system, value }, extraAttributes),
    );
    return this;
  }

  /**
   * Shortcut: 1-based `season`/`episode` -> both `xmltv_ns` (0-based) and
   * `onscreen` entries. `opts` fills the `xmltv_ns` totals/parts, e.g.
   * `.episode(6, 2, { episodes: 13 })` -> `1.5/13.0/1` and `S02E06`. A
   * multi-part episode (`{ part: 1, parts: 2 }`) also shows on `onscreen` as
   * `S02E06 (1/2)`.
   */
  episode(episode: number | string, season: number | string = 1, opts: EpisodeOptions = {}): this {
    (this.#programme.episodeNum ??= []).push(...this.#episodeNumbers(episode, season, opts));
    return this;
  }

  /** Merges into the programme's `<video>` — call multiple times to set fields incrementally. */
  video(opts: VideoOptions, extraAttributes?: ExtraAttributes): this {
    const video: XmltvVideo = this.#programme.video ?? {};
    const present = this.#toYesNo(opts.present);
    const colour = this.#toYesNo(opts.colour);

    if (present !== undefined) video.present = present;
    if (colour !== undefined) video.colour = colour;
    if (opts.aspect) video.aspect = opts.aspect;
    if (opts.quality) video.quality = opts.quality;

    this.#appendExtra(video, opts.extra);

    this.#programme.video = this.extraAttrs(video, extraAttributes);
    return this;
  }

  /** Merges into the programme's `<audio>` — call multiple times to set fields incrementally. */
  audio(opts: AudioOptions, extraAttributes?: ExtraAttributes): this {
    const audio: XmltvAudio = this.#programme.audio ?? {};
    const present = this.#toYesNo(opts.present);

    if (present !== undefined) audio.present = present;
    if (opts.stereo) audio.stereo = opts.stereo;

    this.#appendExtra(audio, opts.extra);

    this.#programme.audio = this.extraAttrs(audio, extraAttributes);
    return this;
  }

  previouslyShown(opts: PreviouslyShownOptions, extraAttributes?: ExtraAttributes): this {
    this.#programme.previouslyShown = this.extraAttrs<XmltvPreviouslyShown>(
      {
        ...(opts.start !== undefined ? { start: xmltvDate(opts.start) } : {}),
        ...(opts.channel ? { channel: opts.channel } : {}),
      },
      extraAttributes,
    );
    return this;
  }

  /** Omit `value` for a bare `<premiere/>` flag. */
  premiere(value?: string, lang?: string, extraAttributes?: ExtraAttributes): this {
    this.#programme.premiere = value ? this.text(value, lang, extraAttributes) : true;
    return this;
  }

  /** Omit `value` for a bare `<last-chance/>` flag. */
  lastChance(value?: string, lang?: string, extraAttributes?: ExtraAttributes): this {
    this.#programme.lastChance = value ? this.text(value, lang, extraAttributes) : true;
    return this;
  }

  /** Sets the `<new/>` flag; stored as-is, but only a truthy value is serialized. */
  new(flag = true): this {
    this.#programme.new = flag;
    return this;
  }

  subtitles(opts: SubtitlesOptions = {}, extraAttributes?: ExtraAttributes): this {
    const subtitles: XmltvSubtitles = {};

    if (opts.type) subtitles.type = opts.type;

    if (opts.language !== undefined) {
      subtitles.language = this.textValue(opts.language, opts.lang);
    }

    this.#appendExtra(subtitles, opts.extra);

    (this.#programme.subtitles ??= []).push(this.extraAttrs(subtitles, extraAttributes));
    return this;
  }

  rating(value: string, opts: RatingOptions = {}, extraAttributes?: ExtraAttributes): this {
    (this.#programme.rating ??= []).push(this.#toRating(value, opts, extraAttributes));
    return this;
  }

  starRating(value: string, opts: RatingOptions = {}, extraAttributes?: ExtraAttributes): this {
    (this.#programme.starRating ??= []).push(this.#toRating(value, opts, extraAttributes));
    return this;
  }

  review(
    type: 'text' | 'url',
    value: string,
    opts: ReviewOptions = {},
    extraAttributes?: ExtraAttributes,
  ): this {
    const lang = opts.lang ?? this.lang;

    (this.#programme.review ??= []).push(
      this.extraAttrs<XmltvReview>(
        {
          type,
          value,
          ...(opts.source ? { source: opts.source } : {}),
          ...(opts.reviewer ? { reviewer: opts.reviewer } : {}),
          ...(lang ? { lang } : {}),
        },
        extraAttributes,
      ),
    );
    return this;
  }

  image(value: string, opts?: ImageOptions, extraAttributes?: ExtraAttributes): this {
    (this.#programme.image ??= []).push(this.#toImage(value, opts, extraAttributes));
    return this;
  }

  director(value: string, opts: PersonOptions = {}, extraAttributes?: ExtraAttributes): this {
    return this.#pushPerson('director', value, opts, extraAttributes);
  }

  writer(value: string, opts: PersonOptions = {}, extraAttributes?: ExtraAttributes): this {
    return this.#pushPerson('writer', value, opts, extraAttributes);
  }

  adapter(value: string, opts: PersonOptions = {}, extraAttributes?: ExtraAttributes): this {
    return this.#pushPerson('adapter', value, opts, extraAttributes);
  }

  producer(value: string, opts: PersonOptions = {}, extraAttributes?: ExtraAttributes): this {
    return this.#pushPerson('producer', value, opts, extraAttributes);
  }

  composer(value: string, opts: PersonOptions = {}, extraAttributes?: ExtraAttributes): this {
    return this.#pushPerson('composer', value, opts, extraAttributes);
  }

  editor(value: string, opts: PersonOptions = {}, extraAttributes?: ExtraAttributes): this {
    return this.#pushPerson('editor', value, opts, extraAttributes);
  }

  presenter(value: string, opts: PersonOptions = {}, extraAttributes?: ExtraAttributes): this {
    return this.#pushPerson('presenter', value, opts, extraAttributes);
  }

  commentator(value: string, opts: PersonOptions = {}, extraAttributes?: ExtraAttributes): this {
    return this.#pushPerson('commentator', value, opts, extraAttributes);
  }

  guest(value: string, opts: PersonOptions = {}, extraAttributes?: ExtraAttributes): this {
    return this.#pushPerson('guest', value, opts, extraAttributes);
  }

  actor(value: string, opts: ActorOptions = {}, extraAttributes?: ExtraAttributes): this {
    const actor: XmltvActor = { value, ...this.#imageUrl(opts) };

    if (opts.role) actor.role = opts.role;

    const guest = this.#toYesNo(opts.guest);

    if (guest !== undefined) actor.guest = guest;

    const credits = (this.#programme.credits ??= {});

    (credits.actor ??= []).push(this.extraAttrs(actor, extraAttributes));
    return this;
  }

  extra(element: XmltvExtraElement): this {
    (this.#programme.extra ??= []).push(element);
    return this;
  }

  /**
   * A non-DTD element among the credits, rather than inside one — `<credits>`
   * allows them between the people it lists.
   */
  creditsExtra(element: XmltvExtraElement): this {
    const credits = (this.#programme.credits ??= {});

    (credits.extra ??= []).push(element);
    return this;
  }

  build(): XmltvProgramme {
    return this.#programme;
  }

  // --- internal helpers ---

  protected get extraAttributesTarget(): XmltvExtraAttributes {
    return this.#programme;
  }

  #toArray<T>(value: Many<T> | undefined): T[] {
    if (value === undefined) {
      return [];
    }

    return Array.isArray(value) ? value : [value];
  }

  /** Append non-DTD children to an element that allows them. */
  #appendExtra(target: XmltvExtraElements, extra: Many<XmltvExtraElement> | undefined): void {
    const elements = this.#toArray(extra);

    if (elements.length) {
      (target.extra ??= []).push(...elements);
    }
  }

  #toYesNo(value: YesNo | undefined): boolean | undefined {
    if (value === undefined) {
      return undefined;
    }

    return typeof value === 'boolean' ? value : value === 'yes';
  }

  #toImage(value: string, opts: ImageOptions = {}, extraAttributes?: ExtraAttributes): XmltvImage {
    const image: XmltvImage = { value };

    if (opts.type) image.type = opts.type;
    if (opts.size) image.size = opts.size;
    if (opts.orient) image.orient = opts.orient;
    if (opts.system) image.system = opts.system;

    return this.extraAttrs(image, this.mergeExtra(extraAttributes, opts.extraAttributes));
  }

  /**
   * Build the children of a repeatable option — one or many, each either a
   * bare value or a `[value, options]` pair.
   */
  #entries<O, R>(
    input: Many<string | [string, O]> | undefined,
    build: (value: string, opts?: O) => R,
  ): R[] {
    return this.#toArray(input).map((entry) => {
      const [value, opts]: [string, O?] = Array.isArray(entry) ? entry : [entry];

      return build(value, opts);
    });
  }

  /** The `<image>`/`<url>` children shared by every credit element (`(#PCDATA | image | url)*`). */
  #imageUrl(opts: PersonOptions): Pick<XmltvPerson, 'image' | 'url' | 'extra'> {
    const image = this.#entries(opts.image, (value, o) => this.#toImage(value, o));
    const url = this.#entries(opts.url, (value, o) => this.toUrlValue(value, o));
    const extra = this.#toArray(opts.extra);

    return {
      ...(image.length ? { image } : {}),
      ...(url.length ? { url } : {}),
      ...(extra.length ? { extra } : {}),
    };
  }

  #toPersonValue(
    value: string,
    opts: PersonOptions,
    extraAttributes?: ExtraAttributes,
  ): XmltvPersonValue {
    const media = this.#imageUrl(opts);
    const attrs = this.mergeExtra(extraAttributes);

    // Collapse to a bare name only when there are no children and no attributes.
    if (!media.image && !media.url && !media.extra && !attrs) {
      return value;
    }

    return this.extraAttrs<XmltvPerson>({ value, ...media }, attrs);
  }

  #pushPerson(
    role: PersonRole,
    value: string,
    opts: PersonOptions,
    extraAttributes?: ExtraAttributes,
  ): this {
    const credits = (this.#programme.credits ??= {});

    (credits[role] ??= []).push(this.#toPersonValue(value, opts, extraAttributes));
    return this;
  }

  #toRating(value: string, opts: RatingOptions, extraAttributes?: ExtraAttributes): XmltvRating {
    const rating: XmltvRating = { value };

    if (opts.system) rating.system = opts.system;

    const icon = this.#entries(opts.icon, (value, o) => this.toIcon(value, o));

    if (icon.length) rating.icon = icon;

    this.#appendExtra(rating, opts.extra);

    return this.extraAttrs(rating, extraAttributes);
  }

  /** Builds both `xmltv_ns` (0-based) and `onscreen` entries from 1-based season/episode numbers. */
  #episodeNumbers(
    episode: number | string,
    season: number | string,
    opts: EpisodeOptions,
  ): XmltvEpisodeNum[] {
    const seasonNum = Number(season);
    const episodeNum = Number(episode);

    const part = opts.part ?? 1;
    const parts = opts.parts ?? 1;

    // Each xmltv_ns field is a 0-based index with an optional `/total` count;
    // an unspecified part means "part 1 of 1" (`0/1`).
    const dim = (index: number, total?: number): string =>
      total !== undefined ? `${index}/${total}` : `${index}`;
    const xmltvNs = [
      dim(seasonNum - 1, opts.seasons),
      dim(episodeNum - 1, opts.episodes),
      `${part - 1}/${parts}`,
    ].join('.');

    // onscreen is free-form display text; show a 1-based part only when multi-part.
    let onscreen = `S${String(seasonNum).padStart(2, '0')}E${String(episodeNum).padStart(2, '0')}`;
    if (parts > 1) onscreen += ` (${part}/${parts})`;

    return [
      { system: 'xmltv_ns', value: xmltvNs },
      { system: 'onscreen', value: onscreen },
    ];
  }
}

/**
 * Fluent helper for building a fully-typed {@link XmltvChannel}: construct with
 * the required `id` + first display name, then chain more display names (e.g.
 * per language), icons and urls. Like {@link ProgrammeBuilder}, each element
 * method takes a trailing `extraAttributes` argument.
 */
export class ChannelBuilder extends XmltvElementBuilder {
  readonly #channel: XmltvChannel;

  /** Positional shorthand for `new ChannelBuilder({ id, displayName, lang })`. */
  static of(id: string, displayName: string, lang?: string): ChannelBuilder {
    return new ChannelBuilder({ id, displayName, ...(lang !== undefined ? { lang } : {}) });
  }

  constructor(base: ChannelBuilderBase) {
    super(base.lang);

    this.#channel = {
      id: base.id,
      displayName: [this.textValue(base.displayName)],
    };
  }

  /** Adds another `<display-name>` (e.g. for a second language or a call sign). */
  displayName(value: string, lang?: string, extraAttributes?: ExtraAttributes): this {
    this.#channel.displayName.push(this.text(value, lang, extraAttributes));
    return this;
  }

  icon(value: string, opts?: IconOptions, extraAttributes?: ExtraAttributes): this {
    (this.#channel.icon ??= []).push(this.toIcon(value, opts, extraAttributes));
    return this;
  }

  url(value: string, opts?: UrlOptions, extraAttributes?: ExtraAttributes): this {
    (this.#channel.url ??= []).push(this.toUrlValue(value, opts, extraAttributes));
    return this;
  }

  extra(element: XmltvExtraElement): this {
    (this.#channel.extra ??= []).push(element);
    return this;
  }

  build(): XmltvChannel {
    return this.#channel;
  }

  protected get extraAttributesTarget(): XmltvExtraAttributes {
    return this.#channel;
  }
}

/** A {@link ChannelBuilder}/{@link ProgrammeBuilder} that can hand control back to its document. */
type Bound<B> = B & { end(): XmltvDocumentBuilder };

/** {@link ChannelBuilder} opened by {@link XmltvDocumentBuilder.addChannel}; `end()` returns the document. */
class BoundChannelBuilder extends ChannelBuilder {
  readonly #parent: XmltvDocumentBuilder;

  constructor(base: ChannelBuilderBase, parent: XmltvDocumentBuilder) {
    super(base);
    this.#parent = parent;
  }

  /** Finish this channel, add it to the document, and return the document builder. */
  end(): XmltvDocumentBuilder {
    return this.#parent.channel(this);
  }
}

/** {@link ProgrammeBuilder} opened by {@link XmltvDocumentBuilder.addProgramme}; `end()` returns the document. */
class BoundProgrammeBuilder extends ProgrammeBuilder {
  readonly #parent: XmltvDocumentBuilder;

  constructor(base: ProgrammeBuilderBase, parent: XmltvDocumentBuilder) {
    super(base);
    this.#parent = parent;
  }

  /** Finish this programme, add it to the document, and return the document builder. */
  end(): XmltvDocumentBuilder {
    return this.#parent.programme(this);
  }
}

/**
 * Assembles a whole document — root `<tv>` meta, channels and programmes — into
 * the shape the serializers consume. Channels and programmes can be added three
 * ways, mix freely:
 *
 * ```ts
 * const doc = new XmltvDocumentBuilder()
 *   .generatorInfo('epg-tools')
 *   // 1. base fields + a configure callback (stays on the document builder):
 *   .channel({ id: 'one.tv', displayName: 'One' }, (c) => c.icon('one.png'))
 *   // 2. open a child builder and `.end()` back (flat chaining):
 *   .addProgramme({ channel: 'one.tv', start, title: 'News' })
 *     .desc('Evening news')
 *     .episode(3)
 *     .end()
 *   // 3. a standalone builder built elsewhere:
 *   .channel(new ChannelBuilder({ id: 'two.tv', displayName: 'Two' }))
 *   .build();
 *
 * await writeXmltvToFile('guide.xml', doc);
 * ```
 *
 * Besides `build()` (serializer input), it can emit the document as tagged
 * events ({@link toEvents}), an XML string ({@link toXml}), or a ready-to-pipe
 * XML stream ({@link toStream}).
 */
export class XmltvDocumentBuilder extends ExtraAttributesBuilder {
  #meta: XmltvDocumentMeta = {};
  readonly #channels: XmltvChannel[] = [];
  readonly #programmes: XmltvProgramme[] = [];

  /** Merges root `<tv>` attributes (later calls win per field). */
  meta(meta: XmltvDocumentMeta): this {
    this.#meta = { ...this.#meta, ...meta };
    return this;
  }

  /** Sets the `date` attribute (the guide's generation time). */
  date(value: DateInput, options?: XmltvDateOptions): this {
    return this.meta({ date: xmltvDate(value, options) });
  }

  /** Sets `source-info-name` and, if given, `source-info-url`. */
  sourceInfo(name: string, url?: string): this {
    return this.meta(url ? { sourceInfoName: name, sourceInfoUrl: url } : { sourceInfoName: name });
  }

  /** Sets `source-data-url`. */
  sourceDataUrl(url: string): this {
    return this.meta({ sourceDataUrl: url });
  }

  /** Sets `generator-info-name` and, if given, `generator-info-url`. */
  generatorInfo(name: string, url?: string): this {
    return this.meta(
      url ? { generatorInfoName: name, generatorInfoUrl: url } : { generatorInfoName: name },
    );
  }

  /** Adds a channel from its base fields, optionally configured via the callback. */
  channel(base: ChannelBuilderBase, configure?: (channel: ChannelBuilder) => void): this;
  /** Adds a standalone {@link ChannelBuilder}. */
  channel(builder: ChannelBuilder): this;
  channel(
    arg: ChannelBuilderBase | ChannelBuilder,
    configure?: (channel: ChannelBuilder) => void,
  ): this {
    this.#channels.push(this.#resolveChannel(arg, configure));
    return this;
  }

  /** Adds a programme from its base fields, optionally configured via the callback. */
  programme(base: ProgrammeBuilderBase, configure?: (programme: ProgrammeBuilder) => void): this;
  /** Adds a standalone {@link ProgrammeBuilder}. */
  programme(builder: ProgrammeBuilder): this;
  programme(
    arg: ProgrammeBuilderBase | ProgrammeBuilder,
    configure?: (programme: ProgrammeBuilder) => void,
  ): this {
    this.#programmes.push(this.#resolveProgramme(arg, configure));
    return this;
  }

  /** Opens a {@link ChannelBuilder} bound to this document; chain it, then `.end()` to return here. */
  addChannel(base: ChannelBuilderBase): Bound<ChannelBuilder> {
    return new BoundChannelBuilder(base, this);
  }

  /** Opens a {@link ProgrammeBuilder} bound to this document; chain it, then `.end()` to return here. */
  addProgramme(base: ProgrammeBuilderBase): Bound<ProgrammeBuilder> {
    return new BoundProgrammeBuilder(base, this);
  }

  /** The assembled document, ready for `writeXmltvStream` / `writeXmltvToFile`. */
  build(): XmltvStreamInput {
    return { meta: this.#meta, channels: this.#channels, programmes: this.#programmes };
  }

  /**
   * The document as tagged `{ type, value }` events — `meta`, then each
   * `channel`, then each `programme` — the shape {@link XmltvSerializeStream}
   * consumes and the parser emits.
   */
  toEvents(): XmltvParseEvent[] {
    return [
      { type: 'meta', value: this.#meta },
      ...this.#channels.map((value): XmltvParseEvent => ({ type: 'channel', value })),
      ...this.#programmes.map((value): XmltvParseEvent => ({ type: 'programme', value })),
    ];
  }

  /** A Node readable stream of the serialized XML (string chunks), ready to pipe. */
  toStream(options?: SerializeOptions): Readable {
    return Readable.from(writeXmltvStream(this.build(), options));
  }

  /** The whole document serialized to an XML string. Compact by default; pass `{ indent }`. */
  toXml(options?: SerializeOptions): string {
    return (
      serializeDocumentHeader(this.#meta, options) +
      this.#channels.map((channel) => serializeChannel(channel, options)).join('') +
      this.#programmes.map((programme) => serializeProgramme(programme, options)).join('') +
      serializeDocumentFooter(options)
    );
  }

  protected get extraAttributesTarget(): XmltvExtraAttributes {
    return this.#meta;
  }

  #resolveChannel(
    arg: ChannelBuilderBase | ChannelBuilder,
    configure?: (channel: ChannelBuilder) => void,
  ): XmltvChannel {
    const builder = arg instanceof ChannelBuilder ? arg : new ChannelBuilder(arg);
    configure?.(builder);
    return builder.build();
  }

  #resolveProgramme(
    arg: ProgrammeBuilderBase | ProgrammeBuilder,
    configure?: (programme: ProgrammeBuilder) => void,
  ): XmltvProgramme {
    const builder = arg instanceof ProgrammeBuilder ? arg : new ProgrammeBuilder(arg);
    configure?.(builder);
    return builder.build();
  }
}

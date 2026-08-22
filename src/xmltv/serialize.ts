import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { getDefaultHighWaterMark, Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { escapeXml } from './escape.js';
import { formatXmltvDate } from './date.js';
import type {
  AnyIterable,
  XmltvActor,
  XmltvAudio,
  XmltvChannel,
  XmltvCredits,
  XmltvDocumentMeta,
  XmltvExtraElement,
  XmltvIcon,
  XmltvImage,
  XmltvParseEvent,
  XmltvPersonValue,
  XmltvProgramme,
  XmltvRating,
  XmltvStarRating,
  XmltvTextValue,
  XmltvUrlValue,
  XmltvVideo,
  XmltvWarning,
} from './types.js';

/** Options shared by every serialize entry point. */
export interface SerializeOptions {
  /**
   * Pretty-print with this indentation: a number of spaces or a literal
   * string (e.g. `'\t'`). Omit or `0` for compact output — no whitespace
   * between elements — which is the default, mirroring `JSON.stringify`.
   */
  indent?: string | number;
  /**
   * `writeXmltvStream` accumulates serialized elements until roughly this many
   * characters before yielding a chunk (one yield per batch, not per element),
   * since a generator has no buffer of its own. {@link XmltvSerializeStream}
   * pushes each element and lets its readable buffer coalesce them, so there
   * this is simply the readable `highWaterMark`. Ignored by the per-element
   * {@link serializeChannel} / {@link serializeProgramme}. Defaults to Node's
   * stream `highWaterMark` (16 KiB before Node 22, 64 KiB since).
   */
  highWaterMark?: number;
}

/**
 * What the *streaming* writers take on top of the formatting: a document being
 * written is as long as the document, so it is the one thing here worth being
 * able to stop. The per-element {@link serializeChannel} /
 * {@link serializeProgramme} return a string and have nothing to interrupt.
 */
export interface WriteOptions extends SerializeOptions {
  /**
   * Stop writing. Checked between elements — the granularity a document has —
   * and passed to the file write when there is one, so a partly written file is
   * closed rather than left open behind an abandoned promise.
   */
  signal?: AbortSignal;
}

/**
 * Resolved whitespace policy threaded through the serializers. `unit` is the
 * per-level indent (`''` when compact) and `nl` the line separator (`''` when
 * compact) — so a compact document carries no formatting whitespace at all,
 * while element text (inside `escapeXml`) is never touched either way.
 */
interface Fmt {
  unit: string;
  nl: string;
}

function makeFmt(options: SerializeOptions | undefined): Fmt {
  const indent = options?.indent;
  const unit = typeof indent === 'number' ? ' '.repeat(Math.max(0, indent)) : (indent ?? '');

  return { unit, nl: unit === '' ? '' : '\n' };
}

type AttrValue = string | number | undefined;

function attrs(pairs: [string, AttrValue][]): string {
  let out = '';

  for (const [name, value] of pairs) {
    // `null` is off the type, but a model built by hand or revived from JSON
    // can carry one, and `String(null)` would write it out as `name="null"`.
    if (value !== undefined && value !== null) {
      out += ` ${name}="${escapeXml(String(value))}"`;
    }
  }

  return out;
}

/** One element; self-closing when `text` is undefined. */
function element(
  f: Fmt,
  pad: string,
  name: string,
  attrPairs: [string, AttrValue][],
  text?: string,
): string {
  const open = `${pad}<${name}${attrs(attrPairs)}`;
  return text === undefined ? `${open}/>${f.nl}` : `${open}>${escapeXml(text)}</${name}>${f.nl}`;
}

function extraAttrPairs(
  extraAttributes: Record<string, string> | undefined,
): [string, AttrValue][] {
  return extraAttributes ? Object.entries(extraAttributes) : [];
}

function textAttrPairs(value: XmltvTextValue): [string, AttrValue][] {
  return [['lang', value.lang], ...extraAttrPairs(value.extraAttributes)];
}

function langElements(
  f: Fmt,
  pad: string,
  name: string,
  values: XmltvTextValue[] | undefined,
): string {
  let out = '';

  for (const value of values ?? []) {
    out += element(f, pad, name, textAttrPairs(value), value.value);
  }

  return out;
}

/** Inline markup of one extension element (recursive, no added whitespace). */
function extraMarkup(extra: XmltvExtraElement): string {
  const attrString = attrs(extraAttrPairs(extra.attributes));
  const inner =
    (extra.value !== undefined ? escapeXml(extra.value) : '') +
    (extra.children ?? []).map(extraMarkup).join('');

  return inner
    ? `<${extra.name}${attrString}>${inner}</${extra.name}>`
    : `<${extra.name}${attrString}/>`;
}

function extraElements(f: Fmt, pad: string, extras: XmltvExtraElement[] | undefined): string {
  let out = '';

  for (const extra of extras ?? []) {
    out += `${pad}${extraMarkup(extra)}${f.nl}`;
  }

  return out;
}

function iconElements(f: Fmt, pad: string, icons: XmltvIcon[] | undefined): string {
  let out = '';

  for (const icon of icons ?? []) {
    out += element(f, pad, 'icon', [
      ['src', icon.src],
      ['width', icon.width],
      ['height', icon.height],
      ...extraAttrPairs(icon.extraAttributes),
    ]);
  }

  return out;
}

function urlElements(f: Fmt, pad: string, urls: XmltvUrlValue[] | undefined): string {
  let out = '';

  for (const url of urls ?? []) {
    out +=
      typeof url === 'string'
        ? element(f, pad, 'url', [], url)
        : element(
            f,
            pad,
            'url',
            [['system', url.system], ...extraAttrPairs(url.extraAttributes)],
            url.value,
          );
  }

  return out;
}

/** Inline (mixed-content) `<image>`/`<url>` markup, no indentation/newlines. */
function inlineImage(image: XmltvImage): string {
  return `<image${attrs([
    ['type', image.type],
    ['size', image.size],
    ['orient', image.orient],
    ['system', image.system],
    ...extraAttrPairs(image.extraAttributes),
  ])}>${escapeXml(image.value)}</image>`;
}

function inlineUrl(url: XmltvUrlValue): string {
  return typeof url === 'string'
    ? `<url>${escapeXml(url)}</url>`
    : `<url${attrs([['system', url.system], ...extraAttrPairs(url.extraAttributes)])}>${escapeXml(url.value)}</url>`;
}

const CREDIT_ORDER = [
  'director',
  'actor',
  'writer',
  'adapter',
  'producer',
  'composer',
  'editor',
  'presenter',
  'commentator',
  'guest',
] as const;

/**
 * One credits person element. The DTD content model is
 * `(#PCDATA | image | url)*`, so image/url children are emitted inline
 * after the name text.
 */
function personElement(
  f: Fmt,
  pad: string,
  role: string,
  person: XmltvPersonValue | XmltvActor,
): string {
  const attrPairs: [string, AttrValue][] = [];

  if (role === 'actor' && typeof person !== 'string') {
    const actor = person as XmltvActor;
    attrPairs.push(['role', actor.role], ['guest', actor.guest ? 'yes' : undefined]);
  }

  if (typeof person !== 'string') {
    attrPairs.push(...extraAttrPairs(person.extraAttributes));
  }

  if (typeof person === 'string') {
    return element(f, pad, role, attrPairs, person);
  }

  const children =
    (person.image ?? []).map(inlineImage).join('') +
    (person.url ?? []).map(inlineUrl).join('') +
    (person.extra ?? []).map(extraMarkup).join('');

  if (!children) {
    return element(f, pad, role, attrPairs, person.value);
  }

  return `${pad}<${role}${attrs(attrPairs)}>${escapeXml(person.value)}${children}</${role}>${f.nl}`;
}

function creditsElement(f: Fmt, pad: string, credits: XmltvCredits | undefined): string {
  if (!credits) {
    return '';
  }

  const childPad = pad + f.unit;
  let inner = '';

  for (const role of CREDIT_ORDER) {
    for (const person of credits[role] ?? []) {
      inner += personElement(f, childPad, role, person);
    }
  }

  inner += extraElements(f, childPad, credits.extra);

  return inner ? `${pad}<credits>${f.nl}${inner}${pad}</credits>${f.nl}` : '';
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

function videoElement(f: Fmt, pad: string, video: XmltvVideo | undefined): string {
  if (!video) {
    return '';
  }

  const childPad = pad + f.unit;
  const inner =
    (video.present !== undefined ? element(f, childPad, 'present', [], yesNo(video.present)) : '') +
    (video.colour !== undefined ? element(f, childPad, 'colour', [], yesNo(video.colour)) : '') +
    (video.aspect !== undefined ? element(f, childPad, 'aspect', [], video.aspect) : '') +
    (video.quality !== undefined ? element(f, childPad, 'quality', [], video.quality) : '') +
    extraElements(f, childPad, video.extra);

  const open = `<video${attrs(extraAttrPairs(video.extraAttributes))}`;
  return inner ? `${pad}${open}>${f.nl}${inner}${pad}</video>${f.nl}` : `${pad}${open}/>${f.nl}`;
}

function audioElement(f: Fmt, pad: string, audio: XmltvAudio | undefined): string {
  if (!audio) {
    return '';
  }

  const childPad = pad + f.unit;
  const inner =
    (audio.present !== undefined ? element(f, childPad, 'present', [], yesNo(audio.present)) : '') +
    (audio.stereo !== undefined ? element(f, childPad, 'stereo', [], audio.stereo) : '') +
    extraElements(f, childPad, audio.extra);

  const open = `<audio${attrs(extraAttrPairs(audio.extraAttributes))}`;
  return inner ? `${pad}${open}>${f.nl}${inner}${pad}</audio>${f.nl}` : `${pad}${open}/>${f.nl}`;
}

function flagElement(
  f: Fmt,
  pad: string,
  name: string,
  value: XmltvTextValue | true | undefined,
): string {
  if (value === undefined) {
    return '';
  }

  if (value === true) {
    return `${pad}<${name}/>${f.nl}`;
  }

  return element(f, pad, name, textAttrPairs(value), value.value);
}

function ratingElements(
  f: Fmt,
  pad: string,
  name: string,
  ratings: (XmltvRating | XmltvStarRating)[] | undefined,
): string {
  const childPad = pad + f.unit;
  let out = '';

  for (const rating of ratings ?? []) {
    out += `${pad}<${name}${attrs([['system', rating.system], ...extraAttrPairs(rating.extraAttributes)])}>${f.nl}`;
    out += `${childPad}<value>${escapeXml(rating.value)}</value>${f.nl}`;
    out += iconElements(f, childPad, rating.icon);
    out += extraElements(f, childPad, rating.extra);
    out += `${pad}</${name}>${f.nl}`;
  }

  return out;
}

/** Serialize one `<channel>` element (newline-terminated when indenting). */
export function serializeChannel(channel: XmltvChannel, options?: SerializeOptions): string {
  const f = makeFmt(options);
  const pad = f.unit;
  const childPad = pad + f.unit;

  let out = `${pad}<channel${attrs([['id', channel.id], ...extraAttrPairs(channel.extraAttributes)])}>${f.nl}`;
  out += langElements(f, childPad, 'display-name', channel.displayName);
  out += iconElements(f, childPad, channel.icon);
  out += urlElements(f, childPad, channel.url);
  out += extraElements(f, childPad, channel.extra);
  return `${out}${pad}</channel>${f.nl}`;
}

/** Serialize one `<programme>` element, children in DTD order. */
export function serializeProgramme(programme: XmltvProgramme, options?: SerializeOptions): string {
  const f = makeFmt(options);
  const pad = f.unit;
  const I = pad + f.unit;

  let out = `${pad}<programme${attrs([
    ['start', formatXmltvDate(programme.start)],
    ['stop', programme.stop ? formatXmltvDate(programme.stop) : undefined],
    ['pdc-start', programme.pdcStart ? formatXmltvDate(programme.pdcStart) : undefined],
    ['vps-start', programme.vpsStart ? formatXmltvDate(programme.vpsStart) : undefined],
    ['showview', programme.showview],
    ['videoplus', programme.videoplus],
    ['channel', programme.channel],
    ['clumpidx', programme.clumpidx],
    ...extraAttrPairs(programme.extraAttributes),
  ])}>${f.nl}`;

  out += langElements(f, I, 'title', programme.title);
  out += langElements(f, I, 'sub-title', programme.subTitle);
  out += langElements(f, I, 'desc', programme.desc);
  out += creditsElement(f, I, programme.credits);

  if (programme.date !== undefined) {
    out += element(f, I, 'date', [], formatXmltvDate(programme.date, { offset: false }));
  }

  out += langElements(f, I, 'category', programme.category);
  out += langElements(f, I, 'keyword', programme.keyword);

  if (programme.language) {
    out += element(f, I, 'language', textAttrPairs(programme.language), programme.language.value);
  }

  if (programme.origLanguage) {
    out += element(
      f,
      I,
      'orig-language',
      textAttrPairs(programme.origLanguage),
      programme.origLanguage.value,
    );
  }

  if (programme.length) {
    out += element(
      f,
      I,
      'length',
      [['units', programme.length.units], ...extraAttrPairs(programme.length.extraAttributes)],
      String(programme.length.value),
    );
  }

  out += iconElements(f, I, programme.icon);
  out += urlElements(f, I, programme.url);
  out += langElements(f, I, 'country', programme.country);

  for (const episode of programme.episodeNum ?? []) {
    out += element(
      f,
      I,
      'episode-num',
      [['system', episode.system], ...extraAttrPairs(episode.extraAttributes)],
      episode.value,
    );
  }

  out += videoElement(f, I, programme.video);
  out += audioElement(f, I, programme.audio);

  if (programme.previouslyShown) {
    out += element(f, I, 'previously-shown', [
      [
        'start',
        programme.previouslyShown.start
          ? formatXmltvDate(programme.previouslyShown.start)
          : undefined,
      ],
      ['channel', programme.previouslyShown.channel],
      ...extraAttrPairs(programme.previouslyShown.extraAttributes),
    ]);
  }

  out += flagElement(f, I, 'premiere', programme.premiere);
  out += flagElement(f, I, 'last-chance', programme.lastChance);

  if (programme.new) {
    out += `${I}<new/>${f.nl}`;
  }

  for (const subtitles of programme.subtitles ?? []) {
    const subtitlesAttrs: [string, AttrValue][] = [
      ['type', subtitles.type],
      ...extraAttrPairs(subtitles.extraAttributes),
    ];

    const childPad = I + f.unit;
    const inner =
      (subtitles.language
        ? element(
            f,
            childPad,
            'language',
            textAttrPairs(subtitles.language),
            subtitles.language.value,
          )
        : '') + extraElements(f, childPad, subtitles.extra);

    if (inner) {
      out += `${I}<subtitles${attrs(subtitlesAttrs)}>${f.nl}${inner}${I}</subtitles>${f.nl}`;
    } else {
      out += element(f, I, 'subtitles', subtitlesAttrs);
    }
  }

  out += ratingElements(f, I, 'rating', programme.rating);
  out += ratingElements(f, I, 'star-rating', programme.starRating);

  for (const review of programme.review ?? []) {
    out += element(
      f,
      I,
      'review',
      [
        ['type', review.type],
        ['source', review.source],
        ['reviewer', review.reviewer],
        ['lang', review.lang],
        ...extraAttrPairs(review.extraAttributes),
      ],
      review.value,
    );
  }

  for (const image of programme.image ?? []) {
    out += element(
      f,
      I,
      'image',
      [
        ['type', image.type],
        ['size', image.size],
        ['orient', image.orient],
        ['system', image.system],
        ...extraAttrPairs(image.extraAttributes),
      ],
      image.value,
    );
  }

  out += extraElements(f, I, programme.extra);

  return `${out}${pad}</programme>${f.nl}`;
}

export interface XmltvStreamInput {
  meta?: XmltvDocumentMeta;
  channels: AnyIterable<XmltvChannel>;
  programmes: AnyIterable<XmltvProgramme>;
}

/**
 * Default streaming batch size — Node's own default stream `highWaterMark`
 * (16 KiB before Node 22, 64 KiB since), so `writeXmltvStream`'s batching and
 * `XmltvSerializeStream`'s readable buffer use one consistent size that tracks
 * the runtime. Benchmarks show throughput is flat from 16 KiB to 1 MiB, so the
 * value is about matching Node, not tuning.
 */
const DEFAULT_HIGH_WATER_MARK = getDefaultHighWaterMark(false);

/**
 * Serialize the document prelude — `<?xml?>`, `<!DOCTYPE>` and the open
 * `<tv …>` tag with the root attributes from `meta`. Same call shape as
 * {@link serializeChannel} / {@link serializeProgramme}; pair it with
 * {@link serializeDocumentFooter} to assemble a document by hand.
 */
export function serializeDocumentHeader(
  meta?: XmltvDocumentMeta,
  options?: SerializeOptions,
): string {
  const f = makeFmt(options);

  return (
    `<?xml version="1.0" encoding="UTF-8"?>${f.nl}` +
    `<!DOCTYPE tv SYSTEM "xmltv.dtd">${f.nl}` +
    `<tv${attrs([
      ['date', meta?.date ? formatXmltvDate(meta.date) : undefined],
      ['source-info-name', meta?.sourceInfoName],
      ['source-info-url', meta?.sourceInfoUrl],
      ['source-data-url', meta?.sourceDataUrl],
      ['generator-info-name', meta?.generatorInfoName],
      ['generator-info-url', meta?.generatorInfoUrl],
      ...extraAttrPairs(meta?.extraAttributes),
    ])}>${f.nl}`
  );
}

/** Serialize the document epilogue — the closing `</tv>` tag. */
export function serializeDocumentFooter(options?: SerializeOptions): string {
  return `</tv>${makeFmt(options).nl}`;
}

/**
 * Stream a whole XMLTV document as string chunks (~`highWaterMark` each,
 * default Node's stream default): header, `<tv>`, all channels, all
 * programmes, `</tv>`. Never accumulates the document. Compact by default;
 * pass `{ indent }` to pretty-print.
 */
export async function* writeXmltvStream(
  input: XmltvStreamInput,
  options?: WriteOptions,
): AsyncGenerator<string> {
  const highWaterMark = options?.highWaterMark ?? DEFAULT_HIGH_WATER_MARK;

  async function* parts(): AsyncGenerator<string> {
    yield serializeDocumentHeader(input.meta, options);
    for await (const channel of input.channels) yield serializeChannel(channel, options);
    for await (const programme of input.programmes) yield serializeProgramme(programme, options);
    yield serializeDocumentFooter(options);
  }

  let pending = '';

  for await (const part of parts()) {
    // Between elements, which is as often as a document gives the chance.
    options?.signal?.throwIfAborted();

    pending += part;

    if (pending.length >= highWaterMark) {
      yield pending;
      pending = '';
    }
  }

  if (pending) yield pending;
}

/** Stream an XMLTV document to a file (parent directories are created). */
export async function writeXmltvToFile(
  filePath: string,
  input: XmltvStreamInput,
  options?: WriteOptions,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await pipeline(Readable.from(writeXmltvStream(input, options)), createWriteStream(filePath), {
    signal: options?.signal,
  });
}

export interface SerializeStreamOptions extends WriteOptions {
  /**
   * Root `<tv>` attributes that take **preference** over a `meta` event on the
   * stream: the event supplies base attributes (e.g. the original values when
   * re-serializing a parsed document) and these override or add to them
   * field-by-field — set `generatorInfoName` here to relabel a passed-through
   * guide while keeping its other meta.
   */
  meta?: XmltvDocumentMeta;
}

/**
 * A Node `Transform` that serializes an object stream of tagged
 * `{ type, value }` events into XMLTV string chunks — the writable
 * counterpart to {@link XmltvParseStream}, consuming exactly the events it
 * emits, so a `parse → serialize` pipeline round-trips:
 *
 * ```ts
 * await pipeline(source, new XmltvSerializeStream({ meta }), createWriteStream('guide.xml'));
 * ```
 *
 * `meta` events supply base root attributes (merged if several arrive), the
 * constructor `meta` option overriding them; `channel`/`programme` events are
 * serialized. A `warning` event (forwarded by the parse stream) has no place
 * in the XML output, so it is re-emitted as a `'warning'` event on this stream
 * carrying the {@link XmltvWarning} (`stream.on('warning', …)`). The `<tv>`
 * header is written before the first channel/programme and `</tv>` on flush,
 * so write any `meta` event first and channels before programmes — an
 * out-of-order `meta` event (after the header) or an unrecognized event type
 * errors the stream.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
// Merged into the class below on purpose: it is how a stream's `on`/`once`
// overloads get typed for the 'warning' event without redeclaring the class.
// oxlint-disable-next-line typescript/no-unsafe-declaration-merging
export interface XmltvSerializeStream {
  /** A non-fatal problem forwarded from a piped parse stream. */
  on(event: 'warning', listener: (warning: XmltvWarning) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
  once(event: 'warning', listener: (warning: XmltvWarning) => void): this;
  once(event: string | symbol, listener: (...args: any[]) => void): this;
  addListener(event: 'warning', listener: (warning: XmltvWarning) => void): this;
  addListener(event: string | symbol, listener: (...args: any[]) => void): this;
  prependListener(event: 'warning', listener: (warning: XmltvWarning) => void): this;
  prependListener(event: string | symbol, listener: (...args: any[]) => void): this;
  removeListener(event: 'warning', listener: (warning: XmltvWarning) => void): this;
  removeListener(event: string | symbol, listener: (...args: any[]) => void): this;
  off(event: 'warning', listener: (warning: XmltvWarning) => void): this;
  off(event: string | symbol, listener: (...args: any[]) => void): this;
  emit(event: 'warning', warning: XmltvWarning): boolean;
  emit(event: string | symbol, ...args: any[]): boolean;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export class XmltvSerializeStream extends Transform {
  readonly #options: SerializeStreamOptions | undefined;
  /** Base root attributes accumulated from `meta` events (constructor wins). */
  #eventMeta: XmltvDocumentMeta | undefined;
  #started = false;

  constructor(options?: SerializeStreamOptions) {
    // The signal goes to the stream itself: aborting destroys it with an
    // `AbortError` carrying the reason as its cause, which is what the rest of
    // a `pipeline()` around it is waiting to hear.
    super({
      writableObjectMode: true,
      readableHighWaterMark: options?.highWaterMark ?? DEFAULT_HIGH_WATER_MARK,
      signal: options?.signal,
    });

    this.#options = options;
  }

  /** The document header, emitted lazily before the first channel/programme. */
  #prelude(): string {
    if (this.#started) {
      return '';
    }

    this.#started = true;
    // Event meta is the base; the constructor `meta` option overrides it.
    return serializeDocumentHeader({ ...this.#eventMeta, ...this.#options?.meta }, this.#options);
  }

  override _transform(
    event: XmltvParseEvent,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    try {
      switch (event.type) {
        case 'meta':
          if (this.#started) {
            throw new Error(
              'XmltvSerializeStream: a <tv> meta event must precede the first channel or programme',
            );
          }

          this.#eventMeta = { ...this.#eventMeta, ...event.value };
          return callback();
        case 'channel':
          return callback(null, this.#prelude() + serializeChannel(event.value, this.#options));
        case 'programme':
          return callback(null, this.#prelude() + serializeProgramme(event.value, this.#options));
        case 'warning':
          this.emit('warning', event.value);
          return callback();
        default:
          throw new Error(
            `XmltvSerializeStream: unexpected event type ${JSON.stringify((event as { type?: unknown }).type)}`,
          );
      }
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    // `#prelude()` covers the header when no channel/programme was ever written.
    callback(null, `${this.#prelude()}${serializeDocumentFooter(this.#options)}`);
  }
}

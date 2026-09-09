import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { getDefaultHighWaterMark, Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { escapeXml } from './escape.js';
import { formatXmltvDate } from './date.js';
import { pick, resolveProfile } from './profile.js';
import type { DropRef, ProfileRef, ResolvedProfile } from './profile.js';
import type {
  XmltvProcessingInstruction,
  XmltvProcessingInstructionPosition,
  AnyIterable,
  XmltvActor,
  XmltvAudio,
  XmltvChannel,
  XmltvCredits,
  XmltvDocumentMeta,
  XmltvEpisodeNum,
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

/**
 * One extension on its way out, as {@link SerializeOptions.extensions} sees it:
 * an `extraAttributes` key or an `extra` element, and the element carrying it.
 */
export interface ExtensionRef {
  kind: 'attribute' | 'element';
  /** The name it would be written under. */
  name: string;
  /** The element it hangs off — `'programme'`, `'channel'`, `'tv'`, `'icon'`, … */
  on: string;
}

/** Whether one extension is written. See {@link SerializeOptions.extensions}. */
export type ExtensionFilter = (extension: ExtensionRef) => boolean;

/** Options shared by every serialize entry point. */
export interface SerializeOptions {
  /**
   * Pretty-print with this indentation: a number of spaces or a literal
   * string (e.g. `'\t'`). Omit or `0` for compact output — no whitespace
   * between elements — which is the default, mirroring `JSON.stringify`.
   */
  indent?: string | number;
  /**
   * Which provider extensions — `extraAttributes` and `extra` — are written.
   * Defaults to `true`, all of them.
   *
   * `false` leaves every one out, which is what makes a document valid against
   * the DTD: one grab then writes the full guide for a consumer that reads
   * extensions and a plain one for everything else. An array keeps only the
   * names it lists, attributes and elements alike — `['lcn', 'uniqueID']` for
   * the two a consumer actually uses. An {@link ExtensionFilter} decides one at
   * a time, told the name, whether it is an attribute or an element, and which
   * element carries it; a deny-list is `({ name }) => name !== 'lcn'`.
   *
   * What is kept is kept **whole**: an extension element goes out with its own
   * attributes and children verbatim, as it came in. This chooses which
   * extensions a document has, not what is inside one.
   */
  extensions?: boolean | readonly string[] | ExtensionFilter;
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
  /**
   * Shape the document for the consumer that will read it: which
   * `<episode-num>` systems go out and in what order, what a `<category>` is
   * called, how many `<icon>`s a programme needs, which optional elements are
   * left out. A name this package ships (`'tvheadend'`, `'jellyfin'`) or an
   * `OutputProfile` of your own — spread a shipped one to start from it.
   *
   * Off by default: a document written without a profile is exactly the
   * document this package has always written.
   *
   * It shapes what the DTD describes. Which *extensions* go out is
   * {@link extensions}, and the two compose deliberately — a profile's `eit`
   * code is a non-DTD attribute, so `extensions: false` removes it even under a
   * profile that asks for one, and "no extensions" keeps meaning "a document
   * that validates".
   */
  profile?: ProfileRef;
}

/**
 * The output-shaping options a configuration carries, and the subset of
 * {@link SerializeOptions} every writer in this package accepts.
 *
 * These travel together because they answer the same question — what the
 * document coming out looks like — and because they reach the writers by five
 * different routes (`epg build`, `epg merge`, `epg serve`, `epg filter` and
 * `--list-channels`). Spelling them out at each of those was how `serve` came
 * to be missing one.
 */
export type GuideOutputOptions = Pick<SerializeOptions, 'indent' | 'extensions' | 'profile'>;

/**
 * The output options a source actually set, ready to spread into a writer's.
 *
 * Absent stays absent rather than becoming `undefined`, so a caller's option
 * still wins over a default further down — which is why the parameter is the
 * looser shape a config declares (`extensions?: SerializeOptions['extensions']`
 * admits an explicit `undefined`) and the result is the strict one.
 */
export function outputOptions(from: {
  indent?: string | number | undefined;
  extensions?: SerializeOptions['extensions'];
  profile?: SerializeOptions['profile'];
}): GuideOutputOptions {
  return {
    ...(from.indent !== undefined ? { indent: from.indent } : {}),
    ...(from.extensions !== undefined ? { extensions: from.extensions } : {}),
    ...(from.profile !== undefined ? { profile: from.profile } : {}),
  };
}

/**
 * What the two ends of a document take on top of the formatting: the processing
 * instructions, all of them, at either end.
 *
 * Each end takes only the part that is its own — {@link serializeDocumentHeader}
 * the `prolog` ones before the root and the `root` ones just inside it,
 * {@link serializeDocumentFooter} the `epilog` ones after the close tag — so
 * assembling a document by hand is passing the same list to both and letting
 * each place what belongs to it. Nothing in between has to know about them.
 */
export interface DocumentBoundaryOptions extends SerializeOptions {
  processingInstructions?: Iterable<XmltvProcessingInstruction>;
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
 * Resolved output policy threaded through the serializers: what the document
 * looks like, which is whitespace and which extensions it carries.
 *
 * `unit` is the per-level indent (`''` when compact) and `nl` the line
 * separator (`''` when compact) — so a compact document carries no formatting
 * whitespace at all, while element text (inside `escapeXml`) is never touched
 * either way. `keep` is {@link SerializeOptions.extensions} resolved: `true`
 * for all of them, `false` for none, or the filter that decides one at a time.
 */
interface Fmt {
  unit: string;
  nl: string;
  /**
   * The extension policy. Not to be confused with `profile.keep`, which is
   * about how many of a repeated DTD element go out; this one is about
   * non-DTD attributes and elements.
   */
  keep: boolean | ExtensionFilter;
  /**
   * {@link SerializeOptions.profile} resolved, absent when there is none —
   * which is the fast path every existing caller stays on.
   */
  profile?: ResolvedProfile;
}

/** Shared, so nothing is allocated for an element that is absent or dropped. */
const NONE: readonly never[] = [];

/**
 * Whether an element at this path is written at all.
 *
 * One property load and, at most, one `Set.has` on a literal string. The
 * `profile?.drop === undefined` guard is what keeps an unprofiled document
 * from paying for any of this.
 */
function kept(f: Fmt, path: string): boolean {
  return f.profile?.drop === undefined || !f.profile.drop.has(path);
}

/**
 * The elements at this path that survive `OutputProfile`'s `drop` and `keep`, in the order they should be written.
 *
 * Hands back the caller's own array when no profile has an opinion, so a
 * document that is not being shaped copies nothing.
 */
function chosen<T>(f: Fmt, path: string, elements: readonly T[] | undefined): readonly T[] {
  if (elements === undefined || !kept(f, path)) {
    return NONE;
  }

  const rule = f.profile?.keep?.get(path);

  return rule === undefined ? elements : pick(rule, elements);
}

/**
 * The predicate an allowlist resolves to, kept per array rather than per call.
 *
 * `makeFmt` runs once per element — `serializeChannel` and `serializeProgramme`
 * each call it — so building the `Set` there would rebuild it for every
 * programme in the guide. Weak, because the array is the caller's and the
 * options object it sits in may not outlive one call.
 */
const ALLOWLISTS = new WeakMap<readonly string[], ExtensionFilter>();

function keepFrom(extensions: SerializeOptions['extensions'] = true): boolean | ExtensionFilter {
  if (typeof extensions === 'boolean' || typeof extensions === 'function') {
    return extensions;
  }

  let filter = ALLOWLISTS.get(extensions);

  if (filter === undefined) {
    const names = new Set(extensions);

    filter = ({ name }) => names.has(name);
    ALLOWLISTS.set(extensions, filter);
  }

  return filter;
}

function makeFmt(options: SerializeOptions | undefined): Fmt {
  const indent = options?.indent;
  const unit = typeof indent === 'number' ? ' '.repeat(Math.max(0, indent)) : (indent ?? '');
  const profile = options?.profile;

  return {
    unit,
    nl: unit === '' ? '' : '\n',
    keep: keepFrom(options?.extensions),
    // Absent unless asked for, so `profile` stays undefined on every existing
    // caller's `Fmt` and the guards below cost one property load. `resolveProfile`
    // caches, so this is a map lookup rather than a compile per element.
    ...(profile === undefined ? {} : { profile: resolveProfile(profile) }),
  };
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

/** Every attribute of an extension element, which is kept whole or not at all. */
function pairsOf(attributes: Record<string, string> | undefined): [string, AttrValue][] {
  return attributes ? Object.entries(attributes) : [];
}

/**
 * The extension attributes of `on` that this document keeps.
 *
 * One of the two places extensions leave through, and so one of the two the
 * policy is applied in — `true` hands back what it was given, and `false`
 * allocates nothing at all.
 */
function extraAttrPairs(
  f: Fmt,
  on: string,
  extraAttributes: Record<string, string> | undefined,
): [string, AttrValue][] {
  const { keep } = f;

  if (keep === false || extraAttributes === undefined) {
    return [];
  }

  const pairs = pairsOf(extraAttributes);

  return keep === true ? pairs : pairs.filter(([name]) => keep({ kind: 'attribute', name, on }));
}

function textAttrPairs(f: Fmt, on: string, value: XmltvTextValue): [string, AttrValue][] {
  return [['lang', value.lang], ...extraAttrPairs(f, on, value.extraAttributes)];
}

/**
 * `path` is given only for elements a profile may shape. `title` and
 * `display-name` are required by the DTD, so they are called without one and
 * cannot be touched. It is passed as a literal rather than built from `name`,
 * so nothing is concatenated per element written.
 */
function langElements(
  f: Fmt,
  pad: string,
  name: string,
  values: XmltvTextValue[] | undefined,
  path?: DropRef,
): string {
  let out = '';

  for (const value of path === undefined ? (values ?? []) : chosen(f, path, values)) {
    out += element(f, pad, name, textAttrPairs(f, name, value), value.value);
  }

  return out;
}

/**
 * The `<episode-num>` entries to write: the profile's policy first — which
 * filters, orders, derives and normalises — then the count, so `keep` applies
 * to what survived rather than to what a source happened to send.
 */
function episodeNumElements(
  f: Fmt,
  entries: XmltvEpisodeNum[] | undefined,
): readonly XmltvEpisodeNum[] {
  if (entries === undefined || !kept(f, 'programme/episode-num')) {
    return NONE;
  }

  const policy = f.profile?.episodeNum;
  const shaped = policy === undefined ? entries : policy(entries);
  const rule = f.profile?.keep?.get('programme/episode-num');

  return rule === undefined ? shaped : pick(rule, shaped);
}

/**
 * `<category>`, which is the one text element a profile rewrites rather than
 * only selecting from — so it does not go through {@link langElements}.
 *
 * The rewrite runs first and the count after it, so `keep` counts distinct
 * genres rather than the source's spellings of them.
 */
function categoryElements(f: Fmt, pad: string, values: XmltvTextValue[] | undefined): string {
  if (values === undefined || !kept(f, 'programme/category')) {
    return '';
  }

  const rewrite = f.profile?.categories;
  const rewritten = rewrite === undefined ? values : rewrite(values);
  const rule = f.profile?.keep?.get('programme/category');
  let out = '';

  for (const value of rule === undefined ? rewritten : pick(rule, rewritten)) {
    out += element(f, pad, 'category', textAttrPairs(f, 'category', value), value.value);
  }

  return out;
}

/**
 * Inline markup of one extension element (recursive, no added whitespace).
 *
 * Unfiltered on purpose: an extension the policy kept is kept whole, its own
 * attributes and children as they came in. What is inside one is the provider's
 * business — the choice being made is which extensions the document has.
 */
function extraMarkup(extra: XmltvExtraElement): string {
  const attrString = attrs(pairsOf(extra.attributes));
  const inner =
    (extra.value !== undefined ? escapeXml(extra.value) : '') +
    (extra.children ?? []).map(extraMarkup).join('');

  return inner
    ? `<${extra.name}${attrString}>${inner}</${extra.name}>`
    : `<${extra.name}${attrString}/>`;
}

/** Whether one extension element of `on` is written. */
function keepsElement(f: Fmt, on: string, extra: XmltvExtraElement): boolean {
  const { keep } = f;

  return keep === true || (keep !== false && keep({ kind: 'element', name: extra.name, on }));
}

/** The kept extension elements of `on`, inline — for a mixed-content parent. */
function extraInline(f: Fmt, on: string, extras: XmltvExtraElement[] | undefined): string {
  let out = '';

  for (const extra of extras ?? []) {
    if (keepsElement(f, on, extra)) {
      out += extraMarkup(extra);
    }
  }

  return out;
}

/** The other place extensions leave through: one per line, under `pad`. */
function extraElements(
  f: Fmt,
  on: string,
  pad: string,
  extras: XmltvExtraElement[] | undefined,
): string {
  let out = '';

  for (const extra of extras ?? []) {
    if (keepsElement(f, on, extra)) {
      out += `${pad}${extraMarkup(extra)}${f.nl}`;
    }
  }

  return out;
}

/**
 * `path` is where these sit in the document, which a profile needs in order to
 * tell them apart: `<icon>` occurs under four different elements, and dropping
 * a programme's stills is not the same as dropping a channel's logo. The
 * extension `on` stays the bare element name, which is a different vocabulary
 * on purpose — an extension hangs off an element, wherever that element is.
 */
function iconElements(f: Fmt, pad: string, path: DropRef, icons: XmltvIcon[] | undefined): string {
  let out = '';

  for (const icon of chosen(f, path, icons)) {
    out += element(f, pad, 'icon', [
      ['src', icon.src],
      ['width', icon.width],
      ['height', icon.height],
      ...extraAttrPairs(f, 'icon', icon.extraAttributes),
    ]);
  }

  return out;
}

function urlElements(
  f: Fmt,
  pad: string,
  path: DropRef,
  urls: XmltvUrlValue[] | undefined,
): string {
  let out = '';

  for (const url of chosen(f, path, urls)) {
    out +=
      typeof url === 'string'
        ? element(f, pad, 'url', [], url)
        : element(
            f,
            pad,
            'url',
            [['system', url.system], ...extraAttrPairs(f, 'url', url.extraAttributes)],
            url.value,
          );
  }

  return out;
}

/** Inline (mixed-content) `<image>`/`<url>` markup, no indentation/newlines. */
function inlineImage(f: Fmt, image: XmltvImage): string {
  return `<image${attrs([
    ['type', image.type],
    ['size', image.size],
    ['orient', image.orient],
    ['system', image.system],
    ...extraAttrPairs(f, 'image', image.extraAttributes),
  ])}>${escapeXml(image.value)}</image>`;
}

function inlineUrl(f: Fmt, url: XmltvUrlValue): string {
  return typeof url === 'string'
    ? `<url>${escapeXml(url)}</url>`
    : `<url${attrs([['system', url.system], ...extraAttrPairs(f, 'url', url.extraAttributes)])}>${escapeXml(url.value)}</url>`;
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

type CreditRole = (typeof CREDIT_ORDER)[number];

/**
 * The three paths each credit role owns, built once at module load.
 *
 * A guide has as many credits blocks as it has programmes, so concatenating
 * ten of these per programme would be thirty string builds per element for
 * something that never changes.
 */
const CREDIT_PATHS = Object.fromEntries(
  CREDIT_ORDER.map((role) => [
    role,
    {
      role: `programme/credits/${role}`,
      image: `programme/credits/${role}/image`,
      url: `programme/credits/${role}/url`,
    },
  ]),
) as Record<CreditRole, { role: DropRef; image: DropRef; url: DropRef }>;

/**
 * One credits person element. The DTD content model is
 * `(#PCDATA | image | url)*`, so image/url children are emitted inline
 * after the name text.
 */
function personElement(
  f: Fmt,
  pad: string,
  role: CreditRole,
  person: XmltvPersonValue | XmltvActor,
): string {
  const attrPairs: [string, AttrValue][] = [];

  if (role === 'actor' && typeof person !== 'string') {
    const actor = person as XmltvActor;
    attrPairs.push(['role', actor.role], ['guest', actor.guest ? 'yes' : undefined]);
  }

  if (typeof person !== 'string') {
    attrPairs.push(...extraAttrPairs(f, role, person.extraAttributes));
  }

  if (typeof person === 'string') {
    return element(f, pad, role, attrPairs, person);
  }

  const paths = CREDIT_PATHS[role];
  const children =
    chosen(f, paths.image, person.image)
      .map((image) => inlineImage(f, image))
      .join('') +
    chosen(f, paths.url, person.url)
      .map((url) => inlineUrl(f, url))
      .join('') +
    extraInline(f, role, person.extra);

  if (!children) {
    return element(f, pad, role, attrPairs, person.value);
  }

  return `${pad}<${role}${attrs(attrPairs)}>${escapeXml(person.value)}${children}</${role}>${f.nl}`;
}

function creditsElement(f: Fmt, pad: string, credits: XmltvCredits | undefined): string {
  // The container short-circuits: dropping `programme/credits` generates none
  // of the markup, where dropping all ten roles builds each and lets the empty
  // parent collapse below. Same bytes out, one guard instead of eleven.
  if (!credits || !kept(f, 'programme/credits')) {
    return '';
  }

  const childPad = pad + f.unit;
  let inner = '';

  for (const role of CREDIT_ORDER) {
    for (const person of chosen(f, CREDIT_PATHS[role].role, credits[role])) {
      inner += personElement(f, childPad, role, person);
    }
  }

  inner += extraElements(f, 'credits', childPad, credits.extra);

  return inner ? `${pad}<credits>${f.nl}${inner}${pad}</credits>${f.nl}` : '';
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

function videoElement(f: Fmt, pad: string, video: XmltvVideo | undefined): string {
  if (!video || !kept(f, 'programme/video')) {
    return '';
  }

  const childPad = pad + f.unit;
  // Dropping every detail leaves `<video/>`, which the DTD allows — the
  // collapse below decides on `inner` after the children are generated.
  const inner =
    (video.present !== undefined && kept(f, 'programme/video/present')
      ? element(f, childPad, 'present', [], yesNo(video.present))
      : '') +
    (video.colour !== undefined && kept(f, 'programme/video/colour')
      ? element(f, childPad, 'colour', [], yesNo(video.colour))
      : '') +
    (video.aspect !== undefined && kept(f, 'programme/video/aspect')
      ? element(f, childPad, 'aspect', [], video.aspect)
      : '') +
    (video.quality !== undefined && kept(f, 'programme/video/quality')
      ? element(f, childPad, 'quality', [], video.quality)
      : '') +
    extraElements(f, 'video', childPad, video.extra);

  const open = `<video${attrs(extraAttrPairs(f, 'video', video.extraAttributes))}`;
  return inner ? `${pad}${open}>${f.nl}${inner}${pad}</video>${f.nl}` : `${pad}${open}/>${f.nl}`;
}

function audioElement(f: Fmt, pad: string, audio: XmltvAudio | undefined): string {
  if (!audio || !kept(f, 'programme/audio')) {
    return '';
  }

  const childPad = pad + f.unit;
  const inner =
    (audio.present !== undefined && kept(f, 'programme/audio/present')
      ? element(f, childPad, 'present', [], yesNo(audio.present))
      : '') +
    (audio.stereo !== undefined && kept(f, 'programme/audio/stereo')
      ? element(f, childPad, 'stereo', [], audio.stereo)
      : '') +
    extraElements(f, 'audio', childPad, audio.extra);

  const open = `<audio${attrs(extraAttrPairs(f, 'audio', audio.extraAttributes))}`;
  return inner ? `${pad}${open}>${f.nl}${inner}${pad}</audio>${f.nl}` : `${pad}${open}/>${f.nl}`;
}

function flagElement(
  f: Fmt,
  pad: string,
  name: 'premiere' | 'last-chance',
  value: XmltvTextValue | true | undefined,
): string {
  if (value === undefined || !kept(f, `programme/${name}`)) {
    return '';
  }

  if (value === true) {
    return `${pad}<${name}/>${f.nl}`;
  }

  return element(f, pad, name, textAttrPairs(f, name, value), value.value);
}

function ratingElements(
  f: Fmt,
  pad: string,
  name: 'rating' | 'star-rating',
  ratings: (XmltvRating | XmltvStarRating)[] | undefined,
): string {
  const childPad = pad + f.unit;
  // Built once rather than per rating: the two paths are fixed by `name`.
  const path = `programme/${name}` as const;
  const iconPath = `${path}/icon` as const;
  let out = '';

  for (const rating of chosen(f, path, ratings)) {
    out += `${pad}<${name}${attrs([['system', rating.system], ...extraAttrPairs(f, name, rating.extraAttributes)])}>${f.nl}`;
    // `<value>` is required by the DTD, so no profile can take it away.
    out += `${childPad}<value>${escapeXml(rating.value)}</value>${f.nl}`;
    out += iconElements(f, childPad, iconPath, rating.icon);
    out += extraElements(f, name, childPad, rating.extra);
    out += `${pad}</${name}>${f.nl}`;
  }

  return out;
}

/** Serialize one `<channel>` element (newline-terminated when indenting). */
export function serializeChannel(channel: XmltvChannel, options?: SerializeOptions): string {
  const f = makeFmt(options);
  const pad = f.unit;
  const childPad = pad + f.unit;

  let out = `${pad}<channel${attrs([['id', channel.id], ...extraAttrPairs(f, 'channel', channel.extraAttributes)])}>${f.nl}`;
  // `display-name+` is required, so it is not a path a profile can name.
  out += langElements(f, childPad, 'display-name', channel.displayName);
  out += iconElements(f, childPad, 'channel/icon', channel.icon);
  out += urlElements(f, childPad, 'channel/url', channel.url);
  out += extraElements(f, 'channel', childPad, channel.extra);
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
    ...extraAttrPairs(f, 'programme', programme.extraAttributes),
  ])}>${f.nl}`;

  out += langElements(f, I, 'title', programme.title);
  out += langElements(f, I, 'sub-title', programme.subTitle, 'programme/sub-title');
  out += langElements(f, I, 'desc', programme.desc, 'programme/desc');
  out += creditsElement(f, I, programme.credits);

  if (programme.date !== undefined && kept(f, 'programme/date')) {
    out += element(f, I, 'date', [], formatXmltvDate(programme.date, { offset: false }));
  }

  out += categoryElements(f, I, programme.category);
  out += langElements(f, I, 'keyword', programme.keyword, 'programme/keyword');

  if (programme.language && kept(f, 'programme/language')) {
    out += element(
      f,
      I,
      'language',
      textAttrPairs(f, 'language', programme.language),
      programme.language.value,
    );
  }

  if (programme.origLanguage && kept(f, 'programme/orig-language')) {
    out += element(
      f,
      I,
      'orig-language',
      textAttrPairs(f, 'orig-language', programme.origLanguage),
      programme.origLanguage.value,
    );
  }

  if (programme.length && kept(f, 'programme/length')) {
    out += element(
      f,
      I,
      'length',
      [
        ['units', programme.length.units],
        ...extraAttrPairs(f, 'length', programme.length.extraAttributes),
      ],
      String(programme.length.value),
    );
  }

  out += iconElements(f, I, 'programme/icon', programme.icon);
  out += urlElements(f, I, 'programme/url', programme.url);
  out += langElements(f, I, 'country', programme.country, 'programme/country');

  for (const episode of episodeNumElements(f, programme.episodeNum)) {
    out += element(
      f,
      I,
      'episode-num',
      [['system', episode.system], ...extraAttrPairs(f, 'episode-num', episode.extraAttributes)],
      episode.value,
    );
  }

  out += videoElement(f, I, programme.video);
  out += audioElement(f, I, programme.audio);

  if (programme.previouslyShown && kept(f, 'programme/previously-shown')) {
    out += element(f, I, 'previously-shown', [
      [
        'start',
        programme.previouslyShown.start
          ? formatXmltvDate(programme.previouslyShown.start)
          : undefined,
      ],
      ['channel', programme.previouslyShown.channel],
      ...extraAttrPairs(f, 'previously-shown', programme.previouslyShown.extraAttributes),
    ]);
  }

  out += flagElement(f, I, 'premiere', programme.premiere);
  out += flagElement(f, I, 'last-chance', programme.lastChance);

  if (programme.new && kept(f, 'programme/new')) {
    out += `${I}<new/>${f.nl}`;
  }

  for (const subtitles of chosen(f, 'programme/subtitles', programme.subtitles)) {
    const subtitlesAttrs: [string, AttrValue][] = [
      ['type', subtitles.type],
      ...extraAttrPairs(f, 'subtitles', subtitles.extraAttributes),
    ];

    const childPad = I + f.unit;
    const inner =
      (subtitles.language && kept(f, 'programme/subtitles/language')
        ? element(
            f,
            childPad,
            'language',
            textAttrPairs(f, 'language', subtitles.language),
            subtitles.language.value,
          )
        : '') + extraElements(f, 'subtitles', childPad, subtitles.extra);

    if (inner) {
      out += `${I}<subtitles${attrs(subtitlesAttrs)}>${f.nl}${inner}${I}</subtitles>${f.nl}`;
    } else {
      out += element(f, I, 'subtitles', subtitlesAttrs);
    }
  }

  out += ratingElements(f, I, 'rating', programme.rating);
  out += ratingElements(f, I, 'star-rating', programme.starRating);

  for (const review of chosen(f, 'programme/review', programme.review)) {
    out += element(
      f,
      I,
      'review',
      [
        ['type', review.type],
        ['source', review.source],
        ['reviewer', review.reviewer],
        ['lang', review.lang],
        ...extraAttrPairs(f, 'review', review.extraAttributes),
      ],
      review.value,
    );
  }

  for (const image of chosen(f, 'programme/image', programme.image)) {
    out += element(
      f,
      I,
      'image',
      [
        ['type', image.type],
        ['size', image.size],
        ['orient', image.orient],
        ['system', image.system],
        ...extraAttrPairs(f, 'image', image.extraAttributes),
      ],
      image.value,
    );
  }

  out += extraElements(f, 'programme', I, programme.extra);

  return `${out}${pad}</programme>${f.nl}`;
}

export interface XmltvStreamInput {
  meta?: XmltvDocumentMeta;
  /**
   * Processing instructions, each written where its `position` says — before the
   * root, among the channels and programmes, or after the close tag — and in the
   * order given within each of those.
   *
   * A plain `Iterable`, unlike the channels and programmes: a prolog one has to
   * be written before the root opens, so the list is read once up front rather
   * than streamed. That is what it is for — a handful of things a document says
   * about itself, not content.
   */
  processingInstructions?: Iterable<XmltvProcessingInstruction>;
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

/** The instructions from `list` that belong at `position`, serialized in order. */
function instructionsAt(
  list: Iterable<XmltvProcessingInstruction> | undefined,
  position: XmltvProcessingInstructionPosition,
  options: SerializeOptions | undefined,
): string {
  let out = '';

  for (const instruction of list ?? []) {
    if (instruction.position === position) {
      out += serializeProcessingInstruction(instruction, options);
    }
  }

  return out;
}

/**
 * Serialize everything a document has before its first channel or programme —
 * `<?xml?>`, `<!DOCTYPE>`, the `prolog` processing instructions, the open
 * `<tv …>` tag with the root attributes from `meta`, and then the `root`
 * instructions that sit at the head of its content. Same call shape as
 * {@link serializeChannel} / {@link serializeProgramme}; pair it with
 * {@link serializeDocumentFooter} to assemble a document by hand.
 *
 * Prolog instructions go after the DOCTYPE and before the root, which is both
 * where XML allows them and as close to the root as the grammar gets. Nothing
 * may precede the XML declaration, so that is the one place in a document an
 * instruction cannot go.
 */
export function serializeDocumentHeader(
  meta?: XmltvDocumentMeta,
  options?: DocumentBoundaryOptions,
): string {
  const f = makeFmt(options);

  return (
    `<?xml version="1.0" encoding="UTF-8"?>${f.nl}` +
    `<!DOCTYPE tv SYSTEM "xmltv.dtd">${f.nl}` +
    instructionsAt(options?.processingInstructions, 'prolog', options) +
    `<tv${attrs([
      ['date', meta?.date ? formatXmltvDate(meta.date) : undefined],
      ['source-info-name', meta?.sourceInfoName],
      ['source-info-url', meta?.sourceInfoUrl],
      ['source-data-url', meta?.sourceDataUrl],
      ['generator-info-name', meta?.generatorInfoName],
      ['generator-info-url', meta?.generatorInfoUrl],
      ...extraAttrPairs(f, 'tv', meta?.extraAttributes),
    ])}>${f.nl}` +
    instructionsAt(options?.processingInstructions, 'root', options)
  );
}

/**
 * Rejects a target that would not come back out the way it went in: empty, or
 * carrying a character that ends the instruction or starts something else.
 * Short of the full XML `Name` production — which would need Unicode tables for
 * no gain here — but exact about every character that breaks a document.
 */
const BAD_PI_TARGET = /^$|[\s<>&'"/=?]/;

/** Ends a processing instruction, so nothing inside one may contain it. */
const PI_CLOSE = '?>';

/**
 * A processing instruction — `<?target data?>` — and the newline after it when
 * the document is being pretty-printed.
 *
 * What the DTD cannot be told about can go here instead: it is XML's own way of
 * addressing one reader past all the others, and a document carrying one is
 * still a valid XMLTV document to anything that does not know the target.
 *
 * Throws on anything that would not survive being written. `?>` in `data` is
 * the one worth knowing about: XML ends an instruction at the first one and
 * recognizes no escape inside it, so the sequence cannot be represented at all
 * — a writer that let it through would emit a document this very parser reads
 * back as a truncated instruction followed by stray text. Callers that own
 * their payload encode around it instead — JSON, for one, has an escape for
 * `>` that XML cannot see, which is how {@link FsXmltvCacheStore} keeps a
 * programme title from ever ending the instruction that describes it.
 */
export function serializeProcessingInstruction(
  instruction: XmltvProcessingInstruction,
  options?: SerializeOptions,
): string {
  if (BAD_PI_TARGET.test(instruction.target)) {
    throw new TypeError(
      `Invalid processing instruction target ${JSON.stringify(instruction.target)}: must be non-empty and free of whitespace and <>&'"/=?`,
    );
  }

  // Reserved for the XML declaration and its kin, which this is not.
  if (/^xml$/i.test(instruction.target)) {
    throw new TypeError(
      `Invalid processing instruction target ${JSON.stringify(instruction.target)}: reserved for the XML declaration`,
    );
  }

  if (instruction.data.includes(PI_CLOSE)) {
    throw new TypeError(
      `Invalid processing instruction data for target ${JSON.stringify(instruction.target)}: "${PI_CLOSE}" cannot appear in a processing instruction and XML has no way to escape it`,
    );
  }

  const f = makeFmt(options);
  const data = instruction.data === '' ? '' : ` ${instruction.data}`;
  // Only a `root` one sits among the channels and programmes and shares their
  // indentation; the other two are at the document's own level, like `<tv>`.
  const pad = instruction.position === 'root' ? f.unit : '';

  return `${pad}<?${instruction.target}${data}?>${f.nl}`;
}

/**
 * Serialize the document epilogue — the closing `</tv>` tag, then any `epilog`
 * processing instructions.
 */
export function serializeDocumentFooter(options?: DocumentBoundaryOptions): string {
  return (
    `</tv>${makeFmt(options).nl}` +
    instructionsAt(options?.processingInstructions, 'epilog', options)
  );
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

  // Read once and kept: the prolog ones are needed before the header goes out
  // and the epilog ones after the footer, and the list may be a generator that
  // only gives them up the first time. Nothing is read, allocated or yielded for
  // the guide that has none, which is nearly every guide.
  const instructions = input.processingInstructions ? [...input.processingInstructions] : undefined;
  const boundary: DocumentBoundaryOptions | WriteOptions | undefined = instructions
    ? { ...options, processingInstructions: instructions }
    : options;

  async function* parts(): AsyncGenerator<string> {
    yield serializeDocumentHeader(input.meta, boundary);
    for await (const channel of input.channels) yield serializeChannel(channel, options);
    for await (const programme of input.programmes) yield serializeProgramme(programme, options);
    yield serializeDocumentFooter(boundary);
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
  /**
   * Instructions that arrived before the header went out — a parse yields the
   * prolog ones before its `meta`, and the header cannot be written until the
   * `meta` is in hand. Held until it can be, then each takes its place: the
   * prolog ones within the header, the rest immediately after it.
   */
  readonly #beforeHeader: XmltvProcessingInstruction[] = [];
  /**
   * Instructions for after the close tag, held until `_flush` — the only moment
   * there is an "after the close tag" to write them at.
   */
  readonly #afterFooter: XmltvProcessingInstruction[] = [];
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

    // Event meta is the base; the constructor `meta` option overrides it. The
    // header places the held instructions itself, on both sides of the root tag.
    return serializeDocumentHeader(
      { ...this.#eventMeta, ...this.#options?.meta },
      { ...this.#options, processingInstructions: this.#beforeHeader.splice(0) },
    );
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
        case 'processing-instruction': {
          const { position } = event.value;

          // There is no "after the close tag" until the document ends.
          if (position === 'epilog') {
            this.#afterFooter.push(event.value);
            return callback();
          }

          // Held rather than written when the header has not gone out yet:
          // writing it here would make the `meta` that follows too late to use,
          // and a prolog one belongs inside the header in any case.
          if (!this.#started) {
            this.#beforeHeader.push(event.value);
            return callback();
          }

          if (position === 'prolog') {
            throw new Error(
              'XmltvSerializeStream: a prolog processing instruction must precede the first channel or programme',
            );
          }

          return callback(null, serializeProcessingInstruction(event.value, this.#options));
        }
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
    try {
      // `#prelude()` covers the header when no channel/programme was ever written.
      const prelude = this.#prelude();

      const footer = serializeDocumentFooter({
        ...this.#options,
        processingInstructions: this.#afterFooter.splice(0),
      });

      callback(null, prelude + footer);
    } catch (error) {
      callback(error as Error);
    }
  }
}

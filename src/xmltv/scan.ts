/**
 * Streaming-aware, XMLTV-specialized XML scanner.
 *
 * The tokenizer technique (charcode scanning, tolerant attribute parsing) is
 * inspired by txml (https://github.com/TobiasNickel/tXml, MIT), rewritten
 * and fused with the XMLTV model: a single pass over the buffer produces
 * typed XmltvChannel/XmltvProgramme objects directly — no intermediate DOM
 * tree and no second conversion pass.
 *
 * Every routine returns NEED_MORE when the buffer ends mid-construct; the
 * caller keeps the unconsumed tail and retries once more data arrives, so
 * chunk boundaries may fall anywhere (including inside tags and entities).
 * Nothing is implicitly self-closing (XML semantics — only `/>` counts).
 */
import { parseXmltvDate, XmltvDateError } from './date.js';
import type { XmltvDate, XmltvTimezoneOffsets } from './date.js';
import { decodeEntities } from './escape.js';
import type {
  XmltvActor,
  XmltvAudio,
  XmltvChannel,
  XmltvCredits,
  XmltvDocumentMeta,
  XmltvEpisodeNum,
  XmltvExtraElement,
  XmltvIcon,
  XmltvImage,
  XmltvLength,
  XmltvParseEvent,
  XmltvParseOptions,
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
  XmltvWarning,
} from './types.js';

const NEED_MORE: unique symbol = Symbol('xmltv-need-more');
type NeedMore = typeof NEED_MORE;

/** matchClose(): the close tag at this position belongs to another element. */
const NO_MATCH = -1;

/** `#skipSpecial`: `lt` does not start a comment, CDATA section or PI. */
const NOT_SPECIAL = -1;

const COMMENT_OPEN = '<!--';
const COMMENT_CLOSE = '-->';
const CDATA_OPEN = '<![CDATA[';
const CDATA_CLOSE = ']]>';
const PI_OPEN = '<?';
const PI_CLOSE = '?>';

/** Default cap on how much head is buffered while searching for the root tag. */
const DEFAULT_ROOT_SCAN_LIMIT = 1_048_576;

const TV_META_ATTR_KEYS: Record<string, keyof XmltvDocumentMeta & string> = {
  'source-info-name': 'sourceInfoName',
  'source-info-url': 'sourceInfoUrl',
  'source-data-url': 'sourceDataUrl',
  'generator-info-name': 'generatorInfoName',
  'generator-info-url': 'generatorInfoUrl',
};

const GT = '>'.charCodeAt(0);
const SLASH = '/'.charCodeAt(0);
const EQ = '='.charCodeAt(0);
const QUOT = '"'.charCodeAt(0);
const APOS = "'".charCodeAt(0);
const SPACE = ' '.charCodeAt(0);
const TAB = '\t'.charCodeAt(0);
const LF = '\n'.charCodeAt(0);
const CR = '\r'.charCodeAt(0);
const BANG = '!'.charCodeAt(0);
const QUESTION = '?'.charCodeAt(0);

/**
 * Char-classification tables for the tag scanner's inner loops, indexed by
 * charcode (ASCII 0–127; higher codes read `undefined` → falsy, which is
 * correct — they're all name characters). One typed-array load per character
 * replaces a private-method call plus a chain of `===` comparisons, and this
 * runs on every byte of every tag name and attribute name.
 */
const WS_TABLE = new Uint8Array(128);
WS_TABLE[SPACE] = WS_TABLE[TAB] = WS_TABLE[LF] = WS_TABLE[CR] = 1;

/** Terminates a tag or attribute name: whitespace or one of `> / =`. */
const NAME_END_TABLE = new Uint8Array(128);
NAME_END_TABLE[SPACE] = NAME_END_TABLE[TAB] = NAME_END_TABLE[LF] = NAME_END_TABLE[CR] = 1;
NAME_END_TABLE[GT] = NAME_END_TABLE[SLASH] = NAME_END_TABLE[EQ] = 1;

const CLOSED: unique symbol = Symbol('closed');

type CreditRole = keyof XmltvCredits;

/**
 * A programme under construction: identical to {@link XmltvProgramme} except
 * `start` — the one attribute whose absence drops the whole element — is
 * optional until validated. Once `start` is confirmed present (and since the
 * child loop only ever adds optional fields), the draft genuinely is a
 * complete programme and is returned via a checked `as XmltvProgramme`.
 */
type ProgrammeDraft = Omit<XmltvProgramme, 'start'> & { start?: Date };

const CREDIT_ROLES: ReadonlySet<string> = new Set([
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
] satisfies CreditRole[]);

/**
 * XMLTV scanner. Holds the scan state (`pos`, current tag scratch) as
 * instance fields; helpers write their "out" values there instead of
 * allocating result tuples. Methods must copy tag state to locals BEFORE
 * parsing nested content (nested readTag calls overwrite the scratch).
 */
export class XmltvScanner {
  /** Position after the last successfully consumed construct. */
  #pos = 0;

  #rootFound = false;
  #tagName = '';
  /** Flat pairs: `[key0, value0, key1, value1, ...]`. */
  #tagAttrs: string[] | null = null;

  /** The last CDATA section's contents, when `#skipSpecial` was asked to keep it. */
  #cdata = '';
  /**
   * Buffer index of each attribute's name start, parallel to `#tagAttrs`:
   * `#tagAttrPositions[j]` is where the attribute at `#tagAttrs[2j]` began.
   * Pushed in lockstep with `#tagAttrs` (so it is non-null whenever
   * `#tagAttrs` is), letting per-attribute warnings point at the attribute
   * rather than the enclosing tag's `<` — exact even for repeated attribute
   * names, which a lazy by-name lookup could not resolve.
   */
  #tagAttrPositions: number[] | null = null;
  #tagSelfClosing = false;
  /** Buffer index of the current tag's '<' (set by readTag). */
  #tagStart = 0;

  // Position tracking for warnings: `line`/`col` describe buf[0]; advance()
  // updates them whenever consumed input is trimmed off the buffer.
  #line = 1;
  #col = 0;
  readonly #pendingWarnings: XmltvWarning[] = [];

  /** Keep <channel>/<programme> whose required id/channel is missing. */
  readonly #tolerateMissingId: boolean;
  /** Cap on head buffered while searching for the root <tv> tag. */
  readonly #rootScanLimit: number;
  /** Named timezone abbreviation → offset minutes, for datetime parsing. */
  readonly #timezones: XmltvTimezoneOffsets | undefined;

  constructor(options: XmltvParseOptions = {}) {
    this.#tolerateMissingId = options.tolerateMissingId ?? false;
    this.#rootScanLimit = options.rootScanLimit ?? DEFAULT_ROOT_SCAN_LIMIT;
    this.#timezones = options.timezones;
  }

  /**
   * Record a warning anchored at index `at` of `buf`. Warnings are buffered
   * and yielded only when the surrounding element parses to completion — a
   * NEED_MORE retry re-parses the element from scratch and would otherwise
   * report duplicates.
   */
  #warn(buf: string, at: number, code: XmltvWarning['code'], message: string): void {
    let count = 0;
    let last = -1;
    let idx = buf.indexOf('\n');

    while (idx !== -1 && idx < at) {
      count++;
      last = idx;
      idx = buf.indexOf('\n', idx + 1);
    }

    this.#pendingWarnings.push({
      code,
      message,
      line: this.#line + count,
      col: count > 0 ? at - last : this.#col + at + 1,
    });
  }

  /** Warn that a recognized value was present but empty, so it was dropped. Shared by every empty-value site. */
  #warnEmpty(buf: string, at: number, code: XmltvWarning['code'], label: string): void {
    this.#warn(buf, at, code, `empty value for ${label} dropped`);
  }

  /** Empty recognized attribute `attr` on `<element>`. */
  #warnEmptyAttr(buf: string, at: number, attr: string, element: string): void {
    this.#warnEmpty(buf, at, 'invalid-attribute', `${attr} on <${element}>`);
  }

  /**
   * A DTD single-occurrence element repeated: first occurrence wins, so warn
   * (anchored at this later one) and skip its subtree unparsed. `container`
   * names the enclosing element for a nested child (e.g. `<present>` in
   * `<video>`). Returns NEED_MORE if the subtree is incomplete.
   */
  #skipDuplicateElement(
    buf: string,
    at: number,
    name: string,
    container?: string,
  ): true | NeedMore {
    const where = container ? ` in <${container}>` : ' element';
    this.#warn(
      buf,
      at,
      'invalid-element',
      `duplicate <${name}>${where} ignored, keeping the first`,
    );
    return this.#discardContent(buf);
  }

  /**
   * Parse a date value and pass it to `setter`, or warn and apply nothing.
   * Centralizes the empty- and invalid-value warnings for every date field;
   * the invalid case carries the {@link XmltvDateError} reason and index so the
   * warning shows what is wrong and where. Mirrors {@link #applyYesNo}: never
   * assigns `undefined` under `exactOptionalPropertyTypes`.
   */
  #applyDate(
    buf: string,
    at: number,
    code: XmltvWarning['code'],
    label: string,
    value: string | undefined,
    setter: (date: XmltvDate) => void,
  ): void {
    if (!value) {
      this.#warnEmpty(buf, at, code, label);
      return;
    }

    try {
      setter(parseXmltvDate(value, this.#timezones));
    } catch (error) {
      const detail =
        error instanceof XmltvDateError ? `: ${error.reason} at index ${error.index}` : '';
      this.#warn(buf, at, code, `invalid value "${value}" for ${label} dropped${detail}`);
    }
  }

  /** Yield and clear the warnings buffered for the completed construct. */
  *#takeWarnings(): Generator<XmltvParseEvent> {
    if (this.#pendingWarnings.length > 0) {
      for (const value of this.#pendingWarnings.splice(0)) {
        yield { type: 'warning', value };
      }
    }
  }

  /** Truncation warning event for input dropped at the end of the stream. */
  #truncated(buf: string, lt: number): XmltvParseEvent {
    this.#pendingWarnings.length = 0;

    this.#warn(
      buf,
      lt,
      'truncated-input',
      `dropped ${buf.length - lt} unparsed trailing character(s) at end of input`,
    );

    return { type: 'warning', value: this.#pendingWarnings.pop()! };
  }

  /**
   * Trim `consumed` characters off the buffer, updating line/col tracking.
   * `checkRootLimit` guards against buffering unbounded input while the root
   * `<tv>` element has not yet been found (e.g. a non-XML stream, or a
   * preamble comment that never closes) — every caller that passes it is
   * about to carry `buf.length - consumed` bytes over to the next chunk.
   * Only meaningful before the root is found: once `consume` is buffering a
   * single whole document in one call, the root is always found in the very
   * first iteration, long before this could fire.
   */
  #advance(buf: string, consumed: number, checkRootLimit = false): string {
    if (checkRootLimit && !this.#rootFound && buf.length - consumed > this.#rootScanLimit) {
      throw new TypeError(
        `No root element found within the first ${this.#rootScanLimit} characters of input`,
      );
    }

    let count = 0;
    let last = -1;
    let idx = buf.indexOf('\n');

    while (idx !== -1 && idx < consumed) {
      count++;
      last = idx;
      idx = buf.indexOf('\n', idx + 1);
    }

    if (count > 0) {
      this.#line += count;
      this.#col = consumed - last - 1;
    } else {
      this.#col += consumed;
    }

    return buf.slice(consumed);
  }

  /** Convert the scanner's internal pairs into the public `Record` shape. */
  #toRecord(pairs: string[]): Record<string, string> {
    const record: Record<string, string> = {};

    for (let i = 0; i < pairs.length; i += 2) {
      record[pairs[i]!] = pairs[i + 1]!;
    }

    return record;
  }

  /**
   * Classify a DTD yes/no value ("yes" → true, "no" → false, anything else
   * → unresolved) and assign it via `setter`; warn if it's non-empty but
   * neither. Never assigns when unresolved — with `exactOptionalPropertyTypes`,
   * explicitly assigning `undefined` would create the property rather than
   * leave it absent, breaking the "undefined means not present" contract
   * these fields document.
   */
  #applyYesNo(
    buf: string,
    at: number,
    code: XmltvWarning['code'],
    label: string,
    text: string | undefined,
    setter: (value: boolean) => void,
  ): void {
    if (text === 'yes') {
      setter(true);
    } else if (text === 'no') {
      setter(false);
    } else if (text) {
      this.#warn(buf, at, code, `invalid value "${text}" for ${label} dropped (expected yes|no)`);
    } else {
      this.#warnEmpty(buf, at, code, label);
    }
  }

  /**
   * Skip the comment, CDATA section or processing instruction at `lt`.
   *
   * Returns the index just past it, {@link NEED_MORE} when the buffer ends
   * before its close, or {@link NOT_SPECIAL} when `lt` starts none of the
   * three — a `<!DOCTYPE`, say, which the caller consumes as a stray element.
   *
   * With `collect`, a CDATA section's contents are left in {@link #cdata} for
   * the caller to append; without it nothing is sliced, since most callers
   * throw the text away.
   */
  #skipSpecial(buf: string, lt: number, collect = false): number | NeedMore {
    // `#cdata` is cleared per branch rather than up front, so the common
    // answer — an ordinary tag, none of the three — writes nothing at all.
    if (buf.startsWith(COMMENT_OPEN, lt)) {
      const end = buf.indexOf(COMMENT_CLOSE, lt + COMMENT_OPEN.length);

      if (end === NO_MATCH) {
        return NEED_MORE;
      }

      this.#cdata = '';

      return end + COMMENT_CLOSE.length;
    }

    if (buf.startsWith(CDATA_OPEN, lt)) {
      const end = buf.indexOf(CDATA_CLOSE, lt + CDATA_OPEN.length);

      if (end === NO_MATCH) {
        return NEED_MORE;
      }

      this.#cdata = collect ? buf.slice(lt + CDATA_OPEN.length, end) : '';

      return end + CDATA_CLOSE.length;
    }

    if (buf.startsWith(PI_OPEN, lt)) {
      const end = buf.indexOf(PI_CLOSE, lt + PI_OPEN.length);

      if (end === NO_MATCH) {
        return NEED_MORE;
      }

      this.#cdata = '';

      return end + PI_CLOSE.length;
    }

    return NOT_SPECIAL;
  }

  /**
   * True when the '<' at `lt` might be the (truncated) start of a comment or
   * CDATA section that needs more data to classify.
   */
  #isPartialSpecial(buf: string, lt: number): boolean {
    const rest = buf.length - lt;
    return (
      (rest < CDATA_OPEN.length && CDATA_OPEN.startsWith(buf.slice(lt))) ||
      (rest < COMMENT_OPEN.length && COMMENT_OPEN.startsWith(buf.slice(lt)))
    );
  }

  /**
   * Read an element open tag starting at `lt` (pointing at '<'). On success
   * fills the tag scratch state and sets `this.#pos` past the closing '>'.
   * The attrs object (when any) is freshly allocated and safe to keep.
   */
  #readTag(buf: string, lt: number): true | NeedMore {
    const len = buf.length;
    let i = lt + 1;
    const nameStart = i;

    while (i < len && !NAME_END_TABLE[buf.charCodeAt(i)]) {
      i++;
    }

    if (i >= len) {
      return NEED_MORE;
    }

    this.#tagName = buf.slice(nameStart, i);
    this.#tagAttrs = null;
    this.#tagAttrPositions = null;
    this.#tagSelfClosing = false;
    this.#tagStart = lt;

    while (true) {
      while (i < len && WS_TABLE[buf.charCodeAt(i)]) {
        i++;
      }

      if (i >= len) {
        return NEED_MORE;
      }

      const code = buf.charCodeAt(i);

      if (code === GT) {
        this.#pos = i + 1;
        return true;
      }

      if (code === SLASH) {
        if (i + 1 >= len) {
          return NEED_MORE;
        }

        if (buf.charCodeAt(i + 1) === GT) {
          this.#tagSelfClosing = true;
          this.#pos = i + 2;
          return true;
        }

        i++; // stray slash — tolerate
        continue;
      }

      // Attribute name.
      const attrStart = i;

      while (i < len && !NAME_END_TABLE[buf.charCodeAt(i)]) {
        i++;
      }

      if (i >= len) {
        return NEED_MORE;
      }

      const attrName = buf.slice(attrStart, i);

      while (i < len && WS_TABLE[buf.charCodeAt(i)]) {
        i++;
      }

      if (i >= len) {
        return NEED_MORE;
      }

      if (buf.charCodeAt(i) !== EQ) {
        // Valueless attribute (invalid XML, tolerated).
        if (attrName) {
          this.#pushAttr(buf, attrStart, attrName, '');
        }

        continue;
      }

      i++;

      while (i < len && WS_TABLE[buf.charCodeAt(i)]) {
        i++;
      }

      if (i >= len) {
        return NEED_MORE;
      }

      const quote = buf.charCodeAt(i);

      if (quote === QUOT || quote === APOS) {
        const valueStart = i + 1;
        const valueEnd = buf.indexOf(quote === QUOT ? '"' : "'", valueStart);

        if (valueEnd === -1) {
          return NEED_MORE;
        }

        this.#pushAttr(buf, attrStart, attrName, decodeEntities(buf.slice(valueStart, valueEnd)));
        i = valueEnd + 1;
      } else {
        // Unquoted value (invalid XML, tolerated): read until whitespace or
        // '>'. A '/' terminates the value only when it is the self-close
        // slash (immediately followed by '>') — a bare '/' is kept, since
        // unquoted URLs (`src=http://x/y.jpg`) are the main reason this path
        // exists. A trailing '/' at the buffer edge stays ambiguous, so we
        // fall through to the NEED_MORE check and wait for the next chunk.
        const valueStart = i;

        while (i < len) {
          const c = buf.charCodeAt(i);

          if (WS_TABLE[c] || c === GT || (c === SLASH && buf.charCodeAt(i + 1) === GT)) {
            break;
          }

          i++;
        }

        if (i >= len) {
          return NEED_MORE;
        }

        this.#pushAttr(buf, attrStart, attrName, decodeEntities(buf.slice(valueStart, i)));
      }
    }
  }

  /**
   * Store one parsed attribute (found at index `at` in `buf`) into
   * `this.#tagAttrs`/`this.#tagAttrPositions`. Two names get special handling:
   *
   * - "__proto__" is dropped with a warning — its plain assignment
   *   (`obj[name] = value`) is silently diverted to the prototype accessor
   *   instead of creating a normal data property.
   * - a name already present on this tag is a duplicate (a well-formedness
   *   error): the first occurrence wins and this repeat is dropped with a
   *   warning at its own offset, naming the ignored value — matching the
   *   first-wins rule for duplicate single-occurrence elements. The scan is
   *   over the attributes already collected on this tag only — near-zero, and
   *   the common single-attribute tag never scans since `#tagAttrs` is still
   *   null on the first push.
   */
  #pushAttr(buf: string, at: number, name: string, value: string): void {
    if (name === '__proto__') {
      return this.#warn(
        buf,
        at,
        'invalid-attribute',
        'attribute name "__proto__" is not supported and was dropped',
      );
    }

    const attrs = this.#tagAttrs;

    if (attrs) {
      for (let j = 0; j < attrs.length; j += 2) {
        if (attrs[j] === name) {
          return this.#warn(
            buf,
            at,
            'invalid-attribute',
            `duplicate attribute ${name}="${value}" ignored, keeping the first`,
          );
        }
      }
    }

    (this.#tagAttrs ??= []).push(name, value);
    (this.#tagAttrPositions ??= []).push(at);
  }

  /**
   * Collect the raw text content of `name` up to (and consuming) its close
   * tag. Comments are skipped, CDATA is appended verbatim, nested markup is
   * skipped entirely (XMLTV text elements are #PCDATA). Sets `this.#pos` past
   * the close tag and returns the raw (undecoded, untrimmed) text.
   */
  #readTextContent(buf: string, pos: number, name: string, collect = true): string | NeedMore {
    let text = '';
    let i = pos;

    while (true) {
      const lt = buf.indexOf('<', i);

      if (lt === -1) {
        return NEED_MORE;
      }

      if (collect && lt > i) {
        text += buf.slice(i, lt);
      }

      const marker = buf.charCodeAt(lt + 1);

      // The overwhelmingly common `<` in text content is the element's own
      // close tag; peeking the one char after `<` reaches it without the
      // comment / CDATA / PI probes below (and `NaN` — a trailing `<` at the
      // buffer edge — falls through to skipElement, which defers via readTag).
      if (marker === SLASH) {
        const closeEnd = this.#matchClose(buf, lt, name);

        if (closeEnd === NEED_MORE) {
          return NEED_MORE;
        }

        if (closeEnd !== NO_MATCH) {
          this.#pos = closeEnd;
          return text;
        }

        // Mismatched close tag inside text content — skip it.
        this.#warn(buf, lt, 'malformed-markup', `skipped mismatched close tag inside <${name}>`);
        const gt = buf.indexOf('>', lt);

        if (gt === -1) {
          return NEED_MORE;
        }

        i = gt + 1;
        continue;
      }

      // `<!` or `<?`: comment, CDATA, or PI (or a partial one needing more data).
      if (marker === BANG || marker === QUESTION) {
        if (this.#isPartialSpecial(buf, lt)) {
          return NEED_MORE;
        }

        const skipped = this.#skipSpecial(buf, lt, collect);

        if (skipped === NEED_MORE) {
          return NEED_MORE;
        }

        if (skipped !== NOT_SPECIAL) {
          text += this.#cdata;
          i = skipped;
          continue;
        }
        // `<!` that is not a comment/CDATA (e.g. DOCTYPE): fall through and let
        // skipElement consume it like any other stray element.
      }

      // Nested element inside a text element — not valid XMLTV; skip it,
      // warning once (for the real text element, not while already skipping).
      if (this.#skipElement(buf, lt, name, collect) === NEED_MORE) {
        return NEED_MORE;
      }

      i = this.#pos;
    }
  }

  /**
   * Skip a whole element (open tag at `lt`) including its content. When `warn`
   * is set, records that this element appeared where only text is allowed
   * (inside text element `container`) — anchored at the immediate element,
   * captured here before any deeper nesting reassigns `#tagName`.
   */
  #skipElement(buf: string, lt: number, container: string, warn: boolean): true | NeedMore {
    if (this.#readTag(buf, lt) === NEED_MORE) {
      return NEED_MORE;
    }

    if (warn && this.#tagName !== '') {
      this.#warn(
        buf,
        lt,
        'unknown-element',
        `nested <${this.#tagName}> inside text element <${container}> ignored`,
      );
    }

    if (this.#tagSelfClosing || this.#tagName === '') {
      return true;
    }

    return this.#readTextContent(buf, this.#pos, this.#tagName, false) === NEED_MORE
      ? NEED_MORE
      : true;
  }

  /**
   * Match the close tag `</name ws* >` whose '</' is at `lt`. Returns the
   * position after its '>', NO_MATCH when this is some other (stray) close
   * tag, or NEED_MORE when the buffer ends before it can be decided.
   */
  #matchClose(buf: string, lt: number, name: string): number | NeedMore {
    const len = buf.length;

    if (len - lt < name.length + 3) {
      return NEED_MORE; // possibly the truncated close tag
    }

    if (buf.startsWith(name, lt + 2)) {
      let j = lt + 2 + name.length;

      while (j < len && WS_TABLE[buf.charCodeAt(j)]) {
        j++;
      }

      if (j >= len) {
        return NEED_MORE;
      }

      if (buf.charCodeAt(j) === GT) {
        return j + 1;
      }
    }

    return NO_MATCH;
  }

  // ---------------------------------------------------------------------------
  // Child element parsers. Each is called right after the caller's this.#readTag()
  // classified the child, reads the scratch tag state first, and consumes the
  // child's content (advancing `this.#pos` past its close tag).
  // ---------------------------------------------------------------------------

  #textValueChild(buf: string): XmltvTextValue | NeedMore {
    const name = this.#tagName;
    const attrs = this.#tagAttrs;
    const positions = this.#tagAttrPositions;
    const selfClosing = this.#tagSelfClosing;
    let raw = '';

    if (!selfClosing) {
      const content = this.#readTextContent(buf, this.#pos, name);

      if (content === NEED_MORE) {
        return NEED_MORE;
      }

      raw = content;
    }

    const value: XmltvTextValue = { value: decodeEntities(raw.trim()) };

    for (let i = 0; attrs && i < attrs.length; i += 2) {
      const key = attrs[i]!;
      const attrValue = attrs[i + 1]!;

      if (key === 'lang') {
        if (attrValue) {
          value.lang = attrValue;
        } else {
          this.#warnEmptyAttr(buf, positions![i >> 1]!, 'lang', name);
        }
      } else {
        (value.extraAttributes ??= {})[key] = attrValue;
      }
    }

    return value;
  }

  #stringChild(buf: string): string | NeedMore {
    if (this.#tagSelfClosing) {
      return '';
    }

    const content = this.#readTextContent(buf, this.#pos, this.#tagName);
    return content === NEED_MORE ? NEED_MORE : decodeEntities(content.trim());
  }

  /** Consume the child's content, ignoring it (for attribute-only elements). */
  #discardContent(buf: string): true | NeedMore {
    if (this.#tagSelfClosing) {
      return true;
    }

    return this.#readTextContent(buf, this.#pos, this.#tagName, false) === NEED_MORE
      ? NEED_MORE
      : true;
  }

  #iconChild(buf: string): XmltvIcon | null | NeedMore {
    const attrs = this.#tagAttrs;
    const positions = this.#tagAttrPositions;
    const at = this.#tagStart;

    if (this.#discardContent(buf) === NEED_MORE) {
      return NEED_MORE;
    }

    const icon: XmltvIcon = { src: '' };

    for (let i = 0; attrs && i < attrs.length; i += 2) {
      const key = attrs[i]!;
      const value = attrs[i + 1]!;
      const pos = positions![i >> 1]!;

      switch (key) {
        case 'src':
          icon.src = value;
          break;
        case 'width':
          if (value) {
            const width = Number(value);

            if (Number.isFinite(width)) {
              icon.width = width;
            } else {
              this.#warn(
                buf,
                pos,
                'invalid-attribute',
                `invalid width="${value}" on <icon> dropped`,
              );
            }
          } else {
            this.#warnEmptyAttr(buf, pos, 'width', 'icon');
          }

          break;
        case 'height':
          if (value) {
            const height = Number(value);

            if (Number.isFinite(height)) {
              icon.height = height;
            } else {
              this.#warn(
                buf,
                pos,
                'invalid-attribute',
                `invalid height="${value}" on <icon> dropped`,
              );
            }
          } else {
            this.#warnEmptyAttr(buf, pos, 'height', 'icon');
          }

          break;
        default:
          (icon.extraAttributes ??= {})[key] = value;
          break;
      }
    }

    if (!icon.src) {
      this.#warn(buf, at, 'invalid-element', '<icon> without a src attribute dropped');
      return null;
    }

    return icon;
  }

  #urlChild(buf: string): XmltvUrlValue | NeedMore {
    const attrs = this.#tagAttrs;
    const positions = this.#tagAttrPositions;
    let system: string | undefined;
    let extraAttributes: Record<string, string> | undefined;

    for (let i = 0; attrs && i < attrs.length; i += 2) {
      const key = attrs[i]!;
      const value = attrs[i + 1]!;

      if (key === 'system') {
        if (value) {
          system = value;
        } else {
          this.#warnEmptyAttr(buf, positions![i >> 1]!, 'system', 'url');
        }
      } else {
        (extraAttributes ??= {})[key] = value;
      }
    }

    const text = this.#stringChild(buf);

    if (text === NEED_MORE) {
      return NEED_MORE;
    }

    if (!system && !extraAttributes) {
      return text;
    }

    const url: XmltvUrl = { value: text };

    if (system) {
      url.system = system;
    }

    if (extraAttributes) {
      url.extraAttributes = extraAttributes;
    }

    return url;
  }

  #imageChild(buf: string): XmltvImage | NeedMore {
    const attrs = this.#tagAttrs;
    const positions = this.#tagAttrPositions;
    const text = this.#stringChild(buf);

    if (text === NEED_MORE) {
      return NEED_MORE;
    }

    const image: XmltvImage = { value: text };

    for (let i = 0; attrs && i < attrs.length; i += 2) {
      const key = attrs[i]!;
      const value = attrs[i + 1]!;
      const pos = positions![i >> 1]!;

      switch (key) {
        case 'type':
          if (
            value === 'poster' ||
            value === 'backdrop' ||
            value === 'still' ||
            value === 'person' ||
            value === 'character'
          ) {
            image.type = value;
          } else if (value) {
            this.#warn(buf, pos, 'invalid-attribute', `invalid type="${value}" on <image> dropped`);
          } else {
            this.#warnEmptyAttr(buf, pos, 'type', 'image');
          }
          break;
        case 'size':
          if (value === '1' || value === '2' || value === '3') {
            image.size = value;
          } else if (value) {
            this.#warn(buf, pos, 'invalid-attribute', `invalid size="${value}" on <image> dropped`);
          } else {
            this.#warnEmptyAttr(buf, pos, 'size', 'image');
          }
          break;
        case 'orient':
          if (value === 'P' || value === 'L') {
            image.orient = value;
          } else if (value) {
            this.#warn(
              buf,
              pos,
              'invalid-attribute',
              `invalid orient="${value}" on <image> dropped`,
            );
          } else {
            this.#warnEmptyAttr(buf, pos, 'orient', 'image');
          }
          break;
        case 'system':
          if (value) {
            image.system = value;
          } else {
            this.#warnEmptyAttr(buf, pos, 'system', 'image');
          }
          break;
        default:
          (image.extraAttributes ??= {})[key] = value;
          break;
      }
    }

    return image;
  }

  #reviewChild(buf: string): XmltvReview | NeedMore {
    const attrs = this.#tagAttrs;
    const positions = this.#tagAttrPositions;
    const text = this.#stringChild(buf);

    if (text === NEED_MORE) {
      return NEED_MORE;
    }

    // `type` defaults to "text" and is only overridden to "url"; any other
    // non-empty value is dropped with a warning anchored at its offset.
    const review: XmltvReview = { type: 'text', value: text };

    for (let i = 0; attrs && i < attrs.length; i += 2) {
      const key = attrs[i]!;
      const value = attrs[i + 1]!;
      const pos = positions![i >> 1]!;

      switch (key) {
        case 'type':
          if (value === 'url') {
            review.type = 'url';
          } else if (value && value !== 'text') {
            this.#warn(
              buf,
              pos,
              'invalid-attribute',
              `invalid type="${value}" on <review>, using "text"`,
            );
          } else if (!value) {
            this.#warnEmptyAttr(buf, pos, 'type', 'review');
          }

          break;
        case 'source':
          if (value) {
            review.source = value;
          } else {
            this.#warnEmptyAttr(buf, pos, 'source', 'review');
          }

          break;
        case 'reviewer':
          if (value) {
            review.reviewer = value;
          } else {
            this.#warnEmptyAttr(buf, pos, 'reviewer', 'review');
          }

          break;
        case 'lang':
          if (value) {
            review.lang = value;
          } else {
            this.#warnEmptyAttr(buf, pos, 'lang', 'review');
          }

          break;
        default:
          (review.extraAttributes ??= {})[key] = value;
          break;
      }
    }

    return review;
  }

  #flagChild(buf: string): XmltvTextValue | true | NeedMore {
    const value = this.#textValueChild(buf);

    if (value === NEED_MORE) {
      return NEED_MORE;
    }

    return value.value !== '' ? value : true;
  }

  #lengthChild(buf: string): XmltvProgramme['length'] | null | NeedMore {
    const attrs = this.#tagAttrs;
    const at = this.#tagStart;
    const text = this.#stringChild(buf);

    if (text === NEED_MORE) {
      return NEED_MORE;
    }

    const value = Number(text);
    let units: string | undefined;
    let extraAttributes: Record<string, string> | undefined;

    for (let i = 0; attrs && i < attrs.length; i += 2) {
      const key = attrs[i]!;
      const val = attrs[i + 1]!;

      if (key === 'units') {
        units = val;
      } else {
        (extraAttributes ??= {})[key] = val;
      }
    }

    // `units` (an enum) and the numeric text together gate the element. The
    // positive check narrows `units` to its literal type, so the length is
    // built fully typed with no cast; anything else is dropped, the raw units
    // echoed in the warning.
    if (
      (units === 'seconds' || units === 'minutes' || units === 'hours') &&
      Number.isFinite(value)
    ) {
      const length: XmltvLength = { units, value };

      if (extraAttributes) {
        length.extraAttributes = extraAttributes;
      }

      return length;
    }

    this.#warn(
      buf,
      at,
      'invalid-element',
      `<length units="${units ?? ''}">${text}</length> dropped`,
    );
    return null;
  }

  #episodeNumChild(buf: string): XmltvEpisodeNum | NeedMore {
    const attrs = this.#tagAttrs;
    const positions = this.#tagAttrPositions;
    const text = this.#stringChild(buf);

    if (text === NEED_MORE) {
      return NEED_MORE;
    }

    const episode: XmltvEpisodeNum = { value: text };

    for (let i = 0; attrs && i < attrs.length; i += 2) {
      const key = attrs[i]!;
      const value = attrs[i + 1]!;

      if (key === 'system') {
        if (value) {
          episode.system = value;
        } else {
          this.#warnEmptyAttr(buf, positions![i >> 1]!, 'system', 'episode-num');
        }
      } else {
        (episode.extraAttributes ??= {})[key] = value;
      }
    }

    return episode;
  }

  #previouslyShownChild(buf: string): XmltvPreviouslyShown | NeedMore {
    const attrs = this.#tagAttrs;
    const positions = this.#tagAttrPositions;

    if (this.#discardContent(buf) === NEED_MORE) {
      return NEED_MORE;
    }

    const shown: XmltvPreviouslyShown = {};

    for (let i = 0; attrs && i < attrs.length; i += 2) {
      const key = attrs[i]!;
      const value = attrs[i + 1]!;
      const pos = positions![i >> 1]!;

      switch (key) {
        case 'start':
          this.#applyDate(
            buf,
            pos,
            'invalid-attribute',
            'start on <previously-shown>',
            value,
            (d) => {
              shown.start = d;
            },
          );

          break;
        case 'channel':
          if (value) {
            shown.channel = value;
          } else {
            this.#warnEmptyAttr(buf, pos, 'channel', 'previously-shown');
          }

          break;
        default:
          (shown.extraAttributes ??= {})[key] = value;
          break;
      }
    }

    return shown;
  }

  /** `<rating>` / `<star-rating>`: `(value, icon*)`. */
  #ratingChild(buf: string): XmltvRating | null | NeedMore {
    const name = this.#tagName;
    const attrs = this.#tagAttrs;
    const positions = this.#tagAttrPositions;
    const at = this.#tagStart;
    const selfClosing = this.#tagSelfClosing;

    let value: string | undefined;
    let icons: XmltvIcon[] | undefined;
    let extras: XmltvExtraElement[] | undefined;

    if (!selfClosing) {
      let i = this.#pos;

      while (true) {
        const step = this.#nextChild(buf, i, name);

        if (step === NEED_MORE) {
          return NEED_MORE;
        }

        if (step === CLOSED) {
          break;
        }

        if (this.#tagName === 'value') {
          if (value !== undefined) {
            if (this.#skipDuplicateElement(buf, this.#tagStart, 'value', name) === NEED_MORE) {
              return NEED_MORE;
            }
          } else {
            const text = this.#stringChild(buf);

            if (text === NEED_MORE) {
              return NEED_MORE;
            }

            value = text;
          }
        } else if (this.#tagName === 'icon') {
          const icon = this.#iconChild(buf);

          if (icon === NEED_MORE) {
            return NEED_MORE;
          }

          if (icon) {
            (icons ??= []).push(icon);
          }
        } else {
          const extra = this.#extraChild(buf);

          if (extra === NEED_MORE) {
            return NEED_MORE;
          }

          (extras ??= []).push(extra);
        }

        i = this.#pos;
      }
    }

    if (value === undefined) {
      this.#warn(buf, at, 'invalid-element', `<${name}> without a <value> child dropped`);
      return null;
    }

    const rating: XmltvRating = { value };

    if (icons) {
      rating.icon = icons;
    }

    if (extras) {
      rating.extra = extras;
    }

    for (let i = 0; attrs && i < attrs.length; i += 2) {
      const key = attrs[i]!;
      const val = attrs[i + 1]!;

      if (key === 'system') {
        if (val) {
          rating.system = val;
        } else {
          this.#warnEmptyAttr(buf, positions![i >> 1]!, 'system', name);
        }
      } else {
        (rating.extraAttributes ??= {})[key] = val;
      }
    }

    return rating;
  }

  #subtitlesChild(buf: string): XmltvSubtitles | NeedMore {
    const name = this.#tagName;
    const attrs = this.#tagAttrs;
    const positions = this.#tagAttrPositions;
    const selfClosing = this.#tagSelfClosing;
    const subtitles: XmltvSubtitles = {};

    for (let i = 0; attrs && i < attrs.length; i += 2) {
      const key = attrs[i]!;
      const value = attrs[i + 1]!;
      const pos = positions![i >> 1]!;

      if (key === 'type') {
        if (value === 'teletext' || value === 'onscreen' || value === 'deaf-signed') {
          subtitles.type = value;
        } else if (value) {
          this.#warn(
            buf,
            pos,
            'invalid-attribute',
            `invalid type="${value}" on <subtitles> dropped`,
          );
        } else {
          this.#warnEmptyAttr(buf, pos, 'type', 'subtitles');
        }
      } else {
        (subtitles.extraAttributes ??= {})[key] = value;
      }
    }

    if (!selfClosing) {
      let i = this.#pos;

      while (true) {
        const step = this.#nextChild(buf, i, name);

        if (step === NEED_MORE) {
          return NEED_MORE;
        }

        if (step === CLOSED) {
          break;
        }

        if (this.#tagName === 'language') {
          if (subtitles.language !== undefined) {
            if (this.#skipDuplicateElement(buf, this.#tagStart, 'language', name) === NEED_MORE) {
              return NEED_MORE;
            }
          } else {
            const language = this.#textValueChild(buf);

            if (language === NEED_MORE) {
              return NEED_MORE;
            }

            subtitles.language = language;
          }
        } else {
          const extra = this.#extraChild(buf);

          if (extra === NEED_MORE) {
            return NEED_MORE;
          }

          (subtitles.extra ??= []).push(extra);
        }

        i = this.#pos;
      }
    }

    return subtitles;
  }

  #videoChild(buf: string): XmltvVideo | NeedMore {
    const name = this.#tagName;
    const selfClosing = this.#tagSelfClosing;
    const video: XmltvVideo = {};

    if (this.#tagAttrs) {
      video.extraAttributes = this.#toRecord(this.#tagAttrs);
    }

    if (!selfClosing) {
      let i = this.#pos;

      while (true) {
        const step = this.#nextChild(buf, i, name);

        if (step === NEED_MORE) {
          return NEED_MORE;
        }

        if (step === CLOSED) {
          break;
        }

        const child = this.#tagName;
        const childAt = this.#tagStart;

        if (
          child === 'present' ||
          child === 'colour' ||
          child === 'aspect' ||
          child === 'quality'
        ) {
          if (video[child] !== undefined) {
            if (this.#skipDuplicateElement(buf, childAt, child, name) === NEED_MORE) {
              return NEED_MORE;
            }
          } else {
            const text = this.#stringChild(buf);

            if (text === NEED_MORE) {
              return NEED_MORE;
            }

            if (child === 'present') {
              this.#applyYesNo(
                buf,
                childAt,
                'invalid-element',
                '<present> on <video>',
                text,
                (v) => {
                  video.present = v;
                },
              );
            } else if (child === 'colour') {
              this.#applyYesNo(
                buf,
                childAt,
                'invalid-element',
                '<colour> on <video>',
                text,
                (v) => {
                  video.colour = v;
                },
              );
            } else if (child === 'aspect') {
              video.aspect = text;
            } else {
              video.quality = text;
            }
          }
        } else {
          const extra = this.#extraChild(buf);

          if (extra === NEED_MORE) {
            return NEED_MORE;
          }

          (video.extra ??= []).push(extra);
        }

        i = this.#pos;
      }
    }

    return video;
  }

  #audioChild(buf: string): XmltvAudio | NeedMore {
    const name = this.#tagName;
    const selfClosing = this.#tagSelfClosing;
    const audio: XmltvAudio = {};

    if (this.#tagAttrs) {
      audio.extraAttributes = this.#toRecord(this.#tagAttrs);
    }

    if (!selfClosing) {
      let i = this.#pos;

      while (true) {
        const step = this.#nextChild(buf, i, name);

        if (step === NEED_MORE) {
          return NEED_MORE;
        }

        if (step === CLOSED) {
          break;
        }

        const child = this.#tagName;
        const childAt = this.#tagStart;

        if (child === 'present' || child === 'stereo') {
          if (audio[child] !== undefined) {
            if (this.#skipDuplicateElement(buf, childAt, child, name) === NEED_MORE) {
              return NEED_MORE;
            }
          } else {
            const text = this.#stringChild(buf);

            if (text === NEED_MORE) {
              return NEED_MORE;
            }

            if (child === 'present') {
              this.#applyYesNo(
                buf,
                childAt,
                'invalid-element',
                '<present> on <audio>',
                text,
                (v) => {
                  audio.present = v;
                },
              );
            } else {
              audio.stereo = text;
            }
          }
        } else {
          const extra = this.#extraChild(buf);

          if (extra === NEED_MORE) {
            return NEED_MORE;
          }

          (audio.extra ??= []).push(extra);
        }

        i = this.#pos;
      }
    }

    return audio;
  }

  /** A credits person: mixed content `(#PCDATA | image | url)*`. */
  #personChild(buf: string):
    | {
        value: string;
        image?: XmltvImage[];
        url?: XmltvUrlValue[];
        extra?: XmltvExtraElement[];
        attrs: string[] | null;
        positions: number[] | null;
      }
    | NeedMore {
    const name = this.#tagName;
    // Snapshot both, before parsing <image>/<url> children reassigns the
    // scratch, so the caller can anchor a `guest` warning at that attribute.
    const attrs = this.#tagAttrs;
    const positions = this.#tagAttrPositions;
    const selfClosing = this.#tagSelfClosing;
    let text = '';
    let image: XmltvImage[] | undefined;
    let url: XmltvUrlValue[] | undefined;
    let extras: XmltvExtraElement[] | undefined;

    if (!selfClosing) {
      let i = this.#pos;

      outer: while (true) {
        const lt = buf.indexOf('<', i);

        if (lt === -1) {
          return NEED_MORE;
        }

        if (lt > i) {
          text += buf.slice(i, lt);
        }

        if (buf.startsWith('</', lt)) {
          const closeEnd = this.#matchClose(buf, lt, name);

          if (closeEnd === NEED_MORE) {
            return NEED_MORE;
          }

          if (closeEnd !== NO_MATCH) {
            this.#pos = closeEnd;
            break outer;
          }

          // Stray close tag — skip it.
          this.#warn(buf, lt, 'malformed-markup', `skipped mismatched close tag inside <${name}>`);
          const gt = buf.indexOf('>', lt);

          if (gt === -1) {
            return NEED_MORE;
          }

          i = gt + 1;
          continue;
        }

        if (this.#isPartialSpecial(buf, lt)) {
          return NEED_MORE;
        }

        const skipped = this.#skipSpecial(buf, lt, true);

        if (skipped === NEED_MORE) {
          return NEED_MORE;
        }

        if (skipped !== NOT_SPECIAL) {
          text += this.#cdata;
          i = skipped;
          continue;
        }

        if (this.#readTag(buf, lt) === NEED_MORE) {
          return NEED_MORE;
        }

        if (this.#tagName === 'image') {
          const img = this.#imageChild(buf);

          if (img === NEED_MORE) {
            return NEED_MORE;
          }

          (image ??= []).push(img);
        } else if (this.#tagName === 'url') {
          const u = this.#urlChild(buf);

          if (u === NEED_MORE) {
            return NEED_MORE;
          }

          (url ??= []).push(u);
        } else {
          const extra = this.#extraChild(buf);

          if (extra === NEED_MORE) {
            return NEED_MORE;
          }

          (extras ??= []).push(extra);
        }

        i = this.#pos;
      }
    }

    const result: {
      value: string;
      image?: XmltvImage[];
      url?: XmltvUrlValue[];
      extra?: XmltvExtraElement[];
      attrs: string[] | null;
      positions: number[] | null;
    } = {
      value: decodeEntities(text.trim()),
      attrs,
      positions,
    };

    if (image) {
      result.image = image;
    }

    if (url) {
      result.url = url;
    }

    if (extras) {
      result.extra = extras;
    }

    return result;
  }

  #creditsChild(buf: string): XmltvCredits | null | NeedMore {
    const name = this.#tagName;
    const selfClosing = this.#tagSelfClosing;
    const credits: XmltvCredits = {};
    let any = false;

    if (!selfClosing) {
      let i = this.#pos;

      while (true) {
        const step = this.#nextChild(buf, i, name);

        if (step === NEED_MORE) {
          return NEED_MORE;
        }

        if (step === CLOSED) {
          break;
        }

        if (!CREDIT_ROLES.has(this.#tagName)) {
          const extra = this.#extraChild(buf);

          if (extra === NEED_MORE) {
            return NEED_MORE;
          }

          (credits.extra ??= []).push(extra);
          any = true;
          i = this.#pos;
          continue;
        }

        const role = this.#tagName as CreditRole;
        const person = this.#personChild(buf);

        if (person === NEED_MORE) {
          return NEED_MORE;
        }

        any = true;

        if (role === 'actor') {
          const actor: XmltvActor = { value: person.value };

          for (let j = 0; person.attrs && j < person.attrs.length; j += 2) {
            const key = person.attrs[j]!;
            const val = person.attrs[j + 1]!;
            const pos = person.positions![j >> 1]!;

            switch (key) {
              case 'role':
                if (val) {
                  actor.role = val;
                } else {
                  this.#warnEmptyAttr(buf, pos, 'role', 'actor');
                }

                break;
              case 'guest':
                this.#applyYesNo(buf, pos, 'invalid-attribute', 'guest on <actor>', val, (v) => {
                  actor.guest = v;
                });
                break;
              default:
                (actor.extraAttributes ??= {})[key] = val;
                break;
            }
          }

          if (person.image) {
            actor.image = person.image;
          }

          if (person.url) {
            actor.url = person.url;
          }

          if (person.extra) {
            actor.extra = person.extra;
          }

          (credits.actor ??= []).push(actor);
        } else {
          let value: XmltvPersonValue;
          // Non-actor roles have no known attributes at all — everything
          // present is an extension, so this is a plain pairs -> Record copy.
          const personExtras = person.attrs ? this.#toRecord(person.attrs) : undefined;

          if (person.image || person.url || person.extra || personExtras) {
            const rich: {
              value: string;
              image?: XmltvImage[];
              url?: XmltvUrlValue[];
              extra?: XmltvExtraElement[];
              extraAttributes?: Record<string, string>;
            } = {
              value: person.value,
            };

            if (person.image) {
              rich.image = person.image;
            }

            if (person.url) {
              rich.url = person.url;
            }

            if (person.extra) {
              rich.extra = person.extra;
            }

            if (personExtras) {
              rich.extraAttributes = personExtras;
            }

            value = rich;
          } else {
            value = person.value;
          }

          (credits[role] ??= []).push(value);
        }

        i = this.#pos;
      }
    }

    return any ? credits : null;
  }

  /** Capture an unknown element (open tag already read) as an extension. */
  #extraChild(buf: string): XmltvExtraElement | NeedMore {
    const name = this.#tagName;
    const attrs = this.#tagAttrs;
    const selfClosing = this.#tagSelfClosing;
    const extra: XmltvExtraElement = { name };

    if (attrs) {
      extra.attributes = this.#toRecord(attrs);
    }

    if (selfClosing) {
      return extra;
    }

    let text = '';
    let children: XmltvExtraElement[] | undefined;
    let i = this.#pos;

    outer: while (true) {
      const lt = buf.indexOf('<', i);

      if (lt === -1) {
        return NEED_MORE;
      }

      if (lt > i) {
        text += buf.slice(i, lt);
      }

      if (buf.startsWith('</', lt)) {
        const closeEnd = this.#matchClose(buf, lt, name);

        if (closeEnd === NEED_MORE) {
          return NEED_MORE;
        }

        if (closeEnd !== NO_MATCH) {
          this.#pos = closeEnd;
          break outer;
        }

        // Stray close tag — skip it.
        this.#warn(buf, lt, 'malformed-markup', `skipped mismatched close tag inside <${name}>`);
        const gt = buf.indexOf('>', lt);

        if (gt === -1) {
          return NEED_MORE;
        }

        i = gt + 1;
        continue;
      }

      if (this.#isPartialSpecial(buf, lt)) {
        return NEED_MORE;
      }

      const skipped = this.#skipSpecial(buf, lt, true);

      if (skipped === NEED_MORE) {
        return NEED_MORE;
      }

      if (skipped !== NOT_SPECIAL) {
        text += this.#cdata;
        i = skipped;
        continue;
      }

      if (this.#readTag(buf, lt) === NEED_MORE) {
        return NEED_MORE;
      }

      const child = this.#extraChild(buf);

      if (child === NEED_MORE) {
        return NEED_MORE;
      }

      (children ??= []).push(child);
      i = this.#pos;
    }

    const value = decodeEntities(text.trim());

    if (value) {
      extra.value = value;
    }

    if (children) {
      extra.children = children;
    }

    return extra;
  }

  // -------------------------------------------------------------------------
  // Container iteration: advance to the next child element of `parent`,
  // skipping inter-element text, comments and CDATA. Returns CLOSED when the
  // parent's close tag was consumed (pos past it), true when a child open
  // tag was read into the scratch state (pos past the open tag).
  // -------------------------------------------------------------------------

  #nextChild(buf: string, pos: number, parent: string): true | typeof CLOSED | NeedMore {
    let i = pos;

    while (true) {
      const lt = buf.indexOf('<', i);

      if (lt === -1) {
        return NEED_MORE;
      }

      const marker = buf.charCodeAt(lt + 1);

      // Common case: `<name...` — a normal element open tag. Peeking the one
      // char after `<` skips the close-tag / comment / CDATA / PI probes below
      // (`startsWith` calls run for every child otherwise). `NaN` (a trailing
      // `<` at the buffer edge) falls through here and defers via readTag.
      if (marker !== SLASH && marker !== BANG && marker !== QUESTION) {
        return this.#readTag(buf, lt);
      }

      if (marker === SLASH) {
        const closeEnd = this.#matchClose(buf, lt, parent);

        if (closeEnd === NEED_MORE) {
          return NEED_MORE;
        }

        if (closeEnd !== NO_MATCH) {
          this.#pos = closeEnd;
          return CLOSED;
        }

        // Stray close tag — skip it.
        this.#warn(buf, lt, 'malformed-markup', `skipped mismatched close tag inside <${parent}>`);
        const gt = buf.indexOf('>', lt);

        if (gt === -1) {
          return NEED_MORE;
        }

        i = gt + 1;
        continue;
      }

      // `<!` or `<?`: comment, CDATA, or processing instruction (or a partial
      // one needing more data).
      if (this.#isPartialSpecial(buf, lt)) {
        return NEED_MORE;
      }

      const skipped = this.#skipSpecial(buf, lt);

      if (skipped === NEED_MORE) {
        return NEED_MORE;
      }

      if (skipped !== NOT_SPECIAL) {
        i = skipped;
        continue;
      }

      return this.#readTag(buf, lt);
    }
  }

  // ---------------------------------------------------------------------------
  // channel / programme
  // ---------------------------------------------------------------------------

  #parseChannel(
    buf: string,
    attrs: string[] | null,
    selfClosing: boolean,
  ): XmltvChannel | null | NeedMore {
    const at = this.#tagStart;
    const channel: XmltvChannel = { id: '', displayName: [] };

    for (let i = 0; attrs && i < attrs.length; i += 2) {
      const key = attrs[i]!;
      const value = attrs[i + 1]!;

      if (key === 'id') {
        channel.id = value;
      } else {
        (channel.extraAttributes ??= {})[key] = value;
      }
    }

    // `id` is #REQUIRED by the DTD and is the channel's key downstream, so a
    // channel without one is dropped with a warning (its body discarded).
    // With `tolerateMissingId` the channel is kept instead, `id` left as "".
    if (!channel.id && !this.#tolerateMissingId) {
      this.#warn(buf, at, 'invalid-element', '<channel> without an id attribute dropped');

      if (!selfClosing) {
        const discarded = this.#readTextContent(buf, this.#pos, 'channel', false);

        if (discarded === NEED_MORE) {
          return NEED_MORE;
        }
      }

      return null;
    }

    if (selfClosing) {
      return channel;
    }

    let i = this.#pos;

    while (true) {
      const step = this.#nextChild(buf, i, 'channel');

      if (step === NEED_MORE) {
        return NEED_MORE;
      }

      if (step === CLOSED) {
        return channel;
      }

      switch (this.#tagName) {
        case 'display-name': {
          const value = this.#textValueChild(buf);

          if (value === NEED_MORE) {
            return NEED_MORE;
          }

          channel.displayName.push(value);
          break;
        }
        case 'icon': {
          const icon = this.#iconChild(buf);

          if (icon === NEED_MORE) {
            return NEED_MORE;
          }

          if (icon) {
            (channel.icon ??= []).push(icon);
          }

          break;
        }
        case 'url': {
          const url = this.#urlChild(buf);

          if (url === NEED_MORE) {
            return NEED_MORE;
          }

          (channel.url ??= []).push(url);
          break;
        }
        default: {
          const extra = this.#extraChild(buf);

          if (extra === NEED_MORE) {
            return NEED_MORE;
          }

          (channel.extra ??= []).push(extra);
          break;
        }
      }

      i = this.#pos;
    }
  }

  #parseProgramme(
    buf: string,
    attrs: string[] | null,
    positions: number[] | null,
    selfClosing: boolean,
  ): XmltvProgramme | null | NeedMore {
    const at = this.#tagStart;

    // Populate inline, with each attribute's `pos` in scope for its warning.
    // `start` stays optional on the draft until validated below; `startRaw`
    // preserves the raw value so the drop message can distinguish an invalid
    // value from a missing attribute.
    const programme: ProgrammeDraft = { channel: '', title: [] };
    let startRaw: string | undefined;
    let startError: unknown;

    for (let i = 0; attrs && i < attrs.length; i += 2) {
      const key = attrs[i]!;
      const value = attrs[i + 1]!;
      const pos = positions![i >> 1]!;

      switch (key) {
        case 'start':
          startRaw = value;

          if (value) {
            try {
              programme.start = parseXmltvDate(value, this.#timezones);
            } catch (error) {
              startError = error; // surfaced in the drop message below
            }
          }

          break;
        case 'channel':
          programme.channel = value;
          break;
        case 'stop':
          this.#applyDate(buf, pos, 'invalid-attribute', 'stop on <programme>', value, (d) => {
            programme.stop = d;
          });
          break;
        case 'pdc-start':
          this.#applyDate(buf, pos, 'invalid-attribute', 'pdc-start on <programme>', value, (d) => {
            programme.pdcStart = d;
          });
          break;
        case 'vps-start':
          this.#applyDate(buf, pos, 'invalid-attribute', 'vps-start on <programme>', value, (d) => {
            programme.vpsStart = d;
          });
          break;
        case 'showview':
          if (value) {
            programme.showview = value;
          } else {
            this.#warnEmptyAttr(buf, pos, 'showview', 'programme');
          }

          break;
        case 'videoplus':
          if (value) {
            programme.videoplus = value;
          } else {
            this.#warnEmptyAttr(buf, pos, 'videoplus', 'programme');
          }

          break;
        case 'clumpidx':
          if (value) {
            programme.clumpidx = value;
          } else {
            this.#warnEmptyAttr(buf, pos, 'clumpidx', 'programme');
          }

          break;
        default:
          (programme.extraAttributes ??= {})[key] = value;
          break;
      }
    }

    // `start` and `channel` are both #REQUIRED. A missing/invalid `start`
    // always drops the programme; a missing `channel` drops it too unless
    // `tolerateMissingId` keeps it with `channel` left as "". Either way the
    // body is discarded so scanning resumes after `</programme>`.
    let dropReason: string | undefined;

    if (programme.start === undefined) {
      const detail =
        startError instanceof XmltvDateError
          ? `: ${startError.reason} at index ${startError.index}`
          : '';
      dropReason = startRaw
        ? `skipped <programme> with invalid start="${startRaw}"${detail}`
        : 'skipped <programme> without a start attribute';
    } else if (!programme.channel && !this.#tolerateMissingId) {
      dropReason = 'skipped <programme> without a channel attribute';
    }

    if (dropReason !== undefined) {
      this.#warn(buf, at, 'invalid-programme', dropReason);

      if (!selfClosing) {
        const discarded = this.#readTextContent(buf, this.#pos, 'programme', false);

        if (discarded === NEED_MORE) {
          return NEED_MORE;
        }
      }

      return null;
    }

    // `start` confirmed present → the draft is now a complete programme.
    if (selfClosing) {
      return programme as XmltvProgramme;
    }

    let i = this.#pos;

    while (true) {
      const step = this.#nextChild(buf, i, 'programme');

      if (step === NEED_MORE) {
        return NEED_MORE;
      }

      if (step === CLOSED) {
        return programme as XmltvProgramme;
      }

      // Start of the current child's `<`, captured before its parse resets it.
      const at = this.#tagStart;

      // DTD single-occurrence elements (credits, date, language, orig-language,
      // length, video, audio, previously-shown, premiere, last-chance, new)
      // enforce first-wins inline in their own `case` via #skipDuplicateElement,
      // so the many repeatable elements pay no per-child lookup on the hot path.
      switch (this.#tagName) {
        case 'title': {
          const value = this.#textValueChild(buf);

          if (value === NEED_MORE) {
            return NEED_MORE;
          }

          programme.title.push(value);
          break;
        }
        case 'sub-title': {
          const value = this.#textValueChild(buf);

          if (value === NEED_MORE) {
            return NEED_MORE;
          }

          (programme.subTitle ??= []).push(value);
          break;
        }
        case 'desc': {
          const value = this.#textValueChild(buf);

          if (value === NEED_MORE) {
            return NEED_MORE;
          }

          (programme.desc ??= []).push(value);
          break;
        }
        case 'credits': {
          if (programme.credits !== undefined) {
            if (this.#skipDuplicateElement(buf, at, 'credits') === NEED_MORE) return NEED_MORE;
            break;
          }

          const credits = this.#creditsChild(buf);

          if (credits === NEED_MORE) {
            return NEED_MORE;
          }

          if (credits) {
            programme.credits = credits;
          }

          break;
        }
        case 'date': {
          if (programme.date !== undefined) {
            if (this.#skipDuplicateElement(buf, at, 'date') === NEED_MORE) return NEED_MORE;
            break;
          }

          const text = this.#stringChild(buf);

          if (text === NEED_MORE) {
            return NEED_MORE;
          }

          this.#applyDate(buf, at, 'invalid-element', '<date>', text, (d) => {
            programme.date = d;
          });
          break;
        }
        case 'category': {
          const value = this.#textValueChild(buf);

          if (value === NEED_MORE) {
            return NEED_MORE;
          }

          (programme.category ??= []).push(value);
          break;
        }
        case 'keyword': {
          const value = this.#textValueChild(buf);

          if (value === NEED_MORE) {
            return NEED_MORE;
          }

          (programme.keyword ??= []).push(value);
          break;
        }
        case 'language': {
          if (programme.language !== undefined) {
            if (this.#skipDuplicateElement(buf, at, 'language') === NEED_MORE) return NEED_MORE;
            break;
          }

          const value = this.#textValueChild(buf);

          if (value === NEED_MORE) {
            return NEED_MORE;
          }

          programme.language = value;
          break;
        }
        case 'orig-language': {
          if (programme.origLanguage !== undefined) {
            if (this.#skipDuplicateElement(buf, at, 'orig-language') === NEED_MORE)
              return NEED_MORE;
            break;
          }

          const value = this.#textValueChild(buf);

          if (value === NEED_MORE) {
            return NEED_MORE;
          }

          programme.origLanguage = value;
          break;
        }
        case 'length': {
          if (programme.length !== undefined) {
            if (this.#skipDuplicateElement(buf, at, 'length') === NEED_MORE) return NEED_MORE;
            break;
          }

          const length = this.#lengthChild(buf);

          if (length === NEED_MORE) {
            return NEED_MORE;
          }

          if (length) {
            programme.length = length;
          }

          break;
        }
        case 'icon': {
          const icon = this.#iconChild(buf);

          if (icon === NEED_MORE) {
            return NEED_MORE;
          }

          if (icon) {
            (programme.icon ??= []).push(icon);
          }

          break;
        }
        case 'url': {
          const url = this.#urlChild(buf);

          if (url === NEED_MORE) {
            return NEED_MORE;
          }

          (programme.url ??= []).push(url);
          break;
        }
        case 'country': {
          const value = this.#textValueChild(buf);

          if (value === NEED_MORE) {
            return NEED_MORE;
          }

          (programme.country ??= []).push(value);
          break;
        }
        case 'episode-num': {
          const episode = this.#episodeNumChild(buf);

          if (episode === NEED_MORE) {
            return NEED_MORE;
          }

          (programme.episodeNum ??= []).push(episode);
          break;
        }
        case 'video': {
          if (programme.video !== undefined) {
            if (this.#skipDuplicateElement(buf, at, 'video') === NEED_MORE) return NEED_MORE;
            break;
          }

          const video = this.#videoChild(buf);

          if (video === NEED_MORE) {
            return NEED_MORE;
          }

          programme.video = video;
          break;
        }
        case 'audio': {
          if (programme.audio !== undefined) {
            if (this.#skipDuplicateElement(buf, at, 'audio') === NEED_MORE) return NEED_MORE;
            break;
          }

          const audio = this.#audioChild(buf);

          if (audio === NEED_MORE) {
            return NEED_MORE;
          }

          programme.audio = audio;
          break;
        }
        case 'previously-shown': {
          if (programme.previouslyShown !== undefined) {
            if (this.#skipDuplicateElement(buf, at, 'previously-shown') === NEED_MORE)
              return NEED_MORE;
            break;
          }

          const shown = this.#previouslyShownChild(buf);

          if (shown === NEED_MORE) {
            return NEED_MORE;
          }

          programme.previouslyShown = shown;
          break;
        }
        case 'premiere': {
          if (programme.premiere !== undefined) {
            if (this.#skipDuplicateElement(buf, at, 'premiere') === NEED_MORE) return NEED_MORE;
            break;
          }

          const flag = this.#flagChild(buf);

          if (flag === NEED_MORE) {
            return NEED_MORE;
          }

          programme.premiere = flag;
          break;
        }
        case 'last-chance': {
          if (programme.lastChance !== undefined) {
            if (this.#skipDuplicateElement(buf, at, 'last-chance') === NEED_MORE) return NEED_MORE;
            break;
          }

          const flag = this.#flagChild(buf);

          if (flag === NEED_MORE) {
            return NEED_MORE;
          }

          programme.lastChance = flag;
          break;
        }
        case 'new': {
          if (programme.new !== undefined) {
            if (this.#skipDuplicateElement(buf, at, 'new') === NEED_MORE) return NEED_MORE;
            break;
          }

          if (this.#discardContent(buf) === NEED_MORE) {
            return NEED_MORE;
          }

          programme.new = true;
          break;
        }
        case 'subtitles': {
          const subtitles = this.#subtitlesChild(buf);

          if (subtitles === NEED_MORE) {
            return NEED_MORE;
          }

          (programme.subtitles ??= []).push(subtitles);
          break;
        }
        case 'rating': {
          const rating = this.#ratingChild(buf);

          if (rating === NEED_MORE) {
            return NEED_MORE;
          }

          if (rating) {
            (programme.rating ??= []).push(rating);
          }

          break;
        }
        case 'star-rating': {
          const rating = this.#ratingChild(buf);

          if (rating === NEED_MORE) {
            return NEED_MORE;
          }

          if (rating) {
            (programme.starRating ??= []).push(rating);
          }

          break;
        }
        case 'review': {
          const review = this.#reviewChild(buf);

          if (review === NEED_MORE) {
            return NEED_MORE;
          }

          (programme.review ??= []).push(review);
          break;
        }
        case 'image': {
          const image = this.#imageChild(buf);

          if (image === NEED_MORE) {
            return NEED_MORE;
          }

          (programme.image ??= []).push(image);
          break;
        }
        default: {
          const extra = this.#extraChild(buf);

          if (extra === NEED_MORE) {
            return NEED_MORE;
          }

          (programme.extra ??= []).push(extra);
          break;
        }
      }

      i = this.#pos;
    }
  }

  /**
   * Parse one top-level element whose '<' is at `lt`. Returns the parse event
   * (or `null` for unknown top-level elements, which are consumed and
   * ignored), with `this.#pos` set past the element. Returns NEED_MORE when the
   * buffer ends mid-element.
   */
  #scanTopLevel(buf: string, lt: number): XmltvParseEvent | null | NeedMore {
    if (this.#readTag(buf, lt) === NEED_MORE) {
      return NEED_MORE;
    }

    const name = this.#tagName;
    const attrs = this.#tagAttrs;
    const positions = this.#tagAttrPositions;
    const selfClosing = this.#tagSelfClosing;

    if (name === 'programme') {
      const value = this.#parseProgramme(buf, attrs, positions, selfClosing);

      if (value === NEED_MORE) {
        return NEED_MORE;
      }

      return value === null ? null : { type: 'programme', value };
    }

    if (name === 'channel') {
      const value = this.#parseChannel(buf, attrs, selfClosing);

      if (value === NEED_MORE) {
        return NEED_MORE;
      }

      return value === null ? null : { type: 'channel', value };
    }

    // Unknown top-level element: consume and ignore.
    if (!selfClosing && name !== '') {
      const discarded = this.#readTextContent(buf, this.#pos, name, false);

      if (discarded === NEED_MORE) {
        return NEED_MORE;
      }
    }

    if (name !== '') {
      this.#warn(buf, lt, 'unknown-element', `unknown top-level element <${name}> ignored`);
    }

    return null;
  }

  /**
   * Build the `meta` event value from the root tag's attributes, already
   * parsed into `this.#tagAttrs` by the `readTag()` call that identified it.
   */
  #rootMeta(buf: string): XmltvDocumentMeta {
    const meta: XmltvDocumentMeta = {};
    const attrs = this.#tagAttrs;
    const positions = this.#tagAttrPositions;

    for (let i = 0; attrs && i < attrs.length; i += 2) {
      const key = attrs[i]!;
      const value = attrs[i + 1]!;
      const pos = positions![i >> 1]!;

      if (key === 'date') {
        this.#applyDate(buf, pos, 'invalid-attribute', 'date on <tv>', value, (d) => {
          meta.date = d;
        });
        continue;
      }

      const metaKey = TV_META_ATTR_KEYS[key];

      if (metaKey) {
        if (value) {
          (meta as Record<string, unknown>)[metaKey] = value;
        } else {
          this.#warnEmptyAttr(buf, pos, key, 'tv');
        }
      } else {
        (meta.extraAttributes ??= {})[key] = value;
      }
    }

    return meta;
  }

  /**
   * Consume as many complete constructs from `buf` as possible, yielding
   * `meta`/`channel`/`programme` events, and return the unconsumed remainder
   * (the caller prepends it to the next chunk). The document head
   * (declaration, DOCTYPE, comments) is skipped the same way as everything
   * else in the loop below; the first element found must be `<tv>` (thrown
   * as a `TypeError` otherwise — the DTD defines no other document element),
   * and its open tag is consumed to produce the `meta` event. Close tags,
   * comments, CDATA, PIs and inter-element text are skipped. When `final` is
   * false, anything possibly incomplete is left in the remainder; when true,
   * an incomplete trailing construct is dropped (a well-formed document
   * never ends mid-element).
   */
  *consume(buf: string, final: boolean): Generator<XmltvParseEvent, string> {
    let pos = 0;

    while (true) {
      const lt = buf.indexOf('<', pos);

      if (lt === -1) {
        // Unlike the other early-return sites below, nothing is carried
        // forward here (consumed === buf.length), so `checkRootLimit` on
        // #advance doesn't apply — check the whole scanned buffer directly.
        if (!this.#rootFound && buf.length > this.#rootScanLimit) {
          throw new TypeError(
            `No root element found within the first ${this.#rootScanLimit} characters of input`,
          );
        }

        return this.#advance(buf, buf.length);
      }

      // Possibly an incomplete comment/CDATA opener at the buffer end.
      if (!final && this.#isPartialSpecial(buf, lt)) {
        return this.#advance(buf, lt);
      }

      if (buf.startsWith(COMMENT_OPEN, lt)) {
        const end = buf.indexOf(COMMENT_CLOSE, lt + COMMENT_OPEN.length);

        if (end === -1) {
          if (final) {
            yield this.#truncated(buf, lt);
            return '';
          }

          return this.#advance(buf, lt, true);
        }

        pos = end + COMMENT_CLOSE.length;
        continue;
      }

      if (buf.startsWith(CDATA_OPEN, lt)) {
        const end = buf.indexOf(CDATA_CLOSE, lt + CDATA_OPEN.length);

        if (end === -1) {
          if (final) {
            yield this.#truncated(buf, lt);
            return '';
          }

          return this.#advance(buf, lt, true);
        }

        pos = end + CDATA_CLOSE.length;
        continue;
      }

      if (buf.startsWith('</', lt) || buf.startsWith('<!', lt)) {
        const end = buf.indexOf('>', lt + 1);

        if (end === -1) {
          if (final) {
            yield this.#truncated(buf, lt);
            return '';
          }

          return this.#advance(buf, lt, true);
        }

        pos = end + 1;
        continue;
      }

      if (buf.startsWith(PI_OPEN, lt)) {
        const end = buf.indexOf(PI_CLOSE, lt + PI_OPEN.length);

        if (end === -1) {
          if (final) {
            yield this.#truncated(buf, lt);
            return '';
          }

          return this.#advance(buf, lt, true);
        }

        pos = end + PI_CLOSE.length;
        continue;
      }

      if (!this.#rootFound) {
        if (this.#readTag(buf, lt) === NEED_MORE) {
          if (final) {
            yield this.#truncated(buf, lt);
            return '';
          }

          return this.#advance(buf, lt, true);
        }

        if (this.#tagName !== 'tv') {
          throw new TypeError(
            `Invalid XMLTV document: expected root element <tv>, found <${this.#tagName}>`,
          );
        }

        this.#rootFound = true;

        const meta = this.#rootMeta(buf);
        yield* this.#takeWarnings();
        yield { type: 'meta', value: meta };

        pos = this.#pos;
        continue;
      }

      // Element: parsed directly into a typed event.
      const event = this.#scanTopLevel(buf, lt);

      if (event === NEED_MORE) {
        this.#pendingWarnings.length = 0;

        if (final) {
          yield this.#truncated(buf, lt);
          return '';
        }

        return this.#advance(buf, lt);
      }

      yield* this.#takeWarnings();

      if (event !== null) {
        yield event;
      }

      pos = this.#pos;
    }
  }
}

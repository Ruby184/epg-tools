const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/**
 * Which quote characters would end a value where the escaped text is going.
 *
 * All there are: `"` inside a double-quoted attribute, `'` inside a
 * single-quoted one, both for a caller who does not know yet, and neither in
 * text between two tags.
 */
export type XmlQuotes = '"' | "'" | `"'` | '';

/**
 * Both patterns for one quoting: the test for the fast path, and the replace.
 *
 * As plain pairs of constants rather than an object apiece, because the two
 * named forms below are on the hot path — every title, description and
 * attribute of a guide — and reading the pair out of a record costs a
 * measurable tenth against naming the two regexes directly.
 */
const TEXT_ANY = /[&<>]/;
const TEXT_ALL = /[&<>]/g;
const DOUBLE_ANY = /[&<>"]/;
const DOUBLE_ALL = /[&<>"]/g;
const SINGLE_ANY = /[&<>']/;
const SINGLE_ALL = /[&<>']/g;
const EITHER_ANY = /[&<>"']/;
const EITHER_ALL = /[&<>"']/g;

const replacement = (char: string): string => ESCAPES[char]!;

/** Written out rather than built: there are four quotings and no more. */
const PATTERNS: Record<XmlQuotes, [RegExp, RegExp]> = {
  '': [TEXT_ANY, TEXT_ALL],
  '"': [DOUBLE_ANY, DOUBLE_ALL],
  "'": [SINGLE_ANY, SINGLE_ALL],
  [`"'`]: [EITHER_ANY, EITHER_ALL],
};

/**
 * Escape a string for XML: the three it always needs, plus whichever quotes you
 * say.
 *
 * Always an `&` that is not an entity, a `<` that would open a tag, and a `>` —
 * which only `]]>` requires, but one character keeps a stray one from ever
 * looking like markup.
 *
 * `quotes` is what would end the value where this is going — `"` inside a
 * double-quoted attribute, `'` inside a single-quoted one, nothing at all in
 * text between two tags, where a quote is a quote and an apostrophe is an
 * apostrophe. It defaults to both, which is safe wherever the result lands and
 * is what a caller with no particular place in mind wants.
 *
 * The two named forms below are the two places this package writes to, and they
 * reach their pattern without a lookup; other libraries split it the same way,
 * `entities` as `escapeText` and `escapeAttribute`, Python's `saxutils` as
 * `escape` and `quoteattr`.
 *
 * Fast path: most strings contain nothing to escape and are returned as-is.
 */
export function escapeXml(value: string, quotes: XmlQuotes = `"'`): string {
  if (quotes === `"'`) {
    // The default, which is what a caller who says nothing gets: straight at the
    // pattern, the way the two named forms below go at theirs.
    return EITHER_ANY.test(value) ? value.replace(EITHER_ALL, replacement) : value;
  }

  const [any, all] = PATTERNS[quotes];

  return any.test(value) ? value.replace(all, replacement) : value;
}

/**
 * Escape a string for XML text — the three, and no quotes.
 *
 * Which is what every other guide writes: `Charlie's Angels` reads as it is
 * written rather than as `Charlie&apos;s Angels`.
 */
export function escapeXmlText(value: string): string {
  return TEXT_ANY.test(value) ? value.replace(TEXT_ALL, replacement) : value;
}

/** Escape a string for a double-quoted attribute value — the three, and `"`. */
export function escapeXmlAttribute(value: string): string {
  return DOUBLE_ANY.test(value) ? value.replace(DOUBLE_ALL, replacement) : value;
}

const HASH = '#'.charCodeAt(0);
const SEMI = ';'.charCodeAt(0);
const X_LOWER = 'x'.charCodeAt(0);
const X_UPPER = 'X'.charCodeAt(0);

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isDecimalDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isHexDigit(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 102) || (code >= 65 && code <= 70);
}

/** The predefined entity name → replacement, or `undefined` if not one of them. */
function namedEntity(name: string): string | undefined {
  switch (name) {
    case 'amp':
      return '&';
    case 'lt':
      return '<';
    case 'gt':
      return '>';
    case 'quot':
      return '"';
    case 'apos':
      return "'";
    default:
      return undefined;
  }
}

/**
 * Decode XML entities: the five predefined ones plus numeric references
 * (`&#NN;` / `&#xHH;`). Unknown or malformed entities are left unchanged.
 *
 * A hand-rolled charcode scan rather than a regex + replace callback: this is
 * one of the hottest functions on large guides, and the scanner is ~2× the
 * regex. Fast path: strings without `&` (the overwhelming majority in EPG
 * data) return immediately with no allocation. Otherwise only the segments
 * around each decoded entity are copied, matching the regex's leftmost,
 * non-overlapping semantics exactly (a `&`-token that fails to terminate in
 * `;` is emitted verbatim and scanning resumes at the next `&`).
 */
export function decodeEntities(value: string): string {
  let amp = value.indexOf('&');

  if (amp === -1) {
    return value;
  }

  const len = value.length;
  let out = '';
  let last = 0;

  while (amp !== -1) {
    let j = amp + 1;
    let decoded: string | undefined;

    if (value.charCodeAt(j) === HASH) {
      j++;

      const hex = value.charCodeAt(j) === X_LOWER || value.charCodeAt(j) === X_UPPER;

      if (hex) {
        j++;
      }

      const digitsStart = j;

      while (
        j < len &&
        (hex ? isHexDigit(value.charCodeAt(j)) : isDecimalDigit(value.charCodeAt(j)))
      ) {
        j++;
      }

      if (j > digitsStart && value.charCodeAt(j) === SEMI) {
        const code = Number.parseInt(value.slice(digitsStart, j), hex ? 16 : 10);

        try {
          decoded = String.fromCodePoint(code);
        } catch {
          decoded = undefined; // out-of-range code point: leave the entity as-is
        }
      }
    } else {
      const nameStart = j;

      while (j < len && isAsciiLetter(value.charCodeAt(j))) {
        j++;
      }

      if (j > nameStart && value.charCodeAt(j) === SEMI) {
        decoded = namedEntity(value.slice(nameStart, j));
      }
    }

    if (decoded !== undefined) {
      out += value.slice(last, amp) + decoded;
      last = j + 1;
    }

    amp = value.indexOf('&', amp + 1);
  }

  return out + value.slice(last);
}

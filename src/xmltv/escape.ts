const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

const NEEDS_ESCAPE = /[&<>"']/;
const ESCAPE_ALL = /[&<>"']/g;

/**
 * Escape a string for use in XML text content or attribute values.
 * Fast path: most strings contain nothing to escape and are returned as-is.
 */
export function escapeXml(value: string): string {
  return NEEDS_ESCAPE.test(value) ? value.replace(ESCAPE_ALL, (char) => ESCAPES[char]!) : value;
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

/**
 * Telling one of these files from another without reading it whole.
 *
 * `epg channels` and `--channels` both take a playlist, a `*.channels.xml`, a
 * guide or a plain list of ids, and decide by content rather than by extension —
 * all four get renamed, and `.xml` alone does not say which of the last two a
 * file is. The one of them that is routinely 90 MiB is the guide, so finding out
 * must not mean loading it.
 */

import { guideBytes } from '../core/output.js';

/**
 * How much of a file is enough to know what it is.
 *
 * Every marker the sniffing looks for is in the first element — `#EXTM3U`,
 * `<channels`, `<tv` — and a guide's is behind at most a prolog and a doctype.
 * Generous by two orders of magnitude, and still nothing next to the document.
 */
const SNIFF_BYTES = 4096;

/**
 * Whether the value names a file rather than being a list of ids.
 *
 * Shape, not existence. Deciding by whether the file is there turns a mistyped
 * path into a channel id, and the report downstream then says "nothing produces
 * ./chanels.txt" — which is true, and useless. This way a path that is not
 * there fails as a path.
 *
 * The extensions have to be spelled out rather than "has a dot": an xmltv id
 * looks like `one.example.tv`, so `.tv` and `.uk` are not extensions here.
 */
export function looksLikePath(value: string): boolean {
  return (
    value.includes('/') ||
    value.includes('\\') ||
    value.startsWith('.') ||
    value.startsWith('~') ||
    /\.(?:m3u8?|xml|txt|list)(?:\.(?:gz|br|zst))?$/i.test(value)
  );
}

/** A file's first bytes, and the whole of it with those bytes put back. */
export interface Sniffed {
  /** Enough of the start to tell what the file is. */
  head: string;
  /** Every byte, including the ones already taken to sniff with. */
  whole: () => AsyncGenerator<Uint8Array>;
  /** The rest of it as text, for the formats small enough to read whole. */
  text: () => Promise<string>;
}

/**
 * Open a file, read enough of it to know what it is, and hand back both.
 *
 * The alternative is reading it whole to find out, which for the one format
 * that is routinely 90 MiB defeats the point of having a streaming parser at
 * all. Shared because three callers want it — `--channels`, `epg channels`, and
 * `epg channels --write`.
 */
export async function sniff(file: string): Promise<Sniffed> {
  const source = guideBytes(file)[Symbol.asyncIterator]();
  const decoder = new TextDecoder();
  const head: Uint8Array[] = [];
  let sniffed = '';

  while (sniffed.length < SNIFF_BYTES) {
    const next = await source.next();

    if (next.done === true) {
      break;
    }

    head.push(next.value as Uint8Array);
    sniffed += decoder.decode(next.value as Uint8Array, { stream: true });
  }

  async function* whole(): AsyncGenerator<Uint8Array> {
    yield* head;

    let next = await source.next();

    while (next.done !== true) {
      yield next.value as Uint8Array;
      next = await source.next();
    }
  }

  return {
    head: sniffed,
    whole,
    text: async () => {
      const rest = new TextDecoder();
      let text = '';

      for await (const chunk of whole()) {
        text += rest.decode(chunk, { stream: true });
      }

      return text + rest.decode();
    },
  };
}

/**
 * An XMLTV guide, as against a playlist or a channel list.
 *
 * `<tv` only after the other two have been ruled out, in the order `wantedFrom`
 * itself asks: a `*.channels.xml` also opens with `<?xml`, and its root is
 * `<channels`, which contains no `<tv`.
 */
export function isGuide(head: string): boolean {
  if (head.startsWith('#EXTM3U') || head.includes('#EXTINF:') || head.includes('<channels')) {
    return false;
  }

  return head.includes('<tv');
}

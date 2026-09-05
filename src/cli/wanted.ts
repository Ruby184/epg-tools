/**
 * What `--channels` was given, as a set of ids.
 *
 * A path or a list, and for a path any of the four things somebody might
 * reasonably have lying around: a playlist, a `*.channels.xml`, a guide, or a
 * plain list of ids. Which of those it is comes from the content, as everywhere
 * else here — all four get renamed, and `.xml` alone does not say whether it is
 * a channel list or a guide.
 */

import { guideBytes } from '../core/output.js';
import { parseXmltvStream } from '../xmltv/parse.js';
import { wantedFrom } from './channels.js';

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
function looksLikePath(value: string): boolean {
  return (
    value.includes('/') ||
    value.includes('\\') ||
    value.startsWith('.') ||
    value.startsWith('~') ||
    /\.(?:m3u8?|xml|txt|list)(?:\.(?:gz|br|zst))?$/i.test(value)
  );
}

/** The channel ids `--channels` asks for. */
export async function wantedIds(value: string): Promise<Set<string>> {
  if (!looksLikePath(value)) {
    return new Set(
      value
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id !== ''),
    );
  }

  const source = guideBytes(value)[Symbol.asyncIterator]();
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

  /** Everything, with what was already taken put back in front. */
  async function* whole(): AsyncGenerator<Uint8Array> {
    yield* head;

    let next = await source.next();

    while (next.done !== true) {
      yield next.value as Uint8Array;
      next = await source.next();
    }
  }

  // A guide is the one input that is routinely enormous — subsetting somebody
  // else's 900 channels is the whole point — so it streams, and only its
  // `<channel>` ids are kept. Reading a 90 MiB document whole to end up with a
  // few hundred strings would undo the feature it is being read for.
  if (isGuide(sniffed)) {
    const ids = new Set<string>();

    for await (const event of parseXmltvStream(whole())) {
      if (event.type === 'channel') {
        ids.add(event.value.id);
      }
    }

    return ids;
  }

  let text = '';

  for await (const chunk of whole()) {
    text += decoder.decode(chunk, { stream: true });
  }

  text += decoder.decode();

  return new Set(
    wantedFrom(text, value)
      .map((channel) => channel.id)
      .filter((id) => id !== ''),
  );
}

/**
 * An XMLTV guide, as against a playlist or a channel list.
 *
 * `<tv` only after the other two have been ruled out, in the order `wantedFrom`
 * itself asks: a `*.channels.xml` also opens with `<?xml`, and its root is
 * `<channels`, which contains no `<tv`.
 */
function isGuide(head: string): boolean {
  if (head.startsWith('#EXTM3U') || head.includes('#EXTINF:') || head.includes('<channels')) {
    return false;
  }

  return head.includes('<tv');
}

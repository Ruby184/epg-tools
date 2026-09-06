/**
 * The files that say which channels somebody wants — read, and written back.
 *
 * Four of them, and which one a file is comes from its content rather than its
 * name: all four get renamed, and `.xml` alone does not say whether it is a
 * channel list or a guide. The one that is routinely 90 MiB is the guide, so
 * finding out must not mean loading it.
 *
 * Two of them are read *and* written — a `*.channels.xml`'s `xmltv_id` and a
 * playlist's `tvg-id` are that file's own statement about which guide channel it
 * means. A guide names its channels instead, so writing there is a rename.
 */

import { writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { guideBytes, writeOutput } from '../core/output.js';
import { parseChannelsXml } from '../channels/parse.js';
import { serializeChannelsXml } from '../channels/serialize.js';
import { parseM3uString } from '../m3u/parse.js';
import { serializeM3uEntry, serializeM3uHeader } from '../m3u/serialize.js';
import { parseXmltvStream, parseXmltvString } from '../xmltv/parse.js';
import { XmltvSerializeStream } from '../xmltv/serialize.js';
import type { XmltvParseEvent } from '../xmltv/types.js';

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

/** One channel somebody wants a guide for, however they said so. */
export interface WantedChannel {
  id: string;
  name: string;
}

/**
 * The channels a file asks for, whichever of the three kinds it is.
 *
 * Sniffed rather than taken from the extension: all three get renamed, and
 * `.xml` alone does not say whether it is a channel list or a guide. What each
 * one *is* is unmistakable a few bytes in.
 *
 * Each is read whole, which is what this command is: one file the caller named,
 * once. The streaming forms exist for a guide being *built*, where the document
 * is the whole point and may be 90 MiB; here the answer is a list of names.
 */
export function wantedFrom(text: string, from: string): WantedChannel[] {
  if (text.startsWith('#EXTM3U') || text.includes('#EXTINF:')) {
    return parseM3uString(text).entries.map((entry) => ({
      id: entry.attributes.get('tvg-id') ?? entry.attributes.get('tvg-ID') ?? '',
      name: entry.attributes.get('tvg-name') || entry.name,
    }));
  }

  if (text.includes('<channels')) {
    return parseChannelsXml(text).entries.map((entry) => ({
      id: entry.xmltvId,
      name: entry.name,
    }));
  }

  if (text.includes('<tv')) {
    return parseXmltvString(text).channels.map((channel) => ({
      id: channel.id,
      name: channel.displayName[0]?.value ?? '',
    }));
  }

  const ids = idList(text);

  if (ids !== undefined) {
    return ids.map((id) => ({ id, name: '' }));
  }

  throw new Error(
    `Cannot tell what ${from} is: expected an M3U playlist, a *.channels.xml, an XMLTV guide, or a list of ids`,
  );
}

/**
 * A plain list of ids — one per line or comma-separated, `#` a comment.
 *
 * Last, because everything is plain text: the three formats above have said no
 * before this is asked. `undefined` for anything that does not look like a list
 * of ids, so a file of something else entirely still gets the error above
 * rather than being read as a channel called `<!DOCTYPE`.
 *
 * The test is deliberately narrow — no markup, no whitespace inside an entry —
 * since an xmltv id is a token and this is the last chance to notice it is not.
 */
function idList(text: string): string[] | undefined {
  const ids: string[] = [];

  for (const line of text.split('\n')) {
    const content = line.slice(0, line.indexOf('#') === -1 ? undefined : line.indexOf('#')).trim();

    if (content === '') {
      continue;
    }

    for (const id of content.split(',')) {
      const trimmed = id.trim();

      if (trimmed === '') {
        continue;
      }

      if (/[<>\s"']/.test(trimmed)) {
        return undefined;
      }

      ids.push(trimmed);
    }
  }

  return ids.length > 0 ? ids : undefined;
}

/** One entry of a file that can be written back, however it spells its id. */
export interface Mappable {
  /** What the report matches on. */
  wanted: WantedChannel;
  /** Whether it already names an id, in which case nothing is written. */
  mapped: boolean;
  /** What to call it in the summary. */
  label: string;
  set: (xmltvId: string) => void;
}

/** A file the report can write its answer back into. */
export interface Mapping {
  entries: Mappable[];
  /** Put the answer back where it came from, in place. */
  write: () => Promise<void>;
}

/**
 * The file as something writable, or a refusal naming why it is not.
 *
 * Two of the formats the report reads carry a mapping: a `*.channels.xml` says
 * `xmltv_id` and a playlist says `tvg-id`, and both are that file's own
 * statement about which guide channel it means. Both round-trip byte for byte,
 * so what is written back differs only by the ids added.
 *
 * A guide does not: its `<channel id>` is that document's own name for a
 * channel rather than a mapping onto one, and changing it would mean rewriting
 * every `<programme channel=…>` with it — a rewrite of somebody else's document.
 * A plain list of ids has no names to match on in the first place.
 */
export function mappingFor(text: string, from: string, found?: WantedChannel[]): Mapping {
  if (text.startsWith('#EXTM3U') || text.includes('#EXTINF:')) {
    const playlist = parseM3uString(text);

    return {
      entries: playlist.entries.map((entry) => {
        const id = entry.attributes.get('tvg-id') ?? entry.attributes.get('tvg-ID') ?? '';
        const name = entry.attributes.get('tvg-name') || entry.name;

        return {
          wanted: { id, name },
          mapped: id !== '',
          label: name || entry.url,
          // Replaces an empty `tvg-id` where the entry had one, keeping its
          // place among the attributes; appends where it had none at all.
          set: (xmltvId: string) => entry.attributes.set('tvg-id', xmltvId),
        };
      }),
      write: async () => {
        await writeFile(
          from,
          serializeM3uHeader(playlist.header) +
            playlist.entries.map((entry) => serializeM3uEntry(entry)).join(''),
          'utf8',
        );
      },
    };
  }

  if (text.includes('<channels')) {
    const list = parseChannelsXml(text);

    return {
      entries: list.entries.map((entry) => ({
        wanted: { id: entry.xmltvId, name: entry.name },
        mapped: entry.xmltvId !== '',
        label: entry.name || entry.siteId,
        set: (xmltvId: string) => {
          entry.xmltvId = xmltvId;
        },
      })),
      write: async () => {
        await writeFile(from, serializeChannelsXml(list), 'utf8');
      },
    };
  }

  if (found !== undefined) {
    // A guide names its channels rather than mapping them, so writing here is a
    // *rename*: the `<channel id>`, and every `<programme channel=…>` with it.
    // Streamed rather than rebuilt — the same parse-map-serialize `epg filter`
    // runs, and for the same reason. A guide is the one of these formats that is
    // routinely 90 MiB, and it was never read whole to get here either.
    const renames = new Map<string, string>();

    return {
      entries: found.map((channel) => ({
        wanted: channel,
        // A guide's channel always has an id — that is what a `<channel>` is —
        // so what makes one writable is not a missing id but one that lined up
        // with nothing.
        mapped: false,
        label: channel.name || channel.id,
        set: (xmltvId: string) => renames.set(channel.id, xmltvId),
      })),
      write: async () => {
        const serializer = new XmltvSerializeStream();

        serializer.setEncoding('utf8');

        async function* renamed(): AsyncGenerator<XmltvParseEvent> {
          for await (const event of parseXmltvStream(guideBytes(from))) {
            if (event.type === 'channel') {
              const to = renames.get(event.value.id);

              yield to === undefined ? event : { ...event, value: { ...event.value, id: to } };
            } else if (event.type === 'programme') {
              const to = renames.get(event.value.channel);

              yield to === undefined ? event : { ...event, value: { ...event.value, channel: to } };
            } else {
              yield event;
            }
          }
        }

        // Read from the file while writing it: safe because `writeOutput` writes
        // beside the path and renames into place only once the document is
        // finished, so the stream above is reading the old file throughout.
        const pumped = pipeline(Readable.from(renamed(), { objectMode: true }), serializer);

        await Promise.all([writeOutput(from, serializer), pumped]);
      },
    };
  }

  throw new Error(
    `--write needs --against to be a *.channels.xml, a playlist or a guide, which ${from} is not`,
  );
}

/** Every `<channel>` a guide describes, without ever holding the document. */
export async function guideChannels(bytes: AsyncGenerator<Uint8Array>): Promise<WantedChannel[]> {
  const found: WantedChannel[] = [];

  for await (const event of parseXmltvStream(bytes)) {
    if (event.type === 'channel') {
      found.push({ id: event.value.id, name: event.value.displayName[0]?.value ?? '' });
    }
  }

  return found;
}

/**
 * Read what is wanted, resolve what is available, and report the difference.
 *
 * Returns the exit code, so the caller does nothing but hand it on: `0` unless
 * `--check` was asked for and something does not line up.
 */
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

  const { head: sniffed, whole, text: rest } = await sniff(value);

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

  return new Set(
    wantedFrom(await rest(), value)
      .map((channel) => channel.id)
      .filter((id) => id !== ''),
  );
}

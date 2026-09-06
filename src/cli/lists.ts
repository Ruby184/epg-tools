/**
 * The files that name channels — read, and written back.
 *
 * Four of them, and which one a file is comes from its content rather than its
 * name: they all get renamed, and `.xml` alone does not say whether it is a
 * channel list or a guide.
 *
 * One entry point, {@link readChannelList}, because the four differ in ways no
 * caller should have to know. Three are small and read whole; a guide is
 * routinely 90 MiB and is streamed, twice if it is written to. Two carry a
 * mapping of their own — a `*.channels.xml`'s `xmltv_id`, a playlist's `tvg-id`
 * — a guide names its channels instead, so writing there is a rename; and a
 * plain list of ids has nothing to write into at all.
 */

import { writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseChannelsXml } from '../channels/parse.js';
import { serializeChannelsXml } from '../channels/serialize.js';
import { guideBytes, writeOutput } from '../core/output.js';
import { parseM3uString } from '../m3u/parse.js';
import { serializeM3uEntry, serializeM3uHeader } from '../m3u/serialize.js';
import { parseXmltvStream } from '../xmltv/parse.js';
import { XmltvSerializeStream } from '../xmltv/serialize.js';
import type { AnyIterable, XmltvParseEvent } from '../xmltv/types.js';

/** One channel a file names, however that file spells it. */
export interface WantedChannel {
  id: string;
  name: string;
}

/**
 * A file that names channels, and what can be done about what it says.
 *
 * The format is gone by the time a caller holds one of these: it decided how
 * the file was read and how it will be written, and neither is a question the
 * report has any business asking.
 */
export interface ChannelListFile {
  /** Every channel the file names, in the order it names them. */
  channels: readonly WantedChannel[];
  /**
   * Give one of them an id, and say whether that took.
   *
   * `false` where the channel already names an id — that is somebody's
   * decision, possibly one made against this very suggestion — and where the
   * file has nowhere to put one.
   */
  map: (channel: WantedChannel, xmltvId: string) => boolean;
  /** What to call one of them in a summary. */
  label: (channel: WantedChannel) => string;
  /**
   * Put what was mapped back — into the file it came from, or into `to`.
   *
   * Nothing if nothing was mapped: a file rewritten byte for byte is still a
   * file whose timestamp moved for no reason.
   */
  write: (to?: string) => Promise<void>;
}

/** What one entry of a file can do, kept beside the channel it produced. */
interface Entry {
  /** Whether it already names an id, in which case nothing is written. */
  mapped: boolean;
  label: string;
  set: (xmltvId: string) => void;
}

/** Read a file for the channels it names, whichever of the four it is. */
export async function readChannelList(file: string): Promise<ChannelListFile> {
  const source = await sniff(file);
  const entries = new Map<WantedChannel, Entry>();
  const built =
    source.format === 'guide'
      ? guideList(file, await guideChannels(source.whole()))
      : textList(file, await source.text(), source.format);

  for (const [channel, entry] of built.entries) {
    entries.set(channel, entry);
  }

  let mapped = 0;

  return {
    channels: [...entries.keys()],
    label: (channel) => entries.get(channel)?.label ?? (channel.name || channel.id),
    map: (channel, xmltvId) => {
      const entry = entries.get(channel);

      if (entry === undefined || entry.mapped) {
        return false;
      }

      entry.set(xmltvId);
      mapped++;

      return true;
    },
    write: async (to) => {
      if (mapped > 0) {
        await built.write(to ?? file);
      }
    },
  };
}

/** What a format's reader produces: its channels, paired with what they can do. */
interface Built {
  entries: [WantedChannel, Entry][];
  /** Where it goes is the caller's: `--write` alone means back where it came from. */
  write: (to: string) => Promise<void>;
}

/**
 * The three formats small enough to hold, from the text of one.
 *
 * A plain list of ids is the one that is *not* recognized by a marker: it is
 * what is left when the other two say no, which is why it comes last and why it
 * checks that every line looks like an id rather than accepting anything.
 */
function textList(file: string, text: string, format: ListFormat | undefined): Built {
  if (format === 'm3u') {
    const playlist = parseM3uString(text);

    return {
      entries: playlist.entries.map((entry) => {
        const id = entry.attributes.get('tvg-id') ?? entry.attributes.get('tvg-ID') ?? '';
        const name = entry.attributes.get('tvg-name') || entry.name;

        return [
          { id, name },
          {
            mapped: id !== '',
            label: name || entry.url,
            // Replaces an empty `tvg-id` in its own place among the attributes;
            // appends where the entry had none at all.
            set: (xmltvId: string) => entry.attributes.set('tvg-id', xmltvId),
          },
        ];
      }),
      write: (to) =>
        writeFile(
          to,
          serializeM3uHeader(playlist.header) +
            playlist.entries.map((entry) => serializeM3uEntry(entry)).join(''),
          'utf8',
        ),
    };
  }

  if (format === 'channels') {
    const list = parseChannelsXml(text);

    return {
      entries: list.entries.map((entry) => [
        { id: entry.xmltvId, name: entry.name },
        {
          mapped: entry.xmltvId !== '',
          label: entry.name || entry.siteId,
          set: (xmltvId: string) => {
            entry.xmltvId = xmltvId;
          },
        },
      ]),
      write: (to) => writeFile(to, serializeChannelsXml(list), 'utf8'),
    };
  }

  const ids = idList(text);

  if (ids === undefined) {
    throw new Error(
      `Cannot tell what ${file} is: expected an M3U playlist, a *.channels.xml, an XMLTV guide, or a list of ids`,
    );
  }

  return {
    // A list of ids is ids: there are no names to match on and nowhere to put
    // an answer, so every entry is already as mapped as it can be.
    entries: ids.map((id) => [
      { id, name: '' },
      { mapped: true, label: id, set: () => {} },
    ]),
    write: async () => {},
  };
}

/**
 * A guide, whose channels were streamed out of it.
 *
 * Writing here is a **rename**: a guide names its channels rather than mapping
 * them, so an id that changes has to change on every `<programme>` that names
 * it too, or the guide describes programmes on a channel it no longer has.
 *
 * Which is why it streams — the same parse-map-serialize `epg filter` runs, and
 * for the same reason. The document is never held, on the way in or out.
 */
function guideList(file: string, found: readonly WantedChannel[]): Built {
  const renames = new Map<string, string>();

  return {
    entries: found.map((channel) => [
      channel,
      {
        // A guide's channel always has an id — that is what a `<channel>` is —
        // so what makes one writable is not a missing id but one that lined up
        // with nothing.
        mapped: false,
        label: channel.name || channel.id,
        set: (xmltvId: string) => renames.set(channel.id, xmltvId),
      },
    ]),
    write: async (to) => {
      const serializer = new XmltvSerializeStream();

      serializer.setEncoding('utf8');

      async function* renamed(): AsyncGenerator<XmltvParseEvent> {
        for await (const event of parseXmltvStream(guideBytes(file))) {
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

      // Reading the source while writing over it, which is safe because
      // `writeOutput` writes beside the path and renames into place only once
      // the document is finished — so the read above has the old file
      // throughout, whether or not `to` is that same path.
      const pumped = pipeline(Readable.from(renamed(), { objectMode: true }), serializer);

      await Promise.all([writeOutput(to, serializer), pumped]);
    },
  };
}

/** Every `<channel>` a guide describes, without ever holding the document. */
export async function guideChannels(
  source: AnyIterable<string | Uint8Array>,
): Promise<WantedChannel[]> {
  const found: WantedChannel[] = [];

  for await (const event of parseXmltvStream(source)) {
    if (event.type === 'channel') {
      found.push({ id: event.value.id, name: event.value.displayName[0]?.value ?? '' });
    }
  }

  return found;
}

/** The channel ids `--channels` asks for: a file naming them, or the ids. */
export async function wantedIds(value: string): Promise<Set<string>> {
  if (!looksLikePath(value)) {
    return new Set(
      value
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id !== ''),
    );
  }

  const list = await readChannelList(value);

  return new Set(list.channels.map((channel) => channel.id).filter((id) => id !== ''));
}

/** The structured formats a channel list comes in; a list of ids has no marker. */
type ListFormat = 'm3u' | 'channels' | 'guide';

/**
 * Which of them a document is, from its first bytes.
 *
 * Order matters. A `*.channels.xml` also opens with `<?xml`, and its root is
 * `<channels`, which contains no `<tv` — so it has to be asked about first.
 */
function formatOf(head: string): ListFormat | undefined {
  if (head.startsWith('#EXTM3U') || head.includes('#EXTINF:')) {
    return 'm3u';
  }

  if (head.includes('<channels')) {
    return 'channels';
  }

  return head.includes('<tv') ? 'guide' : undefined;
}

/**
 * How much of a file is enough to know what it is.
 *
 * Every marker is in the first element — `#EXTM3U`, `<channels`, `<tv` — and a
 * guide's is behind at most a prolog and a doctype. Generous by two orders of
 * magnitude, and still nothing next to the document.
 */
const SNIFF_BYTES = 4096;

/**
 * Open a file, read enough to know what it is, and keep what was read.
 *
 * The alternative is reading it whole to find out, which for the one format
 * that is routinely 90 MiB gives away the streaming before it starts.
 */
async function sniff(file: string): Promise<{
  format: ListFormat | undefined;
  whole: () => AsyncGenerator<Uint8Array>;
  text: () => Promise<string>;
}> {
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

  /** Everything, with what was already taken put back in front of it. */
  async function* whole(): AsyncGenerator<Uint8Array> {
    yield* head;

    let next = await source.next();

    while (next.done !== true) {
      yield next.value as Uint8Array;
      next = await source.next();
    }
  }

  return {
    format: formatOf(sniffed),
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

/**
 * A plain list of ids — one per line or comma-separated, `#` a comment.
 *
 * `undefined` for anything that does not look like one, so a file of something
 * else entirely is reported as unrecognized rather than read as a channel
 * called `<!DOCTYPE`. The test is deliberately narrow — no markup, no
 * whitespace inside an entry — since an xmltv id is a token and this is the
 * last chance to notice it is not.
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

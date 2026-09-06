/**
 * `epg channels` — say which of the channels you want will get no guide.
 *
 * The commonest failure in this whole ecosystem is not a grab that breaks; it
 * is a `tvg-id` in a playlist that does not equal a `<channel id>` in a guide.
 * Nothing errors. The playlist loads, the guide loads, and one of them simply
 * has nothing to say about the other, so a row in the grid is empty and no
 * component anywhere says why.
 *
 * So this answers that directly: given what you want — a playlist, someone's
 * `*.channels.xml`, or a guide you already have — and what this project's sites
 * can produce, which of the two do not line up, and what the matcher thought
 * the near misses were.
 */

import { writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Writable } from 'node:stream';
import { matchChannels } from '../channels/match.js';
import { parseChannelsXml } from '../channels/parse.js';
import { serializeChannelsXml } from '../channels/serialize.js';
import type { ChannelMatchKind } from '../channels/types.js';
import type { EpgConfig } from '../config.js';
import { resolveSites } from '../grabber/channels.js';
import type { AnySiteConfig, GrabberChannel } from '../grabber/types.js';
import { parseM3uString } from '../m3u/parse.js';
import { serializeM3uEntry, serializeM3uHeader } from '../m3u/serialize.js';
import { derivedChannelList } from '../merge/derive.js';
import { writeLines } from '../core/streams.js';
import { parseXmltvStream, parseXmltvString } from '../xmltv/parse.js';
import { isGuide, sniff } from './sniff.js';
import { XmltvSerializeStream } from '../xmltv/serialize.js';
import type { XmltvParseEvent } from '../xmltv/types.js';
import { guideBytes, writeOutput } from '../core/output.js';

/** How the report is written — the same two shapes `epg validate` offers. */
export const CHANNEL_REPORT_FORMATS = ['text', 'json'] as const;

export type ChannelReportFormat = (typeof CHANNEL_REPORT_FORMATS)[number];

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

/** What the report says about one wanted channel. */
export interface ChannelReportRow {
  wanted: WantedChannel;
  kind: ChannelMatchKind;
  /** The channel it lines up with, when it does. */
  matched?: { xmltvId: string; name?: string };
  /** Rivals, when more than one matched equally well. */
  ambiguous?: string[];
  /** What it looks like a timeshift of, and by how many minutes. */
  timeshiftOf?: { xmltvId: string; offset: number };
}

export interface ChannelReport {
  /** `false` when anything wanted has no guide behind it. */
  ok: boolean;
  counts: { wanted: number; byId: number; byName: number; unmatched: number };
  rows: ChannelReportRow[];
}

/** Line the wanted channels up against what the configured sites can produce. */
export function reportChannels(
  wanted: readonly WantedChannel[],
  available: readonly GrabberChannel[],
): ChannelReport {
  const matches = matchChannels(
    wanted.map((channel) => ({ id: channel.id, name: channel.name, value: channel })),
    available.map((channel) => ({
      id: channel.xmltvId,
      ...(channel.name === undefined ? {} : { name: channel.name }),
      value: channel,
    })),
  );

  const rows = matches.map((match): ChannelReportRow => ({
    wanted: match.source,
    kind: match.kind,
    ...(match.matched === undefined
      ? {}
      : {
          matched: {
            xmltvId: match.matched.xmltvId,
            ...(match.matched.name === undefined ? {} : { name: match.matched.name }),
          },
        }),
    ...(match.ambiguous === undefined
      ? {}
      : { ambiguous: match.ambiguous.map((rival) => rival.xmltvId) }),
    ...(match.timeshiftOf === undefined
      ? {}
      : {
          timeshiftOf: {
            xmltvId: match.timeshiftOf.channel.xmltvId,
            offset: match.timeshiftOf.offset,
          },
        }),
  }));

  const byId = rows.filter((row) => row.kind === 'id').length;
  const byName = rows.filter((row) => row.kind === 'name').length;

  return {
    // A name match is a *suggestion*, not a mapping — nothing has been written
    // anywhere, so a channel resting on one still shows an empty grid tomorrow.
    // `--check` fails on it, which is the point of having it in CI.
    ok: byId === rows.length,
    counts: { wanted: rows.length, byId, byName, unmatched: rows.length - byId - byName },
    rows,
  };
}

/** The report as a person reads it: only what is wrong, and what to do about it. */
export function renderChannelReport(report: ChannelReport): string {
  const { counts } = report;
  const lines: string[] = [];

  for (const row of report.rows) {
    if (row.kind === 'id') {
      continue;
    }

    const label = row.wanted.name || row.wanted.id || '(unnamed)';

    if (row.kind === 'name' && row.matched) {
      lines.push(
        `  ~ ${label}\n      looks like ${row.matched.xmltvId}${row.matched.name ? ` (${row.matched.name})` : ''} — set its id to confirm`,
      );
    } else if (row.timeshiftOf) {
      const hours = row.timeshiftOf.offset / 60;

      lines.push(
        `  ~ ${label}\n      a ${hours > 0 ? '+' : ''}${hours}h shift of ${row.timeshiftOf.xmltvId} — a derived channel, not a mapping`,
      );
    } else if (row.ambiguous) {
      lines.push(`  ? ${label}\n      matches ${row.ambiguous.join(', ')} equally — say which`);
    } else {
      lines.push(
        `  ✗ ${label}${row.wanted.id ? ` (${row.wanted.id})` : ''}\n      nothing produces this`,
      );
    }
  }

  const summary =
    `${counts.wanted} wanted, ${counts.byId} matched by id` +
    (counts.byName > 0 ? `, ${counts.byName} by name` : '') +
    (counts.unmatched > 0 ? `, ${counts.unmatched} with nothing` : '');

  return lines.length === 0
    ? `${summary}\nEvery channel has a guide behind it.`
    : `${lines.join('\n')}\n\n${summary}`;
}

export interface ChannelsCommandOptions {
  /** The file naming what is wanted. Without one there is nothing to compare. */
  against?: string | undefined;
  format?: string | undefined;
  /** Exit non-zero unless every wanted channel matched by id. */
  check?: boolean | undefined;
  /**
   * Write the ids the report suggested back into `--against`, in place.
   *
   * The two formats that carry a mapping of their own: a `*.channels.xml`'s
   * `xmltv_id`, and a playlist's `tvg-id`. Only entries that have **none** — an
   * id already there is somebody's decision, possibly one made against this
   * very suggestion, and replacing it silently is worse than leaving a channel
   * unmapped.
   */
  write?: boolean | undefined;
  signal?: AbortSignal | undefined;
}

/** One entry of a file that can be written back, however it spells its id. */
interface Mappable {
  /** What the report matches on. */
  wanted: WantedChannel;
  /** Whether it already names an id, in which case nothing is written. */
  mapped: boolean;
  /** What to call it in the summary. */
  label: string;
  set: (xmltvId: string) => void;
}

/** A file the report can write its answer back into. */
interface Mapping {
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
function mappingFor(text: string, from: string, found?: WantedChannel[]): Mapping {
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
async function guideChannels(bytes: AsyncGenerator<Uint8Array>): Promise<WantedChannel[]> {
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
export async function reportChannelsCommand(
  config: EpgConfig,
  options: ChannelsCommandOptions,
  stdout: Writable,
): Promise<number> {
  if (options.against === undefined) {
    throw new Error('epg channels needs --against <playlist.m3u | channels.xml | guide.xml>');
  }

  const format = options.format ?? 'text';

  if (!CHANNEL_REPORT_FORMATS.includes(format as ChannelReportFormat)) {
    throw new Error(`Unknown --format: ${format}`);
  }

  // Sniffed rather than read whole. A guide is the one of these formats that is
  // routinely 90 MiB, and both what this reports on and what `--write` puts back
  // stream through it — loading it to find out what it was would give that away
  // before either had started.
  const source = await sniff(options.against);
  const found = isGuide(source.head) ? await guideChannels(source.whole()) : undefined;
  const text = found === undefined ? await source.text() : '';

  // `--write` needs the entries themselves, not the ids and names `wantedFrom`
  // reduces them to, so an answer can be put back where it came from.
  const mapping = options.write === true ? mappingFor(text, options.against, found) : undefined;
  // Joined back by object identity rather than by position. `matchChannels`
  // does preserve order, but a row finding its entry by index would be one
  // refactor away from writing an id onto the wrong channel.
  const mappableOf = new Map<WantedChannel, Mappable>();

  for (const entry of mapping?.entries ?? []) {
    mappableOf.set(entry.wanted, entry);
  }

  const wanted =
    mapping !== undefined
      ? mapping.entries.map((entry) => entry.wanted)
      : (found ?? wantedFrom(text, options.against));
  const resolved = await resolveSites(config.sites as AnySiteConfig[], {
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const available = resolved.flatMap((site) => site.channels as GrabberChannel[]);

  // A derived channel is a channel this guide produces, so the report has to
  // count it. Without it a declared `+1` still reads as "nothing produces
  // this" — the report contradicting the config that answered it.
  //
  // The name is taken from the first site to offer the channel, which is the
  // one the merge would build the element from.
  const named = new Map<string, string | undefined>();

  for (const channel of available) {
    if (!named.has(channel.xmltvId)) {
      named.set(channel.xmltvId, channel.name);
    }
  }

  const derived = config.derived?.length
    ? derivedChannelList(config.derived, named).map((channel) => ({
        ...channel,
        // No site produces it, so there is no id any site would know it by.
        siteId: '',
      }))
    : [];

  const report = reportChannels(wanted, [...available, ...derived]);
  const written = fillIds(report, mappableOf);

  if (mapping !== undefined && written.length > 0) {
    await mapping.write();
  }

  await writeLines(
    stdout,
    format === 'json'
      ? JSON.stringify({ ...report, ...(mapping === undefined ? {} : { written }) }, null, 2)
      : renderChannelReport(report) + renderWritten(written, options.against),
  );

  // What was just written counts as matched: the ids are in the file now, so a
  // second run would match them by id, and failing the run that fixed them
  // would be a strange thing for a `--check` to do.
  const short = report.counts.wanted - report.counts.byId - written.length;

  return options.check === true && short > 0 ? 1 : 0;
}

/** One id written into one entry. */
interface WrittenId {
  label: string;
  xmltvId: string;
}

/**
 * Fill in the ids the report found a name for.
 *
 * The asymmetry the matcher is built on holds right up to here: an id match
 * needs nothing done, an ambiguous one is refused, and a timeshift is a
 * *derived* channel rather than a mapping. What is left is the name match —
 * which the report has been telling people to confirm by hand, and the flag is
 * that confirmation, given once for the whole file.
 */
function fillIds(report: ChannelReport, mappableOf: Map<WantedChannel, Mappable>): WrittenId[] {
  const written: WrittenId[] = [];

  for (const row of report.rows) {
    const entry = mappableOf.get(row.wanted);

    if (entry === undefined || entry.mapped || row.kind !== 'name' || !row.matched) {
      continue;
    }

    entry.set(row.matched.xmltvId);
    written.push({ label: entry.label, xmltvId: row.matched.xmltvId });
  }

  return written;
}

/** What was written, under the report that suggested it. */
function renderWritten(written: readonly WrittenId[], file: string): string {
  if (written.length === 0) {
    return '';
  }

  return [
    '',
    `Wrote ${written.length} ${written.length === 1 ? 'id' : 'ids'} into ${file}:`,
    ...written.map((one) => `  ${one.label} → ${one.xmltvId}`),
  ].join('\n');
}

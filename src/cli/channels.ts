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

import { readFile } from 'node:fs/promises';
import type { Writable } from 'node:stream';
import { matchChannels } from '../channels/match.js';
import { parseChannelsXml } from '../channels/parse.js';
import type { ChannelMatchKind } from '../channels/types.js';
import type { EpgConfig } from '../config.js';
import { resolveSites } from '../grabber/channels.js';
import type { AnySiteConfig, GrabberChannel } from '../grabber/types.js';
import { parseM3uString } from '../m3u/parse.js';
import { derivedChannelList } from '../merge/derive.js';
import { parseXmltvString } from '../xmltv/parse.js';

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
    ? `${summary}\nEvery channel has a guide behind it.\n`
    : `${lines.join('\n')}\n\n${summary}\n`;
}

export interface ChannelsCommandOptions {
  /** The file naming what is wanted. Without one there is nothing to compare. */
  against?: string | undefined;
  format?: string | undefined;
  /** Exit non-zero unless every wanted channel matched by id. */
  check?: boolean | undefined;
  signal?: AbortSignal | undefined;
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

  const wanted = wantedFrom(await readFile(options.against, 'utf8'), options.against);
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

  stdout.write(
    format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : renderChannelReport(report),
  );

  return options.check === true && !report.ok ? 1 : 0;
}

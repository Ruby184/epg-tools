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

import type { Writable } from 'node:stream';
import { matchChannels } from '../channels/match.js';
import type { ChannelMatchKind } from '../channels/types.js';
import type { EpgConfig } from '../config.js';
import { resolveSites } from '../grabber/channels.js';
import type { AnySiteConfig, GrabberChannel } from '../grabber/types.js';
import { derivedChannelList } from '../merge/derive.js';
import { writeLines } from '../core/streams.js';
import type { ReportFormat } from './format.js';
import { readChannelList } from './lists.js';
import type { ChannelListFile, WantedChannel } from './lists.js';

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
  format?: ReportFormat | undefined;
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
  /**
   * Where `--write` puts it, rather than back over `--against`.
   *
   * In place is the default because that is what writing an answer into your
   * own channel list means, and those files live in version control — `git
   * diff` is then exactly the ids added, since every reader here round-trips
   * byte for byte. `-o` is for the times that is not true: somebody else's
   * guide, a playlist you did not author, or simply wanting to look first.
   */
  output?: string | undefined;
  signal?: AbortSignal | undefined;
}

export async function reportChannelsCommand(
  config: EpgConfig,
  options: ChannelsCommandOptions,
  stdout: Writable,
): Promise<number> {
  if (options.against === undefined) {
    throw new Error('epg channels needs --against <playlist.m3u | channels.xml | guide.xml>');
  }

  // Said rather than ignored: `-o` is a global flag, and one given to a command
  // that is only reporting has been typed for a reason.
  if (options.output !== undefined && options.write !== true) {
    throw new Error('epg channels takes -o only with --write, which is what writes a file');
  }

  // Not re-checked here: `--format` is one flag with one set of choices, and
  // `parseOptions` refuses anything else before a command is reached.
  const format = options.format ?? 'text';

  // Which of the four this is, how much of it has to be held, and how an answer
  // goes back into it are all its own business — see `readChannelList`.
  const list = await readChannelList(options.against);
  const wanted = list.channels;
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
  const written = options.write === true ? fillIds(report, list) : [];

  await list.write(options.output);

  await writeLines(
    stdout,
    format === 'json'
      ? JSON.stringify({ ...report, ...(options.write === true ? { written } : {}) }, null, 2)
      : renderChannelReport(report) + renderWritten(written, options.output ?? options.against),
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
function fillIds(report: ChannelReport, list: ChannelListFile): WrittenId[] {
  const written: WrittenId[] = [];

  for (const row of report.rows) {
    if (row.kind !== 'name' || !row.matched) {
      continue;
    }

    // The file says whether that took: it knows what already had an id, and
    // whether it has anywhere to put one at all.
    if (list.map(row.wanted, row.matched.xmltvId)) {
      written.push({ label: list.label(row.wanted), xmltvId: row.matched.xmltvId });
    }
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

/**
 * `--explain`: what a run said of one thing, kept as it says it and written on
 * stderr once it is done — listed in full, where a run's own lines have room
 * for a count, and read: what the list most likely means, and what to change
 * for it.
 *
 * Each is made of events a run says anyway, and keeps only those it is about,
 * whatever level the run's reporter shows: what it is asked for is all of
 * them. What it reads into them it says as likely, never as found — it has
 * the events and the config, not the source. A program has every event of
 * its own, through `--reporter json`.
 */

import type { Writable } from 'node:stream';
import type { EpgConfig } from '../config.js';
import { count } from '../core/count.js';
import { addDays, diffDays } from '../core/days.js';
import {
  type EpgEvent,
  type Reporter,
  type RequestCounts,
  type TimeSpent,
} from '../core/events.js';
import { daySpan, failures, render, took, UNMATCHED_WHY } from '../core/reporters.js';
import { writeLines } from '../core/streams.js';
import { localSlots } from '../grabber/grab.js';
import { heldFor } from '../grabber/pacing.js';
import type { AnySiteConfig } from '../grabber/types.js';
import { mergeStrategies } from '../merge/guide.js';
import { resolveMatch } from '../merge/programme.js';

/** What `--explain` can be asked about. */
export const EXPLAINABLE = ['unmatched', 'empty', 'requests', 'held'] as const;

export type Explainable = (typeof EXPLAINABLE)[number];

/** What an explanation is told of a run: each kind of event it is about, and what it keeps of one. */
type Hears = { [T in EpgEvent['type']]?: (event: Extract<EpgEvent, { type: T }>) => void };

/** One explanation, as a run keeps it. */
interface Explanation {
  /** What it keeps of each kind of event it is about — and it is told of no other. */
  hears: Hears;
  /** What it kept, once the run is done: a heading, and what is under it. */
  lines(config: EpgConfig): Iterable<string>;
}

/** Each explanation: the commands whose run it is about, and a new one for a run. */
const EXPLANATION: Record<Explainable, { commands: readonly string[]; start: () => Explanation }> =
  {
    unmatched: { commands: ['build', 'merge'], start: unmatched },
    empty: { commands: ['build', 'grab'], start: empty },
    requests: { commands: ['build', 'grab'], start: requests },
    held: { commands: ['build', 'grab'], start: held },
  };

/** How many lines are written at a time: an explanation can be a guide's length. */
const BATCH = 1_000;

/** The commands whose run an explanation is about. */
export function explainCommands(name: Explainable): readonly string[] {
  return EXPLANATION[name].commands;
}

/**
 * The explanations `names` asks for, as one: the reporter that keeps what each
 * is about, to join to the run's own — none for none — and what writes them to
 * `out` once the run is done, in the order asked for, each once. Said where it
 * can be: stderr closed by whatever read it — `| head` — fails no command
 * whose guide is written.
 */
export function explanations(names: readonly Explainable[]): {
  reporter: Reporter | undefined;
  render(out: Writable, config: EpgConfig): Promise<void>;
} {
  const started = [...new Set(names)].map((name) => EXPLANATION[name].start());
  /**
   * Each kind of event, and the explanations it is told to: found once per
   * event, so the many no explanation is about — a request starting, a day
   * fresh in the cache — cost a run one lookup each.
   */
  const hearing = new Map<string, Array<(event: EpgEvent) => void>>();

  for (const { hears } of started) {
    for (const [type, hear] of Object.entries(hears)) {
      const told = hearing.get(type);
      const one = hear as (event: EpgEvent) => void;

      if (told === undefined) {
        hearing.set(type, [one]);
      } else {
        told.push(one);
      }
    }
  }

  return {
    reporter:
      started.length === 0
        ? undefined
        : Object.assign(
            (event: EpgEvent) => {
              const told = hearing.get(event.type);

              if (told !== undefined) {
                for (const hear of told) {
                  hear(event);
                }
              }
            },
            // The kinds it hears, and no other: a run need not make the rest.
            { wants: (type: EpgEvent['type']) => hearing.has(type) },
          ),
    async render(out, config) {
      let batch: string[] = [];
      /**
       * What is batched, written — and whether it could be: a stderr closed by
       * whatever read it has nowhere left to say the rest. Only the write is
       * let go of so: what an explanation throws is a fault, and the run's to
       * say.
       */
      const written = async (): Promise<boolean> => {
        try {
          await writeLines(out, ...batch);
        } catch {
          return false;
        }

        batch = [];

        return true;
      };

      for (const [at, explanation] of started.entries()) {
        // A blank line before each but the first, so each heading begins a
        // block of its own.
        if (at > 0) {
          batch.push('');
        }

        for (const line of explanation.lines(config)) {
          // At or past it: the blank line between two can bring it there.
          if (batch.push(line) >= BATCH && !(await written())) {
            return;
          }
        }
      }

      if (batch.length > 0) {
        await written();
      }
    },
  };
}

/** The site of that name in the config, where there is one. */
function siteIn(config: EpgConfig, name: string): AnySiteConfig | undefined {
  return config.sites.find((site) => site.site === name);
}

// ── unmatched ───────────────────────────────────────────────────────────────

type NearMiss = Extract<EpgEvent, { type: 'merge:unmatched' }>;

/**
 * `unmatched`: every programme the merge nearly joined to another source's and
 * did not — what `merge:summary` counts, and shows a few of — grouped by
 * channel, by the two sources and by what kept them apart, with what would
 * have joined a group, where its pairs agree on it: a source on a grid of its
 * own, which `startToleranceMs` would reach, or titles with more to them, which
 * a `normalizeTitle` would cut. Then each of them.
 */
function unmatched(): Explanation {
  const said: NearMiss[] = [];

  return {
    hears: {
      'merge:unmatched': (event) => {
        said.push(event);
      },
    },
    *lines(config) {
      const matching = matchingStrategy(config);

      if (matching !== undefined) {
        yield (
          `Near misses are looked for only under channelStrategy 'merge-programmes' and ` +
            `programmeStrategy 'merge', and this merge is under ${matching}.`
        );

        return;
      }

      if (said.length === 0) {
        yield 'No programmes nearly merged.';

        return;
      }

      /**
       * By channel, then the two sources, whichever of them came first: a
       * source's programme held over from the day before is met by the other's
       * first list as much as the other way round, and the two are one pair.
       */
      const groups = Map.groupBy(said, (event) =>
        [event.channelId, ...[event.programme.site, event.nearby.site].sort()].join('\0'),
      );

      const channels = new Set(said.map((event) => event.channelId));

      yield `${count(said.length, 'programme')} nearly merged, on ${count(channels.size, 'channel')}:`;

      for (const key of [...groups.keys()].sort()) {
        const pairs = groups.get(key)!;
        const [channelId, one, two] = key.split('\0') as [string, string, string];
        // Said of the one that more often joined nothing — the later of the
        // two, mostly — so it reads as the source that runs behind or ahead.
        const ones = pairs.filter((pair) => pair.programme.site === one).length;
        const [site, other] = ones * 2 >= pairs.length ? [one, two] : [two, one];

        yield `  ${channelId}, ${site} against ${other}:`;

        const byWhy = Map.groupBy(pairs, (event) => event.why);

        for (const [why, these] of [...byWhy].sort((a, b) => b[1].length - a[1].length)) {
          yield `    ${these.length} × ${UNMATCHED_WHY[why]}${whyMore(why, these, config, site)}`;
        }
      }

      yield '';
      yield 'Each of them:';

      for (const event of said) {
        yield `  ${render(event) ?? ''}`;
      }
    },
  };
}

/** What a group of pairs kept apart for one reason says, after a colon — or nothing. */
function whyMore(
  why: NearMiss['why'],
  pairs: readonly NearMiss[],
  config: EpgConfig,
  site: string,
): string {
  const [first] = pairs as [NearMiss];
  const example = `, e.g. "${first.programme.title}" / "${first.nearby.title}"`;

  switch (why) {
    case 'start':
      return startsApart(pairs, config, site);
    case 'title':
      return titlesApart(pairs, resolveMatch(config.merge?.match).normalizeTitle) ?? example;
    case 'runs':
      return ': programmes in a row, or one within the other — rightly kept apart';
    case 'both':
    case 'matcher':
      return example;
  }
}

/**
 * A group whose titles agree and whose starts are too far apart: by how much
 * `site` runs behind the other, where most of the pairs agree on it, and the
 * tolerance that would reach every one of them — said only where the config's
 * match is the shipped one, whose tolerance it is. Each pair's shift as of
 * `site`, whichever of the two its programme was.
 */
function startsApart(pairs: readonly NearMiss[], config: EpgConfig, site: string): string {
  const shifts = new Map<number, number>();
  let widest = 0;

  for (const pair of pairs) {
    const shift = pair.programme.site === site ? pair.shiftMs : -pair.shiftMs;
    const minutes = Math.round(shift / 60_000);

    shifts.set(minutes, (shifts.get(minutes) ?? 0) + 1);
    widest = Math.max(widest, Math.abs(pair.shiftMs));
  }

  /** The shift most of them share, and how many do. */
  const [minutes, sharing] = [...shifts].sort((a, b) => b[1] - a[1])[0] ?? [0, 0];
  const said: string[] = [];

  // Most of them, by the same few minutes: a source running behind the other.
  if (minutes !== 0 && sharing * 2 > pairs.length) {
    said.push(
      `${site} starts ${count(Math.abs(minutes), 'minute')} ` +
        `${minutes > 0 ? 'later' : 'earlier'}${onHowMany(sharing, pairs.length)}`,
    );
  }

  const match = config.merge?.match;
  const reaching = Math.ceil(widest / 60_000) * 60_000;
  const them = pairs.length === 1 ? 'it' : 'them';
  // Within reach is not joined: the shipped match still keeps apart two that
  // start further apart than the shorter lasts, which these say nothing of.
  const tolerance = (now: number): string =>
    `a startToleranceMs of ${reaching} would bring ${them} within reach (it is ${now}), ` +
    (pairs.length === 1
      ? 'and join it if the shorter of the two lasts longer than they are apart'
      : 'and join those whose shorter lasts longer than they are apart');

  // The shipped match's tolerance; a matcher's own window, which only lets it
  // be asked; and nothing of a bare function's, which has none. Each as the
  // merge resolves it, so what is said to be is what it was.
  const { windowMs } = resolveMatch(match);

  if (typeof match !== 'function') {
    said.push(
      match !== undefined && match !== null && 'matches' in match
        ? `a windowMs of ${reaching} would let its match be asked about ${them} (it is ${windowMs})`
        : tolerance(windowMs),
    );
  }

  return said.length === 0 ? '' : `: ${said.join(' — ')}`;
}

/**
 * A group whose titles differ: where most of its pairs differ the same way —
 * one source's titles going on past the other's after the same separator
 * (`DVTV: Jakub Kříž` against `DVTV`), or beginning with more before it —
 * which a `normalizeTitle` cutting there would join. Nothing, where they do not.
 * Compared as the merge compares them, by `normalize`.
 */
function titlesApart(
  pairs: readonly NearMiss[],
  normalize: (title: string) => string,
): string | undefined {
  const ways = new Map<
    string,
    { site: string; other: string; sep: string; after: boolean; n: number; e: NearMiss }
  >();

  for (const pair of pairs) {
    const way = differs(pair, normalize);

    if (way !== undefined) {
      const key = `${way.site}\0${way.sep}\0${String(way.after)}`;
      const seen = ways.get(key);

      if (seen === undefined) {
        ways.set(key, { ...way, n: 1, e: pair });
      } else {
        seen.n++;
      }
    }
  }

  const [most] = [...ways.values()].sort((a, b) => b.n - a.n);

  if (most === undefined || most.n * 2 <= pairs.length) {
    return undefined;
  }

  const on = onHowMany(most.n, pairs.length);
  const example = `"${most.e.programme.title}" / "${most.e.nearby.title}"`;

  return most.after
    ? `: ${most.site}'s titles go on past ${most.other}'s after "${most.sep}"${on}, e.g. ${example} — ` +
        `a normalizeTitle that cuts them there would join them`
    : `: ${most.site}'s titles begin with more, before "${most.sep}"${on}, e.g. ${example} — ` +
        `a normalizeTitle that keeps what follows it would join them`;
}

/**
 * Of how many of a group's pairs something holds — ` on both`, ` on all 5`,
 * ` on 4 of them` — or nothing, for a group of one: it is said of that one.
 */
function onHowMany(n: number, of: number): string {
  if (of === 1) {
    return '';
  }

  if (n < of) {
    return ` on ${n} of them`;
  }

  return of === 2 ? ' on both' : ` on all ${n}`;
}

/**
 * How one title of a pair is the other with more to it: whose, what separates
 * the rest, and whether the rest comes after — or nothing, where neither
 * holds the other whole.
 */
function differs(
  pair: NearMiss,
  normalize: (title: string) => string,
): { site: string; other: string; sep: string; after: boolean } | undefined {
  const a = normalize(pair.programme.title);
  const b = normalize(pair.nearby.title);
  const [longer, shorter, site, other] =
    a.length >= b.length
      ? [a, b, pair.programme.site, pair.nearby.site]
      : [b, a, pair.nearby.site, pair.programme.site];

  if (shorter === '' || longer === shorter) {
    return undefined;
  }

  if (longer.startsWith(shorter)) {
    const sep = /^[^\p{L}\p{N}]+/u.exec(longer.slice(shorter.length))?.[0];

    return sep === undefined ? undefined : { site, other, sep, after: true };
  }

  if (longer.endsWith(shorter)) {
    const sep = /[^\p{L}\p{N}]+$/u.exec(longer.slice(0, longer.length - shorter.length))?.[0];

    return sep === undefined ? undefined : { site, other, sep, after: false };
  }

  return undefined;
}

/**
 * The strategy a merge says it with that looks for no near misses, or
 * nothing, where it does: `merge-programmes` for its channels, and `merge` for
 * their programmes. `backfill` matches across sources too, to leave out what
 * another already has, but what it nearly matched it keeps as it is.
 */
function matchingStrategy(config: EpgConfig): string | undefined {
  const { channelStrategy: channels, programmeStrategy: programmes } = mergeStrategies(
    config.merge,
  );

  if (channels !== 'merge-programmes') {
    return `channelStrategy: '${channels}'`;
  }

  return programmes === 'merge' ? undefined : `programmeStrategy: '${programmes}'`;
}

// ── empty ───────────────────────────────────────────────────────────────────

/** Why a channel-day came back empty, as far as the run's other answers say. */
type EmptyWhy = 'elsewhere' | 'everywhere' | 'gap';

/**
 * `empty`: the channel-days a source answered with no programmes — what a run
 * counts as `(n empty)`, and names none of — and what the run's other answers
 * make of them. A source empty on every channel-day it was asked about, whose
 * parse may no longer read what it sends; one with nothing after a day on any
 * channel, which has not published that far; a channel-day another source has
 * programmes for, which this one may know by another id; one every source asked
 * about it is empty on; and one this source alone is empty on, a gap in its
 * listings.
 *
 * Read only from what the run saw. A channel-day served from the cache, said
 * unchanged by the source, or failed says nothing of what it holds, so it is
 * taken as one that may have programmes: nothing is claimed that it could make
 * untrue.
 */
function empty(): Explanation {
  /** Each channel's sources, each with the days it came back empty. */
  const channels = new Map<string, Map<string, Set<string>>>();
  /** Each channel-day's sources that answered it with programmes. */
  const answered = new Map<string, Set<string>>();
  /**
   * Each channel-day's sources whose programmes for it the run does not know:
   * served from the cache, said unchanged by the source, or failed.
   */
  const unknown = new Map<string, Set<string>>();
  /** Sources that failed whole — their channel list, or their turn — which may carry any channel. */
  const failed = new Set<string>();
  /** Each source's last day with programmes, or not known to have none — and its days with any. */
  const lastWith = new Map<string, string>();
  const daysWith = new Map<string, Set<string>>();

  const add = (into: Map<string, Set<string>>, key: string, value: string): void => {
    let set = into.get(key);

    if (set === undefined) {
      into.set(key, (set = new Set()));
    }

    set.add(value);
  };
  const reached = (site: string, day: string): void => {
    const last = lastWith.get(site);

    if (last === undefined || day > last) {
      lastWith.set(site, day);
    }
  };
  const unsure = (site: string, channelId: string, day: string): void => {
    add(unknown, `${channelId}\0${day}`, site);
    reached(site, day);
  };
  const had = (site: string, channelId: string, day: string): void => {
    add(answered, `${channelId}\0${day}`, site);
    add(daysWith, site, day);
    reached(site, day);
  };

  return {
    hears: {
      'entry:fetched': (event) => {
        if (event.programmes > 0) {
          had(event.site, event.channelId, event.day);

          return;
        }

        let sites = channels.get(event.channelId);

        if (sites === undefined) {
          channels.set(event.channelId, (sites = new Map()));
        }

        add(sites, event.site, event.day);
      },
      'entry:appended': (event) => {
        // Said a second time by a document not grouped by channel, and no
        // longer empty — as a run counts it.
        if (event.total > 0) {
          channels.get(event.channelId)?.get(event.site)?.delete(event.day);
          had(event.site, event.channelId, event.day);
        }
      },
      // What the run cannot see into: taken as days that may have programmes,
      // so nothing is claimed of them that they could make untrue.
      'entry:cached': (event) => {
        unsure(event.site, event.channelId, event.day);
      },
      'entry:unchanged': (event) => {
        unsure(event.site, event.channelId, event.day);
      },
      'entry:failed': (event) => {
        unsure(event.site, event.channelId, event.day);
      },
      'site:failed': (event) => {
        failed.add(event.site);
      },
      // Every channel-day it covered, which no `entry:failed` says one by one.
      'request:failed': (event) => {
        for (const channelId of event.channels) {
          for (const day of event.days) {
            unsure(event.site, channelId, day);
          }
        }
      },
    },
    *lines() {
      /** Every empty channel-day, then each source's: its site-wide reason, if it has one, and each one's. */
      const empties = [...channels].flatMap(([channelId, sites]) =>
        [...sites].flatMap(([site, these]) => [...these].map((day) => ({ channelId, site, day }))),
      );
      const bySite = Map.groupBy(empties, (one) => one.site);
      const days = empties.length;

      if (days === 0) {
        yield 'No channel-day came back empty.';

        return;
      }

      yield `${count(days, 'channel-day')} came back empty:`;

      /** What is left once a source's own reason has taken its share: channel, source, why, day. */
      const left: Array<{
        channelId: string;
        site: string;
        why: EmptyWhy;
        day: string;
        others: string[];
      }> = [];

      for (const site of [...bySite.keys()].sort()) {
        const list = bySite.get(site)!;
        const last = lastWith.get(site);

        // Nothing from it at all: not a channel's problem, but the source's.
        if (last === undefined) {
          const named = new Set(list.map((one) => one.channelId));

          yield (
            `  ${site}: every channel-day it was asked about came back empty — ${count(list.length, 'channel-day')} on ${count(named.size, 'channel')}: ` +
              `its parseDay may no longer read what the source sends, or the source has nothing`
          );
          continue;
        }

        const after = list.filter((one) => one.day > last);

        if (after.length > 0) {
          const named = new Set(after.map((one) => one.channelId));

          yield (
            `  ${site}: nothing after ${last} on any channel — it has not published that far yet: ` +
              `${spans([...new Set(after.map((one) => one.day))].sort())}, on ${count(named.size, 'channel')}`
          );
        }

        for (const { channelId, day } of list) {
          if (day > last) {
            continue;
          }

          const key = `${channelId}\0${day}`;
          const others = [...(answered.get(key) ?? [])].filter((other) => other !== site).sort();
          // The sources that answered this channel-day with none, read off what
          // is kept of each empty day rather than kept a second time.
          const blank = [...(channels.get(channelId) ?? [])]
            .filter(([, days]) => days.has(day))
            .map(([other]) => other);

          if (others.length > 0) {
            left.push({ channelId, site, why: 'elsewhere', day, others });
          } else if (
            blank.some((other) => other !== site) &&
            ![...(unknown.get(key) ?? [])].some((other) => other !== site)
          ) {
            // Every source that answered: one that failed whole and said
            // nothing of the day may have had it.
            const heard = new Set([
              ...(answered.get(key) ?? []),
              ...blank,
              ...(unknown.get(key) ?? []),
            ]);
            const silent = [...failed].filter((other) => !heard.has(other)).sort();

            left.push({ channelId, site, why: 'everywhere', day, others: silent });
          } else {
            left.push({ channelId, site, why: 'gap', day, others: [] });
          }
        }
      }

      // Each channel and source's days of one reason as one line, in runs.
      const lines = Map.groupBy(left, (one) => `${one.channelId}\0${one.site}\0${one.why}`);

      for (const key of [...lines.keys()].sort()) {
        const these = lines.get(key)!;
        const { channelId, site, why } = these[0]!;
        const daysOf = these.map((one) => one.day).sort();
        const others = [...new Set(these.flatMap((one) => one.others))].sort();

        yield `  ${channelId} (${site}): ${spans(daysOf)} — ${emptyBecause(why, site, others, daysOf, daysWith)}`;
      }
    },
  };
}

/** Why a run of one source's empty channel-days came back so, in words. */
function emptyBecause(
  why: EmptyWhy,
  site: string,
  others: readonly string[],
  days: readonly string[],
  daysWith: ReadonlyMap<string, ReadonlySet<string>>,
): string {
  switch (why) {
    case 'elsewhere':
      return (
        `${others.join(', ')} ${others.length === 1 ? 'has' : 'have'} programmes then: ` +
        `${site} may know it by another id, or have stopped carrying it`
      );
    // Of those asked: a source that carries it, and was not asked about the
    // day — fewer `days`, or a turn cut short — may have it.
    case 'everywhere':
      return others.length === 0
        ? 'every source asked about it came back empty then: off air, or not published yet'
        : `every source asked about it that answered came back empty then, though ` +
            `${others.join(', ')} failed and may have it: off air, or not published yet`;
    case 'gap':
      return days.every((day) => daysWith.get(site)?.has(day))
        ? `${site} has programmes on other channels then: a gap in its listings, or off air`
        : `nothing else says otherwise: off air, or a gap in ${site}'s listings`;
  }
}

/** Days, in order, as the runs they make: `2026-10-24..2026-10-26 (3 days), 2026-10-28`. */
function spans(days: readonly string[]): string {
  const runs: string[] = [];
  let first = days[0]!;
  let last = first;

  for (const day of days.slice(1)) {
    if (day !== addDays(last, 1)) {
      runs.push(span(first, last));
      first = day;
    }

    last = day;
  }

  runs.push(span(first, last));

  return runs.join(', ');
}

/** One run of days: the day, or `first..last (n days)`. */
function span(first: string, last: string): string {
  return first === last ? first : daySpan(first, last, diffDays(last, first) + 1);
}

// ── requests ────────────────────────────────────────────────────────────────

/** What each part of a site's time is, in words — see `TimeSpent`. */
const SPENT_ON: Record<keyof TimeSpent, string> = {
  source: 'on the source',
  held: 'held by the source',
  rateLimit: 'under its own rateLimit',
  working: 'parsing and writing',
  queued: 'waiting for a local slot',
  other: 'on other things',
};

/**
 * What a request's failure most likely means, by what it failed with — and,
 * of a status, whether the site's backoff holds it for one: `holds`.
 */
function failureMeans(failure: string, holds: readonly number[]): string {
  // Held for it, and failed all the same.
  if (holds.includes(Number(failure))) {
    return `were told to slow down (${failure}) — see --explain held`;
  }

  switch (failure) {
    case '404':
    case '410':
      return `were answered ${failure}: the source has nothing at those addresses — ids it no longer knows, or details of programmes it has dropped`;
    case '401':
    case '403':
      return `were refused (${failure}): credentials, or a block`;
    case '429':
      return 'were told to slow down (429), which its backoff does not hold for: backoff, or a rateLimit, would pace it';
    case 'timeout':
      return "took longer than the site's timeout";
    case 'network':
      return 'were answered by nothing: the source down, or out of reach';
    case 'error':
      return "threw something that was not the source's answer: the site's own code";
    default:
      return /^5\d\d$/.test(failure)
        ? `failed at the source (${failure})`
        : `were answered ${failure}: the source would not give what was asked`;
  }
}

/**
 * `requests`: every site's requests by what each was for — how many, how long
 * they were out to the source, how long they waited in its queue first, and
 * what failed them, as a table — then where each site's time went, what it
 * spent most of it on and what would change that, and what its failures most
 * likely mean.
 */
function requests(): Explanation {
  /** Each site's `site:done`. */
  const sites = new Map<string, Extract<EpgEvent, { type: 'site:done' }>>();
  const pace = new Pace();

  return {
    hears: {
      ...pace.hears,
      'site:done': (event) => {
        sites.set(event.site, event);
      },
    },
    *lines(config) {
      const rows: string[][] = [];
      const none: string[] = [];
      const names = [...sites.keys()].sort();

      for (const site of names) {
        const labels = Object.entries(sites.get(site)!.requestsBy);

        if (labels.length === 0) {
          none.push(site);
        }

        for (const [label, counts] of labels) {
          rows.push([
            site,
            label,
            String(counts.requests),
            took(counts.requestMs),
            took(counts.waitedMs),
            failures(counts.failed),
          ]);
        }
      }

      if (sites.size === 0) {
        yield 'No site was run.';

        return;
      }

      if (rows.length === 0) {
        yield 'No site sent a request.';
      } else {
        yield 'Requests, by site and what each was for:';
        yield* table([['site', 'label', 'requests', 'waiting', 'in queue', 'failed'], ...rows]);

        if (none.length > 0) {
          yield `  None from ${none.join(', ')}.`;
        }
      }

      yield '';
      yield "Where each site's time went:";

      for (const site of names) {
        yield* spentBy(sites.get(site)!, config, pace.of(site));
      }
    },
  };
}

/** One site's time, part by part, what it spent most of it on, and its failures read. */
function* spentBy(
  done: Extract<EpgEvent, { type: 'site:done' }>,
  config: EpgConfig,
  told: Paced | undefined,
): Generator<string> {
  const parts = (Object.entries(done.msBy) as Array<[keyof TimeSpent, number]>)
    .filter(([, ms]) => ms > 0)
    .sort((a, b) => b[1] - a[1]);

  yield (
    `  ${done.site} took ${took(done.ms)}` +
      (parts.length === 0
        ? '.'
        : `: ${parts.map(([part, ms]) => `${took(ms)} ${SPENT_ON[part]}`).join(', ')}.`)
  );

  const [most] = parts;

  // Only where one part is most of a time worth asking about.
  if (most !== undefined && done.ms >= 1_000 && most[1] * 2 >= done.ms) {
    yield `    ${mostly(most[0], done, config, told)}`;
  }

  const holds = heldFor(siteIn(config, done.site)?.backoff);

  for (const [label, counts] of Object.entries(done.requestsBy)) {
    yield* failuresOf(label, counts, holds);
  }
}

/**
 * What a site spending most of its time on `part` most likely means — of one
 * the source held, or whose concurrency it took down, what it was told rather
 * than that it could ask for more.
 */
function mostly(
  part: keyof TimeSpent,
  done: Extract<EpgEvent, { type: 'site:done' }>,
  config: EpgConfig,
  told: Paced | undefined,
): string {
  const site = siteIn(config, done.site);

  switch (part) {
    case 'source': {
      const at = site?.concurrency ?? 1;

      // Nothing to overlap, nor to be told to slow down for.
      if (done.requests === 1) {
        return 'Mostly waiting on the source, for its one request: the source is the slow part.';
      }

      if (told?.lowest !== undefined && told.lowest < at) {
        return (
          `Mostly waiting on the source, its concurrency of ${at} taken as low as ${told.lowest} ` +
          `by the source's slow-downs — see --explain held.`
        );
      }

      // Told to slow down, so not to be asked any faster.
      if (told !== undefined && told.holds > 0) {
        return (
          `Mostly waiting on the source, ${at === 1 ? 'one request' : `${at} requests`} at a time, ` +
          `and told to slow down ${often(told.holds)}: it would take no more — see --explain held.`
        );
      }

      return at === 1
        ? 'Mostly waiting on the source, one request at a time: a concurrency above 1 would overlap them, where the source allows it.'
        : `Mostly waiting on the source, ${at} requests at a time: the source is the slow part.`;
    }
    case 'held':
      return 'Mostly held by the source: it is asked faster than it allows — see --explain held.';
    case 'rateLimit':
      return site?.rateLimit === undefined
        ? 'Mostly under its own rateLimit: the source may allow more.'
        : `Mostly under its own rateLimit of ${site.rateLimit.requests} per ${site.rateLimit.perMs}ms: the source may allow more.`;
    case 'working':
      return config.threads
        ? 'Mostly its own parsing and writing: a parse, or a cache, that is slow.'
        : 'Mostly its own parsing and writing: a parse, or a cache, that is slow — with --threads, only the sites that share its thread wait on it.';
    case 'queued': {
      const slots = localSlots(config.localConcurrency);

      return config.threads
        ? `Mostly waiting for a local slot — one of its thread's ${slots}, or one of the run's thread's ${slots}, where its cache is read and written — which other work held: a higher localConcurrency lets it in sooner.`
        : `Mostly waiting for one of the run's ${slots} local slots, which other sites' work held: a higher localConcurrency, or --threads, lets it in sooner.`;
    }
    case 'other':
      return 'Mostly none of these: its own code between requests, or reading what it remembered.';
  }
}

/** What each way a label's requests failed most likely means — see {@link failureMeans}. */
function* failuresOf(
  label: string,
  counts: RequestCounts,
  holds: readonly number[],
): Generator<string> {
  for (const [failure, n] of Object.entries(counts.failed)) {
    yield `    ${n} of its ${counts.requests} ${label} requests ${failureMeans(failure, holds)}.`;
  }
}

/**
 * Rows as columns, each as wide as its widest: text to the left, the counts and
 * times — the third to fifth — to the right, and the last as it is.
 */
function* table(rows: readonly string[][]): Generator<string> {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  const last = widths.length - 1;

  for (const row of rows) {
    const cells = row.map((cell, column) =>
      column === last
        ? cell
        : column >= 2
          ? cell.padStart(widths[column]!)
          : cell.padEnd(widths[column]!),
    );

    yield `  ${cells.join('  ')}`.trimEnd();
  }
}

// ── held ────────────────────────────────────────────────────────────────────

/** What a site was told about its pace — see {@link Pace}. */
interface Paced {
  /** How many times it was told to hold — a hold begun, or made longer — by the status it was told with. */
  statuses: Record<string, number>;
  /** How many holds it had, how many times one was made longer, and the longest it was told to hold for. */
  holds: number;
  lengthened: number;
  longestMs: number;
  /** Times the source said how long for: as long as it asked, and cut short by `backoff.maxMs`. */
  asked: number;
  capped: number;
  /** The longest a capped hold asked for. */
  askedMs: number;
  /** How low its concurrency was taken, and where it was left — if it was. */
  lowest?: number;
  last?: number;
}

/**
 * What each site was told about its pace — every hold and slow-down — kept by
 * each explanation that reads it, its `hears` spread into that one's: one way
 * of counting them, wherever they are counted.
 */
class Pace {
  readonly #sites = new Map<string, Paced>();

  readonly hears: Hears = {
    'pacing:held': (event) => {
      const one = this.#paced(event.site);
      const status = String(event.status);

      one.statuses[status] = (one.statuses[status] ?? 0) + 1;
      // One hold made longer is not two.
      if (event.lengthened) {
        one.lengthened += 1;
      } else {
        one.holds += 1;
      }

      one.longestMs = Math.max(one.longestMs, event.ms);

      if (event.retryAfterMs === undefined) {
        return;
      }

      if (event.retryAfterMs > event.ms) {
        one.capped += 1;
        one.askedMs = Math.max(one.askedMs, event.retryAfterMs);
      } else {
        one.asked += 1;
      }
    },
    'pacing:slowed': (event) => {
      const one = this.#paced(event.site);

      one.lowest = Math.min(one.lowest ?? Infinity, event.concurrency);
      one.last = event.concurrency;
    },
    'pacing:recovered': (event) => {
      this.#paced(event.site).last = event.concurrency;
    },
  };

  /** Each site told anything, by name. */
  get sites(): ReadonlyMap<string, Paced> {
    return this.#sites;
  }

  /** What `site` was told, if anything. */
  of(site: string): Paced | undefined {
    return this.#sites.get(site);
  }

  #paced(site: string): Paced {
    let one = this.#sites.get(site);

    if (one === undefined) {
      this.#sites.set(
        site,
        (one = {
          statuses: {},
          holds: 0,
          lengthened: 0,
          longestMs: 0,
          asked: 0,
          capped: 0,
          askedMs: 0,
        }),
      );
    }

    return one;
  }
}

/** What a status a source holds a site with means. */
const HELD_WITH: Record<string, string> = {
  429: "too many requests — the source's rate limit",
  503: 'unavailable — overloaded, or a limit it does not name',
};

/**
 * `held`: the sites a source told to slow down — how often, with what, and for
 * how long at most — and how far that took their concurrency; then what each
 * status means, whether it was held as long as the source asked, and the pace
 * that earned it beside the `rateLimit` that would have kept under it.
 */
function held(): Explanation {
  const pace = new Pace();
  /** Each site's pace, kept for whichever is held — known only once it is done. */
  const done = new Map<string, Sent>();

  return {
    hears: {
      ...pace.hears,
      'site:done': (event) => {
        done.set(event.site, { requests: event.requests, outMs: event.msBy.source });
      },
    },
    *lines(config) {
      if (pace.sites.size === 0) {
        yield 'No site was told to slow down.';

        return;
      }

      yield `${count(pace.sites.size, 'site')} told to slow down:`;

      for (const site of [...pace.sites.keys()].sort()) {
        yield* heldBy(site, pace.of(site)!, done.get(site), config);
      }
    },
  };
}

/** How often: `once`, `twice`, `3 times`. */
function often(n: number): string {
  return n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`;
}

/**
 * How many requests a site sent, and how long it had any out to the source
 * and was not held — the pace it was sending at, which earned the holds: the
 * holds themselves, a wait for a local slot, or its own parsing, say nothing
 * of it.
 */
interface Sent {
  requests: number;
  outMs: number;
}

/** One site's holds, and what they most likely mean. */
function* heldBy(
  name: string,
  paced: Paced,
  done: Sent | undefined,
  config: EpgConfig,
): Generator<string> {
  const { statuses, holds, lengthened, longestMs, asked, capped, askedMs, lowest, last } = paced;
  /** Each time it was told to hold: a hold begun, or one made longer. */
  const times = holds + lengthened;

  yield (
    `  ${name}: held ${often(holds)}` +
      (lengthened > 0
        ? `, made longer ${often(lengthened)} while it held — for up to ${took(longestMs)} each time it was told`
        : holds === 1
          ? `, for ${took(longestMs)}`
          : `, for up to ${took(longestMs)} at a time`) +
      (lowest === undefined
        ? ''
        : `; concurrency down to ${lowest}` +
          (last !== undefined && last > lowest ? `, back up to ${last}` : ''))
  );

  for (const [status, n] of Object.entries(statuses)) {
    yield `    ${n} × ${status}: ${HELD_WITH[status] ?? 'a status its backoff.statuses lists'}`;
  }

  const unsaid = times - asked - capped;

  if (asked > 0) {
    yield `    As long as the source asked, ${asked === times ? 'each time' : often(asked)}.`;
  }

  if (capped > 0) {
    yield (
      `    Cut short by backoff.maxMs ${often(capped)}, where the source asked for up to ` +
        `${took(askedMs)}: let go sooner than it wanted, the site is likely to be held again.`
    );
  }

  if (unsaid > 0) {
    yield `    For the fallback ${often(unsaid)} — backoff.fallbackMs, at most backoff.maxMs — the source saying nothing of how long.`;
  }

  const site = siteIn(config, name);

  if (done !== undefined && done.outMs > 0) {
    const pace = (done.requests * 1000) / done.outMs;
    const rate = pace >= 10 ? pace.toFixed(0) : pace.toFixed(1);

    yield (
      `    It sent ${count(done.requests, 'request')}, ${rate} a second over the ${took(done.outMs)} it had any out unheld, ` +
        (site?.rateLimit === undefined
          ? 'with no rateLimit: a rateLimit below that pace would keep it from being held, at the cost of the time that takes.'
          : `under a rateLimit of ${site.rateLimit.requests} per ${site.rateLimit.perMs}ms: the source allows less than that.`)
    );
  }
}

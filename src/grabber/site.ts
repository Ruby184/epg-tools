/**
 * Reading a site config: which of the two shapes it is, and what it settles to
 * once the run's defaults are folded in.
 *
 * Every default a site can leave to the run is resolved here, in one pass, so
 * nothing downstream spells one out again — and every member a site must bring is
 * checked here, before a queue exists or a request goes out.
 */

import { DEFAULT_STALENESS } from '../cache/main.js';
import type { StalenessPolicy } from '../cache/types.js';
import { sameClock } from '../xmltv/zone.js';
import { dayIn, dayRange, daysCovering, resolveTimeZone } from '../core/days.js';
import { errorMessage } from '../core/error.js';
import { resolveBatching, type ResolvedBatching } from './planner.js';
import { LABELS } from './labels.js';
import type {
  AnySiteConfig,
  BatchingOption,
  GrabOptions,
  PacedOptions,
  SiteConfig,
  StreamSiteConfig,
} from './types.js';

/**
 * How many days a run covers when neither the site nor the run says.
 *
 * Exported because `--dry-run` has to name the window before a site is
 * resolved, and a second copy of this number is a report that disagrees with
 * the run it describes.
 */
export const DEFAULT_DAYS = 7;

/**
 * A site's settings as the run needs them: checked, and with the run's defaults
 * and the site's own overrides already folded in.
 *
 * Settings *and* the config, narrowed — which is the point of the two shapes
 * below. Deciding which one a site is happens here, once, and what comes out
 * says so in a way the compiler follows: nothing downstream has to assert what
 * kind of config it is holding, and neither pipeline can be handed the wrong
 * one. The config itself is passed through rather than picked apart, so a site
 * written with `this` keeps it.
 */
interface ResolvedSiteBase {
  /** Cache namespace and log prefix. */
  site: string;
  /**
   * The days this run covers for this site, ascending — on the site's own
   * calendar, which is the run's unless {@link dayZone} says otherwise.
   */
  window: string[];
  /** The zone the site's days are on: the run's own, or the one its `dayZone` names. */
  dayZone: string;
  /** How wide a request may be along each axis, and the context shape it gets. */
  batching: ResolvedBatching;
  /** When a cached day counts as stale: run policy under site override. */
  staleness: StalenessPolicy;
  /**
   * What its own requests are counted as: its `requestLabel`, or `request` —
   * `stream`, for a stream's `paced` calls that give no label.
   */
  requestLabel: string;
}

/** A site that fetches a request at a time and parses each channel-day out of it. */
export interface ResolvedFetchSite extends ResolvedSiteBase {
  isStreaming: false;
  config: SiteConfig<any, BatchingOption, any>;
}

/** A site that answers its whole window in one pass. */
export interface ResolvedStreamSite extends ResolvedSiteBase {
  isStreaming: true;
  config: StreamSiteConfig<any>;
}

export type ResolvedSite = ResolvedFetchSite | ResolvedStreamSite;

/**
 * Whether this config is the streaming shape, by the one member that says so.
 *
 * The cast inside is the only one either shape needs: a runtime check is exactly
 * what establishes the type, and everything downstream is narrowed rather than
 * asserted.
 */
export function isStreamSite(config: AnySiteConfig): config is StreamSiteConfig<any> {
  return typeof (config as StreamSiteConfig).stream === 'function';
}

/** What arrived instead, so a message about a mandatory member can name it. */
function received(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  // The one string a check for a non-empty one refuses, said as itself.
  if (value === '') {
    return 'an empty string';
  }

  if (Array.isArray(value)) {
    return 'an array';
  }

  const kind = typeof value;

  return kind === 'undefined' ? 'undefined' : `${kind === 'object' ? 'an' : 'a'} ${kind}`;
}

/**
 * What reads as one name on the text line — `(request 49, detail 5242: 3242
 * × 404)` — and so what a label may be: a word, or words joined by `.`, `_`,
 * `/` or `-`, in any script — a letter's combining marks with it, as a vowel
 * sign or a decomposed accent is. A space, a comma or a colon would read as the
 * line's own.
 */
const LABEL = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:[._/-][\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*$/u;

/**
 * A letter, which a label must have one of: `404` beside a status would read
 * as one, and a key of digits alone is put first in any object, whatever
 * order it was sent in.
 */
const LETTER = /\p{L}/u;

/**
 * A label a site gave its requests, where it is one — `what` says where it was
 * given. A name on the text line and a key in `requestsBy`: an empty one would
 * read as a gap there, a number would be one key here and another there and
 * read as a status, and `channels` would count the site's requests as the
 * run's list fetch.
 *
 * Answered composed (NFC): a word written with an accent of its own and one
 * written with a combining mark print alike, and are one label.
 */
export function labelOf(site: string, label: unknown, what: string): string {
  if (typeof label !== 'string' || !LABEL.test(label) || !LETTER.test(label)) {
    throw new RefusedLabel(
      `Site "${site}": ${what} names what requests are for, as a word — letters and digits, ` +
        `a letter among them, joined by . _ / or - (got ${
          typeof label === 'string' && label !== '' ? JSON.stringify(label) : received(label)
        })`,
      typeof label === 'string' ? 'a string that is no word' : received(label),
    );
  }

  const composed = label.normalize('NFC');

  if (composed === LABELS.channels) {
    throw new RefusedLabel(
      `Site "${site}": ${what} cannot be "${LABELS.channels}", which is what a run counts a ` +
        `fetched channel list as`,
      `"${LABELS.channels}"`,
    );
  }

  return composed;
}

/**
 * A label {@link labelOf} refused, and which mistake it was — not which value:
 * a site making its labels from what each request is for makes the same
 * mistake with a new one every time, and is told of it once.
 */
class RefusedLabel extends TypeError {
  readonly mistake: string;

  constructor(message: string, mistake: string) {
    super(message);
    this.mistake = mistake;
  }
}

/** How many labels a site's `paced` calls are checked once each, rather than at every call. */
const CHECKED_LABELS = 256;

/**
 * What a `ctx.paced` call is counted as: the label its options give, checked,
 * or `fallback` where they give none. One for the site, so a label is checked
 * once for the whole of its run, and every context's `paced` asks it — a
 * closure of the context's own, and nothing more, per channel-day.
 *
 * A label that is no label is a mistake in the site's code rather than a
 * request that failed, so `paced` is to ask before it returns: it throws where
 * `paced` is called — not as the call's rejection, which a `.catch` meant for
 * a `404` would swallow — and is said once, through `warn`, beside: a `try`
 * around the `await` catches what is thrown, and with it every request the
 * site meant to send.
 */
export function pacedLabels(
  site: string,
  warn: (message: string) => void,
): (options: PacedOptions | undefined, fallback: string) => string {
  // A site sends thousands under a handful of labels: each is checked once,
  // and kept as it is counted.
  const checked = new Map<string, string>();
  const said = new Set<string>();

  /**
   * Throw `error`, said once for the `kind` of mistake it is — not for each
   * value: a label made from what each request is for, a url or an object
   * built for the call, is a new one every time, and would be said for every
   * request the site meant to send.
   */
  function refuse(kind: string, error: unknown): never {
    if (!said.has(kind)) {
      said.add(kind);
      warn(`${errorMessage(error)} — no request is sent with it`);
    }

    throw error;
  }

  return (options, fallback) => {
    // A label handed as it is, where its options go — `paced(task, 'detail')`
    // — would otherwise be no label at all, and counted as the fallback.
    if (
      options !== undefined &&
      (typeof options !== 'object' || options === null || Array.isArray(options))
    ) {
      refuse(
        `options that are ${received(options)}`,
        new TypeError(
          `Site "${site}": a paced request's options are an object, such as ` +
            `{ label: 'detail' } (got ${received(options)})`,
        ),
      );
    }

    const label = options?.label;

    if (label === undefined) {
      return fallback;
    }

    let counted = checked.get(label);

    if (counted === undefined) {
      try {
        counted = labelOf(site, label, "a paced request's label");
      } catch (error) {
        refuse(`a label that is ${(error as RefusedLabel).mistake}`, error);
      }

      // Kept for the next time, while there are few: a site naming its
      // requests one by one would otherwise keep every name it made.
      if (checked.size < CHECKED_LABELS) {
        checked.set(label, counted);
      }
    }

    return counted;
  };
}

/**
 * A site's name — its cache namespace, and what every event says it as — or a
 * throw saying it has none: a site refused for it, as one that cannot be told
 * from another.
 */
export function siteName(config: { site?: unknown }): string {
  if (typeof config.site !== 'string' || config.site === '') {
    throw new TypeError(
      `A site must define site: a non-empty string, unique to it, naming its cache namespace ` +
        `(got ${received(config.site)})`,
    );
  }

  return config.site;
}

/**
 * Resolve one site against the run: check what it must bring, then settle every
 * default in one pass.
 *
 * The types make every one of these mandatory, so the checks are for configs
 * that arrive without having been held to them — plain JS, or a config file the
 * CLI imported and this package never saw compiled. Each would otherwise surface
 * a long way from its cause: `parseDay` once per channel-day, and only after
 * every request had already gone out; `channels` as a missing `flatMap`; and
 * `site` not at all, quietly filing this site's cached days under `undefined`, in
 * with those of every other site that left it out.
 *
 * Each message says what the member is *for*, because at this point the mistake
 * is usually a misspelling or a shape that has moved on, not ignorance that it
 * exists.
 *
 * It is also where the two shapes are told apart, by the one member that says
 * so: a site with `stream` answers its whole window in one pass and is asked for
 * neither `request` nor `parseDay`.
 */
export function resolveSite(
  config: AnySiteConfig,
  defaults: Pick<GrabOptions, 'days' | 'staleness'>,
  startDay: string,
  /** The zone the run's days are on — see `GrabOptions.timeZone`. */
  timeZone: string,
  /** The run's "now", which decides a leading day the site is not asked for — see {@link siteWindow}. */
  now?: Date,
): ResolvedSite {
  siteName(config);

  if (typeof config.channels !== 'function' && !Array.isArray(config.channels)) {
    throw new TypeError(
      `Site "${config.site}" must define channels: an array of channels, or a function ` +
        `returning one (got ${received(config.channels)})`,
    );
  }

  // Refused here, where it fails this site alone: everywhere else a run reads
  // its sites, a zone that is not one reads as the run's, so one site's mistake
  // cannot stop the others.
  if (
    config.dayZone !== undefined &&
    config.dayZone !== 'source' &&
    config.dayZone !== 'run' &&
    config.dayZone !== 'utc'
  ) {
    resolveTimeZone(config.dayZone, `Site "${config.site}" dayZone`);
  }

  const requestLabel =
    config.requestLabel === undefined
      ? undefined
      : labelOf(config.site, config.requestLabel, 'requestLabel');

  const common = {
    site: config.site,
    window: siteWindow(
      config,
      startDay,
      config.days ?? defaults.days ?? DEFAULT_DAYS,
      timeZone,
      now,
    ),
    dayZone: siteDayZone(config, timeZone),
    staleness: { ...DEFAULT_STALENESS, ...defaults.staleness, ...config.staleness },
  };

  // Before the two shapes are told apart, because a config with both has not
  // said which it is: `isStreamSite` would pick `stream` and its `request` would
  // never be called, silently.
  //
  // Checked rather than made impossible in the types. `request?: never` on
  // `StreamSiteConfig` does give a compile error, and it also turns `request`
  // into a discriminant — which makes the two checks below provably dead code,
  // narrows `config` to `never` inside them, and needs a cast to write at all.
  // Those checks are the whole defence for a config written in JavaScript, and
  // this one catches that config too.
  if (isStreamSite(config) && typeof (config as { request?: unknown }).request === 'function') {
    throw new TypeError(
      `Site "${config.site}" defines both stream and request, so it has not said which shape ` +
        `it is: stream answers the whole window in one pass, request answers one at a time. ` +
        `Keep one.`,
    );
  }

  if (isStreamSite(config)) {
    return {
      ...common,
      // A site that streams is asked about its whole window at once, which is
      // what `both` with no caps already plans: one request over every stale
      // channel-day. So the planner needs no idea that this site is different.
      batching: resolveBatching({ mode: 'both' }),
      isStreaming: true,
      requestLabel: requestLabel ?? LABELS.stream,
      config,
    };
  }

  // The types promise both of these, so these checks are for a config that was
  // never held to them — and `typeof` is the only thing that can tell.
  if (typeof config.request !== 'function') {
    throw new TypeError(
      `Site "${config.site}" must define request: a function fetching one request's raw data ` +
        `— or stream, a function yielding one channel-day at a time out of a whole document ` +
        `(got ${received(config.request)})`,
    );
  }

  if (typeof config.parseDay !== 'function') {
    throw new TypeError(
      `Site "${config.site}" must define parseDay: a function turning a response into one ` +
        `channel-day's programmes (got ${received(config.parseDay)})`,
    );
  }

  return {
    ...common,
    batching: resolveBatching(config.batching),
    isStreaming: false,
    requestLabel: requestLabel ?? LABELS.request,
    config,
  };
}

/**
 * The zone a site's channel-days are on: the run's own unless its `dayZone`
 * names another — `'utc'`, or an IANA zone.
 *
 * `'source'`, the default, is taken for the run's: a source filing a programme
 * under the day its own offset says is assumed to keep the calendar the guide
 * is for, which nothing about it could confirm or deny.
 *
 * A zone on the run's own clock is the run's, whatever it is called: another
 * name for it — `Europe/Bratislava` beside `Europe/Prague` — or another zone on
 * the same rules. Taken for another calendar, it would have the guide file its
 * programmes by when they start, and lose a source's after-midnight programmes
 * from a day that runs on past midnight — for days that are the run's own
 * anyway. And a name that is not a zone at all reads as the run's too: this is
 * asked wherever a run reads its sites, and one site's mistake must not stop
 * the others. {@link resolveSite} is where that site is refused, alone.
 */
export function siteDayZone(config: AnySiteConfig, timeZone: string): string {
  const zone = config.dayZone === 'utc' ? 'UTC' : config.dayZone;

  if (zone === undefined || zone === 'source' || zone === 'run') {
    return timeZone;
  }

  return !isZone(zone) || sameClock(zone, timeZone) ? timeZone : zone;
}

/** Whether `Intl` knows a name as a zone. */
function isZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });

    return true;
  } catch {
    return false;
  }
}

/**
 * The days a run asks a site for: `days` of them from `startDay`, or — for a
 * site keeping another calendar — the days of that calendar that cover them,
 * so no hour of the run's falls in a day nobody asked for.
 *
 * Less one. A run east of a source's clock reaches a day back for the hours
 * between its midnight and the source's, and once the source's midnight has
 * passed that day is the source's yesterday — which many cannot be asked for,
 * and none needs asking for again. So a run starting today, given `now`, does
 * not ask for a leading day behind the site's own today. One already cached is
 * still read by the merge and kept by a prune; a run asked for the past, with
 * a negative offset, gets every day it covers.
 *
 * The one rule for a site's days, for the grab, for what a server counts and
 * for what a prune keeps alike.
 */
export function siteWindow(
  config: AnySiteConfig,
  startDay: string,
  days: number,
  timeZone: string,
  now?: Date,
): string[] {
  const own = [...dayRange(startDay, days)];
  const zone = siteDayZone(config, timeZone);

  if (zone === timeZone) {
    return own;
  }

  const covering = daysCovering(own, timeZone, zone);
  const leading = covering[0]!;

  return now === undefined ||
    startDay < dayIn(now, timeZone) ||
    own.includes(leading) ||
    leading >= dayIn(now, zone)
    ? covering
    : covering.slice(1);
}

/**
 * The first day a run still needs of any of its sites — `day` on the run's own
 * calendar, or earlier where a site keeping another calendar starts its window
 * the day before, which a prune must not take even once it is no longer asked
 * for.
 */
export function earliestDay(
  sites: readonly AnySiteConfig[],
  day: string,
  timeZone: string,
): string {
  let earliest = day;

  for (const site of sites) {
    const first = siteWindow(site, day, 1, timeZone)[0]!;

    if (first < earliest) {
      earliest = first;
    }
  }

  return earliest;
}

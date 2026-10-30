/**
 * What a run says about itself, as data rather than as a line of text.
 *
 * A run used to be given a `logger` and hand it finished sentences, which meant
 * one level of detail for everybody: a 500-channel fortnight formats fourteen
 * thousand per-channel-day lines, and the only dial was `--quiet`. It also meant
 * the site's name was pasted onto the front of fifteen separate templates, a
 * failure was written once during the run and again differently at the end, and
 * a `parseDay` had nowhere at all to speak.
 *
 * So the run emits these instead, and the deciding — what is worth printing,
 * where it goes, whether it is a line of text or a line of JSON or a counter
 * going up — belongs to whoever is listening. See `reporters.ts` for the ones
 * this package ships.
 *
 * Two rules keep the union worth having:
 *
 * - **Fields, not sentences.** Nothing here holds a formatted string that a
 *   reporter could have assembled itself, and nothing holds a count a reporter
 *   could have kept. The exceptions are named where they are: a count that says
 *   something no per-item event does.
 * - **No site prefix.** `site` is a field. Every reporter that shows a site
 *   decides for itself how, and a single-site grabber can leave it out.
 */

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { errorMessage } from './error.js';

/**
 * How much a reporter is being told, in the order a threshold reads them.
 *
 * Four, and the two in the middle are the ones that earn their place: `warn` is
 * for a signal rather than progress — the distinction `CapabilityContext.warn`
 * already draws for the grabber's interactive half — and `debug` is where the
 * per-channel-day chatter goes so that `info` can be read by a person.
 */
export const LEVELS = ['error', 'warn', 'info', 'debug'] as const;

export type EventLevel = (typeof LEVELS)[number];

/**
 * Which part of a run an event is about — what a JSON consumer filters on.
 *
 * A list rather than a bare union, as {@link LEVELS} is: a test that checks
 * every kind carries a real phase should be checking against the phases, not
 * against a copy of them it has to be remembered to update.
 */
export const PHASES = ['run', 'grab', 'merge', 'serve', 'prune'] as const;

export type RunPhase = (typeof PHASES)[number];

/**
 * How code a config supplies says something — a site's `request` or `parseDay`,
 * a `transform` over the merged guide.
 *
 * Here rather than with the sites because it is not only theirs: a merge
 * transform is the config author's own code and has the same problem, which is
 * that there is no `console` in this package to reach for and a `tv_grab_*`
 * writes its guide to stdout, where one stray line is a broken document.
 */
export interface Says {
  /**
   * Say something about what is being done, wherever the run's own messages go.
   *
   * Progress, so it is shown at the run's default verbosity and hidden when the
   * run is asked to be quiet. Whose it is — the site's name — is added for you.
   */
  log(message: string, data?: SaidFields): void;
  /**
   * The same, for something the reader has to see.
   *
   * A warning is a signal rather than progress: it survives a run asked to
   * report errors only, because "the source moved this channel" is worth
   * hearing even then. Throw instead when the work should also fail.
   */
  warn(message: string, data?: SaidFields): void;
}

/**
 * The fields behind the sentence — `{ page: 3, of: 12 }`.
 *
 * The message is what a person reads; this is what a machine reads, and it is
 * why `--reporter json` is worth pointing at a pipeline: a consumer gets the
 * ids and counts as fields rather than parsing them out of prose. A text
 * reporter appends them with `inspect`, so a `Map`, a `Date` or a cycle shows
 * as itself.
 *
 * It should survive `JSON.stringify`, which is what the JSON reporter has to
 * use. One that cannot is named in place of its value rather than ending a run.
 */
export type SaidFields = Record<string, unknown>;

/**
 * What one channel-day amounts to, as three of these say it.
 *
 * Named because `entry:*` is the only group with a natural key, and a reporter
 * that groups or de-duplicates wants to build it the same way each time.
 */
interface EntryRef {
  site: string;
  channelId: string;
  day: string;
}

/**
 * What a run counts — of a site, and of the whole run.
 *
 * One declaration for both, and for what a `*:done` event carries, so a site's
 * total and the run's cannot describe themselves differently. `GrabSummary` is
 * this shape under the name a run answers with.
 */
export interface GrabCounts {
  /** Channel-days fetched from the network. */
  fetched: number;
  /**
   * Of those, the ones that parsed to no programmes at all — counted here as
   * well as in {@link fetched}, since the request did happen.
   *
   * A day that comes back empty is the one failure a run cannot see: nothing
   * threw, and the entry is cached like any other. It is reported rather than
   * treated as a failure because a channel with nothing on is a legitimate
   * answer; a number that climbs is what says otherwise. `emptyMaxAgeDays`
   * governs how soon such an entry is asked about again.
   */
  empty: number;
  /** Channel-days skipped because the cache was fresh. */
  fromCache: number;
  /**
   * Channel-days the source said were unchanged, so the cached entry stands.
   *
   * Neither fetched nor stale: the request happened and answered `304`, so
   * nothing was written and `grabbedAt` is where it was. The opposite of a
   * missing channel-day, and must not be counted as one.
   */
  unchanged: number;
  /**
   * Channel-days that did not come back — one for each, and nothing else.
   *
   * A count, not a list. It used to be the errors themselves, and it was the
   * one thing a run retained that grew with the size of the guide: a site that
   * is down leaves seven thousand live `Error`s with stacks, against the
   * flat-in-the-size-of-the-guide discipline everything else here keeps.
   *
   * What each of them *was* arrives as an `entry:failed`, `request:failed` or
   * `site:failed` event while it happens. A caller wanting the list keeps one
   * of its own, and gets to decide how long it may grow.
   */
  failed: number;
  /**
   * Sites that answered nothing at all — one for each that could not be read,
   * or whose channel list never arrived.
   *
   * Counted apart from {@link failed} because there is no grid to spread it
   * over: a site that could not be read has no channel list, so the number of
   * channel-days it *would* have covered is not knowable. Adding one to a
   * count of channel-days would make a dead site look like a rounding error
   * next to a guide of thousands — which is the whole difference `allowMissing`
   * turns on, and why no allowance covers this.
   */
  sitesFailed: number;
}

/** Every count at nought — a site's, a run's or a reporter's, before any is counted. */
export function noCounts(): GrabCounts {
  return { fetched: 0, empty: 0, fromCache: 0, unchanged: 0, failed: 0, sitesFailed: 0 };
}

/** A label's requests at nought, before any is counted — see {@link RequestCounts}. */
export function noRequests(): RequestCounts {
  return { requests: 0, requestMs: 0, waitedMs: 0, failed: {} };
}

/**
 * Where a site's `ms` went — `site:done`'s `msBy`. At each moment the site was
 * in the first of these that held, so the parts never overlap and add up to
 * `ms`: a site that took 170 seconds over two requests answered in under one
 * says here what it was doing with the rest.
 */
export interface TimeSpent {
  /**
   * At least one of its requests out, waiting on the source, and none held —
   * once however many were: the wall clock they covered, where `requestMs`
   * adds up each one's own, and is the same only for a site that sends one at
   * a time. A streaming site's pass reading its document is the source's too,
   * where nothing else of the site's holds: its body arriving long after its
   * headers did, and split as it does — the two are one, and not told apart.
   */
  source: number;
  /**
   * Its requests held, the source having said slow down — a `429` or `503` —
   * with one of them outstanding: waiting its turn, or out, which under a
   * hold is one ky retries once the source's `Retry-After` is up, or one sent
   * before it that the hold holds up as much. First of them all, so a site
   * asking one at a time is seen to be held, and not waiting on the source.
   */
  held: number;
  /** None out, and waiting on its own `rateLimit` to let the next one go. */
  rateLimit: number;
  /** Its own work on this machine under way: a `parseDay`, a write to the cache, a check of what is cached. */
  working: number;
  /** None of that under way, and some of it waiting for one of the run's `localConcurrency` slots. */
  queued: number;
  /** None of these: its own code between them, reading what it remembered, its turn's beginning and end. */
  other: number;
}

/** The parts of {@link TimeSpent} a run measures — `other` is what is left of `ms`. */
export type MeasuredTime = Exclude<keyof TimeSpent, 'other'>;

/** Every part of {@link TimeSpent} a run measures — which a moment is given to is `SiteClock`'s to say. */
export const MEASURED_TIME = [
  'source',
  'held',
  'rateLimit',
  'working',
  'queued',
] as const satisfies readonly MeasuredTime[];

/**
 * What kept two programmes from being one — `merge:unmatched`'s `why`.
 *
 * Under the shipped match: `title` — they started near enough, and their
 * titles differ, which `normalizeTitle` decides; `start` — their titles agree,
 * and they start too far apart, which `startToleranceMs` decides; `both`; and
 * `runs` — their titles agree and they start near enough, but further apart
 * than the shorter of them lasts: two programmes in a row, or one within the
 * other, as a segment is within its show. Under the config's own
 * `match`: `matcher` — it said no, for reasons of its own — or, for one with a
 * `windowMs`, `start`: they start beyond it, where it is never asked.
 */
export type NearMissWhy = 'title' | 'start' | 'both' | 'runs' | 'matcher';

/** One side of a `merge:unmatched` pair. */
export interface UnmatchedProgramme {
  /** The site it came from. */
  site: string;
  /** Its title — the first it has. */
  title: string;
  /** Its start, as the guide writes it: `20261024200500 +0200`. */
  start: string;
}

/**
 * What one kind of request cost — a site's, or the run's, under one label of
 * `requestsBy`.
 *
 * A label is what the request was for: a site's `requestLabel` for its planned
 * requests, `'request'` without one; what a `ctx.paced` call names — without a
 * name, `'paced'` from a parse, and from a stream its site's `requestLabel`, or
 * `'stream'` without one; and `'channels'` for the channel list. Named by the
 * site rather than read off a URL, whose ids would make a label of every
 * channel.
 *
 * `requestsBy` lists them in the order each was first sent: a label has a
 * letter in it, so none is put first as a number would be.
 */
export interface RequestCounts {
  /**
   * How many were sent — counted as each one's turn came, so one a cancel
   * dropped before it was not, and one under way when the cancel came was.
   */
  requests: number;
  /**
   * How long they spent waiting on the source, pacing not included: the
   * label's share of `site:done`'s `requestMs`, and nothing like its `ms`,
   * which is the site's wall clock. Each request's own time, added up — four
   * in flight together for a second each are four seconds here, and one
   * second of `msBy.source`.
   */
  requestMs: number;
  /**
   * How long they waited in the site's queue before each was sent: for the
   * source to stop holding them, for its `rateLimit`, or for one of its
   * `concurrency` slots — added up as `requestMs` is. A parse's `paced` calls go
   * ahead of the planned requests, so where both are waiting it is the planned
   * ones whose `waitedMs` grows.
   */
  waitedMs: number;
  /**
   * The ones that failed, by what failed them: the status the source answered
   * with (`'404'`), `'timeout'`, `'network'` where nothing answered, or
   * `'error'` for anything else the request threw — read where it was thrown,
   * so a `404` a site goes on to catch is counted all the same. A request the
   * cancel itself stopped is not counted as failed — what failed before it
   * still is — and a `304` that said a channel-day is unchanged is an answer.
   */
  failed: Record<string, number>;
}

/**
 * What an emitter says: the type, and the fields that type carries.
 *
 * `level` and `phase` are not here because they follow from the type — see
 * {@link EVENT_KINDS} — so the run says what happened and nothing has to
 * remember how loudly.
 */
export type EpgEventInput =
  // ── the run as a whole ───────────────────────────────────────────────────
  /**
   * Interrupted. `fetched` is what reached the cache before it stopped.
   *
   * An error rather than a warning, because it is the run's *outcome*: no guide
   * was written, and a command asked to report errors only still has to say so.
   */
  | { type: 'run:cancelled'; fetched?: number }
  // ── grabbing ─────────────────────────────────────────────────────────────
  /**
   * The run is over, with what it fetched and how busy the loop was.
   *
   * `loopMaxMs` is the longest the event loop went unserved. It is here
   * because of what it explains: `parseDay` is the site's own code running on
   * the main thread, and while one works through a big document in a single
   * synchronous call nothing else can read a socket — so *every other site's*
   * requests are measured as slow, and the numbers point at the sources rather
   * than at the parse. A run whose worst figure is seconds is a run whose
   * request times mean something else than they appear to.
   *
   * A stall, not a load: a document parsed as it streams yields between
   * chunks, and keeps this in the tens of milliseconds however busy it keeps
   * the thread.
   */
  | ({
      type: 'grab:done';
      loopMaxMs: number;
      /** Every request of the run, by {@link RequestCounts} label. */
      requestsBy: Record<string, RequestCounts>;
    } & GrabCounts)
  /**
   * What this site is about to do, which the planner has just worked out.
   *
   * The one event that makes a run's shape known before it happens: a progress
   * line has no totals without it, and at `info` it is what says a site is
   * being worked on at all.
   *
   * `entries` is the channel-days that will actually be fetched, and it is the
   * one to measure against: `requests` is how they were grouped, which for a
   * whole-document source is *one* however many channel-days come out of it.
   * The channel-days already fresh in the cache are not in either — they were
   * counted before this, which is how the sweep discovers them.
   *
   * `dayZone` is there only for a site whose days are on a calendar other than
   * the run's — `UTC` for a source keyed by UTC date — and then `days` counts
   * that calendar's: the ones covering the run's window, which is one more at
   * an edge.
   */
  | {
      type: 'site:started';
      site: string;
      channels: number;
      days: number;
      dayZone?: string;
      entries: number;
      requests: number;
    }
  /**
   * The site is finished, with what it fetched and what it cost.
   *
   * The cost is three numbers because they answer three questions and are
   * routinely confused: `requests` is how many times the source was asked —
   * every slot the site's queue gave out, a `ctx.paced` fetch inside a parse
   * included; `ms` is how long the site took, which is the one a nightly run is
   * long by; and `requestMs` is how long those requests spent waiting on the
   * source, which is less than `ms` where a site waits on its own pacing, and
   * more than it where a site runs several at once.
   *
   * `requestsBy` is `requests` and `requestMs` again, by what each request was
   * for, with what failed them — see {@link RequestCounts}. "5291 requests"
   * does not say that 3,242 of them were detail calls answered `404`.
   *
   * `msBy` is `ms` again, by what the site was doing — see {@link TimeSpent}.
   * A site whose `ms` is far above what its requests explain was waiting on
   * something else, and this says which.
   */
  | ({
      type: 'site:done';
      site: string;
      requests: number;
      ms: number;
      requestMs: number;
      requestsBy: Record<string, RequestCounts>;
      msBy: TimeSpent;
    } & GrabCounts)
  /** The site could not be read or run at all, so none of it was grabbed. */
  | { type: 'site:failed'; site: string; error: unknown }
  /** The site's own code, saying something — `ctx.log`. */
  | { type: 'site:note'; site: string; message: string; data?: Record<string, unknown> }
  /** The site's own code, saying something that matters — `ctx.warn`. */
  | { type: 'site:warning'; site: string; message: string; data?: Record<string, unknown> }
  // ── one channel-day ──────────────────────────────────────────────────────
  /** Fresh in the cache, so it was never asked for. */
  | ({ type: 'entry:cached' } & EntryRef)
  | ({ type: 'entry:fetched'; programmes: number } & EntryRef)
  /** Said a second time by a document not grouped by channel, and added to. */
  | ({ type: 'entry:appended'; added: number; total: number } & EntryRef)
  /** The source says what is cached still stands. */
  | ({ type: 'entry:unchanged' } & EntryRef)
  | ({ type: 'entry:failed'; error: unknown } & EntryRef)
  // ── one request ──────────────────────────────────────────────────────────
  /**
   * A request is about to go out, over these channels and days.
   *
   * The pair with {@link EpgEventInput} `request:done` is the only place a run
   * says what a request *cost*: pacing could report that concurrency moved and
   * never what moving it bought.
   */
  | { type: 'request:started'; site: string; channels: string[]; days: string[] }
  /** It came back. `ms` is wall time, the queue wait not included. */
  | { type: 'request:done'; site: string; channels: string[]; days: string[]; ms: number }
  /**
   * A request failed, and took every channel-day it covered with it.
   *
   * `entries` is the count that has to be here: it is the difference between
   * one line about a site that is down and seven thousand of them, and no
   * `entry:failed` is emitted for these — that would be the same seven thousand
   * by another route.
   */
  | {
      type: 'request:failed';
      site: string;
      channels: string[];
      days: string[];
      entries: number;
      error: unknown;
    }
  // ── what a whole-document source noticed ─────────────────────────────────
  //
  // A parser warning and a document that turned out not to be grouped are
  // *site* observations, and a site has `ctx.log`/`ctx.warn` and no structured
  // channel of its own — deliberately, since the alternative is letting site
  // code emit any event it likes. So those two arrive as `site:warning`, and
  // what is here is only what the run itself knows.
  /**
   * Channel-days the document never mentioned, now cached empty.
   *
   * A count rather than one event each, because what it says is not "these have
   * nothing on" — that is `entry:fetched` with none — but "the source has been
   * through its whole answer and these were not in it", which is usually a
   * channel list that has moved on.
   */
  | { type: 'stream:gaps'; site: string; count: number }
  /** Emissions nobody asked about. Diagnostic only; a count is plenty. */
  | { type: 'stream:ignored'; site: string; count: number }
  // ── pacing ───────────────────────────────────────────────────────────────
  /**
   * Told to slow down, and holding every request for `ms`. `retryAfterMs` is
   * how long the source's `Retry-After` asked for, before `backoff.maxMs` had
   * its say — absent where it sent none, and `ms` is then `backoff.fallbackMs`,
   * or `backoff.maxMs` where that is the less. `lengthened` where it is not a
   * hold begun but one already holding, made to end later by another response
   * that asked for longer.
   */
  | {
      type: 'pacing:held';
      site: string;
      status: number;
      ms: number;
      retryAfterMs?: number;
      lengthened?: true;
    }
  | { type: 'pacing:slowed'; site: string; concurrency: number }
  | { type: 'pacing:recovered'; site: string; concurrency: number }
  | { type: 'pacing:rateLimit'; site: string; waiting: boolean }
  // ── merging, and tidying up ──────────────────────────────────────────────
  | { type: 'merge:channel'; channelId: string }
  /**
   * Two programmes from different sources that nearly merged, and did not:
   * one that joined nothing, and the nearest unmatched one already there,
   * within half an hour, from another source — one before it in the merge, or
   * one whose programme was held over from the day before, whatever its place.
   * Each of what `merge:summary` counts as a
   * near miss — at `debug`, since a guide whose sources run on two grids has
   * thousands. `--explain unmatched`, on `epg merge` or `epg build`, lists
   * them all, and what would join them.
   */
  | {
      type: 'merge:unmatched';
      channelId: string;
      /**
       * How much later `programme` starts than `nearby` — below nought where it
       * starts earlier — so which of two sources runs behind is read off it,
       * not worked out again from the starts as written.
       */
      shiftMs: number;
      /** What kept them apart — see {@link NearMissWhy}. */
      why: NearMissWhy;
      /** The one that joined nothing. */
      programme: UnmatchedProgramme;
      /** The unmatched one already there, nearest it. */
      nearby: UnmatchedProgramme;
    }
  /**
   * What the merge made of the sources, once the whole guide is out.
   *
   * Apart from `merge:done`, which says where a file went: this says how well
   * the sources agreed, and is emitted wherever a guide is built — `epg build`
   * and a served guide included, neither of which writes a file the other
   * event could name.
   *
   * It exists because two of this package's quietest failures look like
   * success. A source whose starts are on a different grid merges into
   * nothing, and the guide then carries every programme twice; a cleanup
   * option dropping more than it should leaves a guide that is simply thinner.
   * Both are invisible in a count of programmes and obvious in these.
   */
  | {
      type: 'merge:summary';
      /**
       * Programmes one source joined to another's already there — not to its
       * own, held over from the day before and said again.
       */
      combined: number;
      /**
       * Programmes that joined nothing, with another source's within half an
       * hour left unjoined too — each one a `merge:unmatched`.
       */
      nearMiss: number;
      /** A few of them, in full — a count alone says nothing about why. */
      examples: {
        channelId: string;
        gapMs: number;
        title: string;
        nearby: string;
      }[];
      /** Dropped as a container around programmes published beside it. */
      containers: number;
      /** Given an earlier `stop` because they ran into the next programme. */
      clipped: number;
    }
  | { type: 'merge:done'; output: string }
  /**
   * A `merge.transform` saying something, and the reason these two exist apart
   * from `site:note`: the code is the config's own rather than any site's, so
   * there is no site to put on it.
   */
  | { type: 'merge:note'; message: string; data?: SaidFields }
  | { type: 'merge:warning'; message: string; data?: SaidFields }
  | { type: 'prune:done'; removed: number; before: string }
  /** The server is listening, and this is where. */
  | { type: 'serve:started'; url: string }
  /**
   * One answered request.
   *
   * `status` is the whole of what happened — a `304` is the poll that cost
   * nothing, which is what the conditional GET exists for, and telling the two
   * apart in a log is how anyone knows it is working. `ms` is from the request
   * arriving to the response being finished, so a streamed guide's time is the
   * time it took to reach the consumer.
   */
  | { type: 'serve:response'; method: string; path: string; status: number; ms: number }
  /**
   * A consumer that hung up part way through a guide.
   *
   * Its own kind rather than a failure, because it is not one: a reader that
   * has seen enough, a proxy that timed out, a browser tab closed. Reporting it
   * as an error is how a log fills with alarms about the normal.
   */
  | { type: 'serve:disconnected'; path: string; ms: number }
  /** A request that could not be answered — the merge threw, or worse. */
  | { type: 'serve:failed'; path: string; error: unknown }
  /**
   * A scheduled grab that threw.
   *
   * Distinct from `site:failed`, which is one site of a run that otherwise
   * finished. This is the run never happening at all — a config factory that
   * could not get a token, a cache that would not open — and without it a
   * scheduler would have nowhere to say so, since a grab reports its own site
   * failures as counts and returns normally.
   */
  | { type: 'serve:grabFailed'; error: unknown }
  /**
   * The channel lists will be resolved again on the next request.
   *
   * Said rather than done, because that is what `reload` does — it marks, and
   * the next request pays. Its use to a consumer is as a signal of its own: an
   * app sharing this server's `SIGHUP` reloads whatever it keeps beside the
   * guide when this arrives, instead of adding a second handler for the same
   * signal.
   */
  | { type: 'serve:reloaded' }
  | { type: 'serve:stopped' };

export type EpgEventType = EpgEventInput['type'];

/** How loudly a type speaks, and which half of a run it is about. */
export interface EventKind {
  level: EventLevel;
  phase: RunPhase;
}

/**
 * The level and phase of every type, in one place.
 *
 * A table rather than a field on each member, for two reasons. An emitter says
 * what happened and should not also be choosing how loudly — twenty-odd call
 * sites each repeating `level: 'debug'` is twenty-odd chances to disagree. And
 * the policy is then reviewable as policy: this is the whole answer to "what
 * does the default level show?", and changing what a run says by default is
 * editing one column.
 *
 * `satisfies` rather than an annotation, so a type added to
 * {@link EpgEventInput} without a row here fails to compile.
 */
export const EVENT_KINDS = {
  'run:cancelled': { level: 'error', phase: 'run' },
  'grab:done': { level: 'info', phase: 'grab' },
  'site:started': { level: 'info', phase: 'grab' },
  'site:done': { level: 'info', phase: 'grab' },
  'site:failed': { level: 'error', phase: 'grab' },
  'site:note': { level: 'info', phase: 'grab' },
  'site:warning': { level: 'warn', phase: 'grab' },
  'entry:cached': { level: 'debug', phase: 'grab' },
  'entry:fetched': { level: 'debug', phase: 'grab' },
  'entry:appended': { level: 'debug', phase: 'grab' },
  'entry:unchanged': { level: 'debug', phase: 'grab' },
  'entry:failed': { level: 'error', phase: 'grab' },
  'request:started': { level: 'debug', phase: 'grab' },
  'request:done': { level: 'debug', phase: 'grab' },
  'request:failed': { level: 'error', phase: 'grab' },
  'stream:gaps': { level: 'warn', phase: 'grab' },
  'stream:ignored': { level: 'debug', phase: 'grab' },
  'pacing:held': { level: 'warn', phase: 'grab' },
  'pacing:slowed': { level: 'warn', phase: 'grab' },
  'pacing:recovered': { level: 'info', phase: 'grab' },
  'pacing:rateLimit': { level: 'debug', phase: 'grab' },
  'merge:channel': { level: 'debug', phase: 'merge' },
  'merge:unmatched': { level: 'debug', phase: 'merge' },
  'merge:summary': { level: 'info', phase: 'merge' },
  'merge:done': { level: 'info', phase: 'merge' },
  'merge:note': { level: 'info', phase: 'merge' },
  'merge:warning': { level: 'warn', phase: 'merge' },
  'prune:done': { level: 'info', phase: 'prune' },
  'serve:started': { level: 'info', phase: 'serve' },
  'serve:response': { level: 'debug', phase: 'serve' },
  'serve:disconnected': { level: 'debug', phase: 'serve' },
  'serve:failed': { level: 'error', phase: 'serve' },
  'serve:grabFailed': { level: 'error', phase: 'serve' },
  'serve:reloaded': { level: 'info', phase: 'serve' },
  'serve:stopped': { level: 'info', phase: 'serve' },
} as const satisfies Record<EpgEventType, EventKind>;

/** Every kind of event, as {@link EVENT_KINDS} lists them. */
export const EVENT_TYPES = Object.keys(EVENT_KINDS) as EpgEventType[];

/** Every kind, as a set — what a reporter that did not say wants. */
const EVERY_KIND: ReadonlySet<EpgEventType> = new Set(EVENT_TYPES);

/**
 * What a reporter is given: what happened, and how loudly.
 *
 * An intersection over the union, so narrowing on `type` still works and every
 * member gains the two stamped fields without any of them saying so.
 */
export type EpgEvent = EpgEventInput & EventKind;

/**
 * Every event by name, for typing an `EventEmitter` a run reports into.
 *
 * ```ts
 * const events = new EventEmitter<EpgEventMap>();
 *
 * events.on('serve:started', (event) => console.log(event.url));
 * ```
 *
 * Node's `EventEmitter` takes a map like this as its type parameter, which is
 * what makes a listener's argument the event it is for rather than `any` —
 * see {@link emitterReporter}.
 */
export type EpgEventMap = {
  [T in EpgEventType]: [event: Extract<EpgEvent, { type: T }>];
};

/**
 * Told what happened, as it happens.
 *
 * Synchronous on purpose, as the `logger` it replaces was: a grab must not wait
 * on a sink, and both commands end by draining what they queued rather than
 * awaiting each line — see `streams.ts`. A reporter that wants to do something
 * slow should queue it and be drained by whatever owns it.
 *
 * `wants` says which kinds of event it does anything with — what its level
 * shows, or what it counts — so that a run need not make an event nobody will
 * read: what it makes often, an `entry:fetched` a channel-day or a
 * `merge:unmatched` a programme, is made only where a reporter wants it.
 * Without one, a reporter wants every kind, as a sink of one's own is told
 * everything. Asked of each kind once, the first time a run asks — see
 * {@link stamped} — and never trusted to filter: a reporter is still handed
 * whatever is made.
 */
export type Reporter = ((event: EpgEvent) => void) & {
  wants?: (type: EpgEventType) => boolean;
};

/**
 * What the run says, before it is stamped — and `hears`, the kinds of event
 * its reporters want, as they said it the first time the run asked: every
 * kind, where they did not say. What a run makes often, it makes only where `hears` has
 * it. One set, whether the run is here or a site's thread. Made by
 * {@link emitter}.
 */
export type Emit = ((event: EpgEventInput) => void) & {
  readonly hears: ReadonlySet<EpgEventType>;
};

/**
 * An {@link Emit}: what it says events with, and `hears` — the set itself, or
 * what answers it as it is asked, for one taken the first time it is, or that
 * is another's. The one way one is made, so a set asked for later is asked
 * for the same way wherever it is.
 */
export function emitOf(
  say: (event: EpgEventInput) => void,
  hears: ReadonlySet<EpgEventType> | (() => ReadonlySet<EpgEventType>),
): Emit {
  return Object.defineProperty(
    say,
    'hears',
    typeof hears === 'function' ? { get: hears } : { value: hears },
  ) as Emit;
}

/**
 * Stamp what an emitter said, and pass it on.
 *
 * The cast is the one this file needs and cannot avoid: spreading a table entry
 * looked up by a union-typed key gives TypeScript the union of every row, which
 * is exactly right at runtime and not something it can tie back to the member
 * the type came from.
 */
export function stamped(reporter: Reporter): Emit {
  let hears: ReadonlySet<EpgEventType> | undefined;

  return emitOf(
    (event) => reporter({ ...event, ...EVENT_KINDS[event.type] } as EpgEvent),
    // What it wants, asked of each kind once, the first time the run asks —
    // never before its first wait, so a listener added as it is started is
    // asked about too — and held to from then on. Asked of the reporter, as
    // its own: a `wants` that reads `this` reads it.
    () =>
      (hears ??=
        reporter.wants === undefined
          ? EVERY_KIND
          : new Set(EVENT_TYPES.filter((type) => reporter.wants!(type)))),
  );
}

/** How often the loop is sampled — see {@link watchEventLoop}. */
const RESOLUTION_MS = 10;

/**
 * How long the event loop went unserved, watched for the length of a run.
 *
 * A `parseDay` is the site's own code on the main thread: while one works
 * through a big document without yielding, nothing else runs, including the
 * reads that finish other sites' requests. Without this the only sign is every
 * source looking slow at once, which reads as a network problem and is not one.
 *
 * `monitorEventLoopDelay` is a libuv timer at 10ms resolution — cheap enough
 * to leave on, and the only way to tell "the sources were slow" from "we never
 * got round to listening".
 */
export async function watchEventLoop(): Promise<{
  worst: () => Promise<number>;
  stop: () => void;
}> {
  const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });

  histogram.enable();

  // Until the monitor has sampled once. It records the gap between one sample
  // and the next, so a block before its first sample is not a gap it ever sees
  // — and a run's first parse can start at once, when a site's request
  // answers without waiting: 4.8s of parsing then read as 13ms.
  await new Promise((resolve) => {
    setTimeout(resolve, RESOLUTION_MS * 2);
  });

  return {
    /**
     * The longest delay seen, in milliseconds — the histogram counts in
     * nanoseconds and nobody reads one.
     *
     * After a timer rather than an immediate, which is the difference between
     * reading the block and missing it: the monitor is a libuv timer, timers
     * run before the check phase an immediate belongs to, and a caller asking
     * straight after a long block would be asking before the monitor had had
     * its turn. Twice the resolution is one sample's worth of waiting at the
     * end of a run that took minutes.
     *
     * `0` on a run too short to have been sampled at all, which is honest:
     * nothing was kept waiting.
     */
    worst: async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, RESOLUTION_MS * 2);
      });

      return Math.round(histogram.max / 1e6);
    },
    stop: () => histogram.disable(),
  };
}

/** A run nobody is listening to. */
export const silent: Emit = emitOf(() => {}, new Set());

/** What a caller says when asked where the events go. */
export interface ReportedOptions {
  reporter?: Reporter;
}

/**
 * Where a run's events go — nowhere, when nobody is listening.
 *
 * Here rather than beside the reporters, though that is where it reads as
 * belonging: `grab` needs it, and importing it from `reporters.ts` made the
 * `epg-tools/grabber` entry point pull in the text, JSON and progress
 * renderers, and `node:stream` with them, for three lines.
 */
export function emitter(options: ReportedOptions): Emit {
  return options.reporter === undefined ? silent : stamped(options.reporter);
}

/** How many kinds of what a reporter threw are kept — see {@link keepingThrows}. */
const KEPT_KINDS = 10;

/** One kind of what a reporter threw — see {@link ReporterError}. */
export interface ReporterThrow {
  /** The first of its kind, as the reporter threw it. */
  error: unknown;
  /** How many times it was thrown. */
  times: number;
  /** At which events, and how many times at each. */
  at: Partial<Record<EpgEventType, number>>;
}

/**
 * What a run rejects with when its reporter threw — once the run is done, and
 * has said everything it did.
 *
 * `errors` is what was thrown, each kind once — a name and a message make a
 * kind — and `thrown` how often each was, and at which events: a broken
 * reporter throws at every event, and a run says tens of thousands. No more
 * than ten kinds are kept, and what is past them is counted in `untracked`.
 */
export class ReporterError extends AggregateError {
  override readonly name = 'ReporterError';
  /** Each kind thrown, in the order each was first. */
  readonly thrown: readonly ReporterThrow[];
  /** Throws of kinds past the ten kept, counted and no more. */
  readonly untracked: number;

  constructor(thrown: readonly ReporterThrow[], untracked = 0) {
    const times = thrown.reduce((sum, kind) => sum + kind.times, untracked);
    const kinds = thrown.map(
      (kind) =>
        `${kindOf(kind.error)} (${Object.entries(kind.at)
          .map(([type, n]) => `${n} × at ${type}`)
          .join(', ')})`,
    );

    super(
      thrown.map((kind) => kind.error),
      `The reporter threw ${times} ${times === 1 ? 'time' : 'times'}: ${kinds.join('; ')}` +
        (untracked > 0 ? `; and ${untracked} more of other kinds` : ''),
    );
    this.thrown = thrown;
    this.untracked = untracked;
  }
}

/**
 * What a run rejects with when it failed of itself, and its reporter threw as
 * well: both, so neither is lost. An `AggregateError` of the two, in that
 * order — `error`, what the run would have rejected with had its reporter not
 * thrown, and `reporter`, what the reporter threw beside it.
 */
export class RunFailedError extends AggregateError {
  override readonly name = 'RunFailedError';
  /** The run's own failure. */
  readonly error: unknown;
  /** What its reporter threw, beside it. */
  readonly reporter: ReporterError;

  constructor(error: unknown, reporter: ReporterError) {
    super([error, reporter], `${errorMessage(error)} — and the reporter threw as well`);
    this.error = error;
    this.reporter = reporter;
  }
}

/** What makes two things a reporter threw one kind: a name, and a message. */
function kindOf(error: unknown): string {
  let name: string;

  try {
    name = error instanceof Error ? error.name : typeof error;
  } catch {
    // Something that cannot even be asked what it is — a revoked proxy.
    name = 'something unreadable';
  }

  return `${name}: ${errorMessage(error)}`;
}

/** A reporter's throws, kept — see {@link keepingThrows}. */
export interface KeptThrows<T> {
  /** The options, reporting through the reporter that keeps them. */
  options: T;
  /** Throw what has been kept so far, as a {@link ReporterError} — if anything has. */
  rethrow(): void;
  /**
   * `running`, once settled — and with it, what was kept: alone where it
   * resolved, and beside its own error where it rejected, so neither is lost.
   * Nothing is said after: what reported through these is done, and an event
   * from work it left behind is told to nobody.
   */
  settle<R>(running: Promise<R>): Promise<R>;
}

/**
 * `options` reporting through a reporter whose throws are kept rather than let
 * loose, and thrown as a {@link ReporterError} once whatever reported through
 * it is done. So a sink that cannot keep up neither ends what it is told about
 * part way — a site half said, or the process, from a listener nothing
 * catches — nor is swallowed. What a grab reports through, and a run around
 * one.
 */
export function keepingThrows<T extends ReportedOptions>(options: T): KeptThrows<T> {
  const { reporter } = options;

  // Kept already, by a run around this one, which throws what it keeps once
  // it is done itself: not kept twice.
  if (reporter !== undefined && keeping.has(reporter)) {
    return { options, rethrow() {}, settle: (running) => running };
  }

  const kinds = new Map<string, ReporterThrow>();
  let untracked = 0;
  let over = false;
  /** What {@link rethrow} threw, last — see `settle`. */
  let thrown: ReporterError | undefined;

  /** What has been kept so far, as it stands now: what is counted after is not in it. */
  const kept = (): ReporterError =>
    new ReporterError(
      [...kinds.values()].map((kind) => ({ ...kind, at: { ...kind.at } })),
      untracked,
    );
  const rethrow = (): void => {
    if (kinds.size > 0) {
      thrown = kept();
      throw thrown;
    }
  };
  /** Keep `error`, thrown — or rejected with — at `event`. */
  const keep = (error: unknown, event: EpgEvent): void => {
    if (over) {
      return;
    }

    const kind = kindOf(error);
    let known = kinds.get(kind);

    if (known === undefined) {
      if (kinds.size === KEPT_KINDS) {
        untracked++;

        return;
      }

      known = { error, times: 0, at: {} };
      kinds.set(kind, known);
    }

    known.times++;
    known.at[event.type] = (known.at[event.type] ?? 0) + 1;
  };

  if (reporter === undefined) {
    return { options, rethrow, settle: (running) => running };
  }

  const keepingReporter: Reporter = (event) => {
    if (over) {
      return;
    }

    try {
      const returned: unknown = reporter(event);

      // Synchronous, as a reporter is — but one written `async` is not
      // refused by its type, and what it rejects with is kept as a throw is,
      // rather than left to end the process. Kept while what reported through
      // this is going: nothing waits on a reporter, so one that rejects after
      // the run has answered is let go of.
      if (isThenable(returned)) {
        returned.then(undefined, (error: unknown) => {
          keep(error, event);
        });
      }
    } catch (error) {
      keep(error, event);
    }
  };

  // Asked as the reporter is told, and what it throws kept as what that
  // throws is: a reporter that cannot say what it wants is given everything.
  if (reporter.wants !== undefined) {
    keepingReporter.wants = (type) => {
      try {
        return reporter.wants!(type);
      } catch (error) {
        keep(error, { type } as EpgEvent);

        return true;
      }
    };
  }

  keeping.add(keepingReporter);

  return {
    options: { ...options, reporter: keepingReporter },
    rethrow,
    async settle(running) {
      let done: Awaited<typeof running>;

      try {
        done = await running;
      } catch (error) {
        over = true;

        if (kinds.size === 0) {
          throw error;
        }

        // Thrown already, on the way out — as it stands now, then, with
        // what was kept since.
        if (error === thrown) {
          throw kept();
        }

        throw new RunFailedError(error, kept());
      }

      over = true;
      rethrow();

      return done;
    },
  };
}

/**
 * Throw what reporters joined together threw: one as it is, several together.
 * What each threw, and nothing of the event: the same reporters failing the
 * same way at every event are one failure, and failing another way another —
 * which is how {@link keepingThrows} keeps them.
 */
function throwAll(threw: unknown[]): void {
  if (threw.length === 1) {
    throw threw[0];
  }

  if (threw.length > 1) {
    throw new AggregateError(
      threw,
      `${threw.length} reporters threw: ${threw.map(kindOf).join('; ')}`,
    );
  }
}

/** Every reporter {@link keepingThrows} made: one handed it again is kept already. */
const keeping = new WeakSet<Reporter>();

/** Whether `value` is a promise, or anything awaited as one. */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * The options a run reports through, with the config's own emitter — or
 * reporter — added.
 *
 * `reporter` is how a run talks to whoever started it, and a library caller
 * passes its own. `events` is what the *program* asked to be told, and it is
 * in the config because that is where a program says it — so every way of
 * starting a run honours it, not only the command that happens to read the
 * config file. A reporter there is joined as it is: one that says what it
 * wants, which an emitter given alone could not.
 */
export function reportingTo<T extends ReportedOptions>(
  options: T,
  events: EpgEventSink | Reporter | undefined,
): T {
  if (events === undefined) {
    return options;
  }

  return {
    ...options,
    reporter: combineReporters(
      options.reporter,
      typeof events === 'function' ? events : emitterReporter(events),
    ),
  };
}

/**
 * What {@link emitterReporter} needs of an emitter — Node's own fits, and so
 * does anything with an `emit` taking a name and a value. One that can say how
 * many listen for a kind is asked, so a run need not make what none hears.
 */
export interface EpgEventSink {
  emit(type: EpgEvent['type'], event: EpgEvent): unknown;
  listenerCount?(type: EpgEvent['type']): number;
}

/** How {@link emitterReporter} says what its emitter hears. */
export interface EmitterReporterOptions {
  /**
   * The kinds the emitter hears, asked of each once a run asks — for one
   * whose listeners are not all that hear: an `emit` of its own that passes
   * every event on, or a listener for any kind. By default, the kinds something
   * listens for, where the emitter can say how many do, and otherwise every
   * kind.
   */
  wants?: (type: EpgEventType) => boolean;
}

/**
 * Every event, re-emitted on an `EventEmitter` under its own type.
 *
 * For a long-lived process where several things care about different events: a
 * readiness ping, a reload, a metric. Each subscribes to the one it is about,
 * instead of one `switch` in a reporter growing a case per concern.
 *
 * ```ts
 * const events = new EventEmitter<EpgEventMap>();
 *
 * events.on('serve:started', () => process.send?.('ready'));
 * events.on('serve:reloaded', () => void reloadMyOwnThings());
 *
 * serveGuide(config, { reporter: emitterReporter(events) });
 * ```
 *
 * Typing the emitter with {@link EpgEventMap} is what makes each listener's
 * argument the event it asked for. Nothing is filtered: an emitter with no
 * listener for a type is the cheapest sink there is — and, asked by its
 * `listenerCount`, one a run need not make that event for at all. One that
 * hears more than its listeners do says so with `options.wants`:
 *
 * ```ts
 * emitterReporter(bridge, { wants: () => true });
 * ```
 */
export function emitterReporter(
  events: EpgEventSink,
  options: EmitterReporterOptions = {},
): Reporter {
  const reporter: Reporter = (event) => {
    events.emit(event.type, event);
  };

  // Asked once a run first asks: a listener added part way through one hears
  // the next.
  if (options.wants !== undefined) {
    reporter.wants = (type) => options.wants!(type);
  } else if (events.listenerCount !== undefined) {
    reporter.wants = (type) => events.listenerCount!(type) > 0;
  }

  return reporter;
}

/**
 * Several reporters as one, each given every event in the order written.
 *
 * What a process with more than one interest reaches for — lines for a log and
 * an emitter for the app, without writing the two-line function that calls
 * both. `undefined` is skipped, so a caller's own optional reporter composes
 * without a conditional:
 *
 * ```ts
 * reporter: combineReporters(options.reporter, loggerReporter({ logger })),
 * ```
 *
 * A reporter that throws is not swallowed here: a sink that cannot keep up with
 * a run is a bug in the sink, and swallowing it would leave a run reporting
 * into silence with nothing said. The others are told all the same — one
 * sink's bug is not another's silence — and what was thrown is thrown once
 * they have been: one as it is, several together. A grab keeps the first, says
 * the rest of the run, and rejects with it once it is done.
 */
export function combineReporters(...reporters: (Reporter | undefined)[]): Reporter {
  const listening = reporters.filter((reporter) => reporter !== undefined);

  // The common cases without a wrapper: one reporter is itself, and none at
  // all is the same silence `emitter` gives a run nobody is listening to.
  if (listening.length === 1) {
    return listening[0]!;
  }

  const combined = (event: EpgEvent): Promise<unknown> | undefined => {
    let threw: unknown[] | undefined;
    let pending: Array<PromiseLike<unknown>> | undefined;

    for (const reporter of listening) {
      try {
        const returned: unknown = reporter(event);

        if (isThenable(returned)) {
          (pending ??= []).push(returned);
        }
      } catch (error) {
        (threw ??= []).push(error);
      }
    }

    // What was thrown, thrown now, as a reporter's throw is: never held back
    // behind what one written `async` is still doing. What those reject with
    // at this event is then let go of — the throw is what is said of it.
    if (threw !== undefined) {
      for (const one of pending ?? []) {
        one.then(undefined, () => {});
      }

      throwAll(threw);
    }

    // Otherwise handed on — one as it is, several waited for together — for
    // whoever keeps what reporters throw to keep what they reject with, all of
    // it. One, as most are: nothing made for it at every event.
    if (pending === undefined || pending.length === 1) {
      return pending?.[0] as Promise<unknown> | undefined;
    }

    return Promise.allSettled(pending).then((settled) => {
      throwAll(settled.flatMap((one) => (one.status === 'rejected' ? [one.reason] : [])));
    });
  };

  // Wanted by any of them — every kind by one that did not say, and none by
  // none at all. Asked only until one wants it: the rest are given it then
  // whatever they would say. One that throws is thrown through, to what keeps
  // a run's throws — which takes it for one that wants it, as one is given
  // everything — so it is asked no further either.
  return Object.assign(combined, {
    wants: (type: EpgEventType) => {
      for (const reporter of listening) {
        if (reporter.wants?.(type) ?? true) {
          return true;
        }
      }

      return false;
    },
  });
}

/**
 * Whether an event at `level` is worth showing to someone asking for `threshold`.
 *
 * Filtering is a *reporter's* job and happens nowhere else: a sink of one's own
 * — counting types, shipping metrics — is told everything, which is what makes
 * it worth writing. Every reporter this package ships takes a `level` and uses
 * this.
 */
export function atLevel(level: EventLevel, threshold: EventLevel): boolean {
  return LEVELS.indexOf(level) <= LEVELS.indexOf(threshold);
}

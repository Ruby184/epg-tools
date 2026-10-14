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
  | ({ type: 'grab:done' } & GrabCounts)
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
   */
  | {
      type: 'site:started';
      site: string;
      channels: number;
      days: number;
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
   */
  | ({
      type: 'site:done';
      site: string;
      requests: number;
      ms: number;
      requestMs: number;
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
  /** Told to slow down, and holding every request for `ms`. */
  | { type: 'pacing:held'; site: string; status: number; ms: number }
  | { type: 'pacing:slowed'; site: string; concurrency: number }
  | { type: 'pacing:recovered'; site: string; concurrency: number }
  | { type: 'pacing:rateLimit'; site: string; waiting: boolean }
  // ── merging, and tidying up ──────────────────────────────────────────────
  | { type: 'merge:channel'; channelId: string }
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
      /** Programmes a later source joined to one already there. */
      combined: number;
      /** Programmes that joined nothing, with something close by. */
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
 */
export type Reporter = (event: EpgEvent) => void;

/** What the run says, before it is stamped. */
export type Emit = (event: EpgEventInput) => void;

/**
 * Stamp what an emitter said, and pass it on.
 *
 * The cast is the one this file needs and cannot avoid: spreading a table entry
 * looked up by a union-typed key gives TypeScript the union of every row, which
 * is exactly right at runtime and not something it can tie back to the member
 * the type came from.
 */
export function stamped(reporter: Reporter): Emit {
  return (event) => reporter({ ...event, ...EVENT_KINDS[event.type] } as EpgEvent);
}

/** A run nobody is listening to. */
export const silent: Emit = () => {};

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

/**
 * The options a run reports through, with the config's own emitter added.
 *
 * `reporter` is how a run talks to whoever started it, and a library caller
 * passes its own. `events` is what the *program* asked to be told, and it is
 * in the config because that is where a program says it — so every way of
 * starting a run honours it, not only the command that happens to read the
 * config file.
 */
export function reportingTo<T extends ReportedOptions>(
  options: T,
  events: EpgEventSink | undefined,
): T {
  if (events === undefined) {
    return options;
  }

  return { ...options, reporter: combineReporters(options.reporter, emitterReporter(events)) };
}

/**
 * What {@link emitterReporter} needs of an emitter — Node's own fits, and so
 * does anything with an `emit` taking a name and a value.
 */
export interface EpgEventSink {
  emit(type: EpgEvent['type'], event: EpgEvent): unknown;
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
 * listener for a type is the cheapest sink there is.
 */
export function emitterReporter(events: EpgEventSink): Reporter {
  return (event) => {
    events.emit(event.type, event);
  };
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
 * A reporter that throws is not caught here, as it is not caught anywhere
 * else: a sink that cannot keep up with a run is a bug in the sink, and
 * swallowing it would leave a run reporting into silence with nothing said.
 */
export function combineReporters(...reporters: (Reporter | undefined)[]): Reporter {
  const listening = reporters.filter((reporter) => reporter !== undefined);

  // The common cases without a wrapper: one reporter is itself, and none at
  // all is the same silence `emitter` gives a run nobody is listening to.
  if (listening.length === 1) {
    return listening[0]!;
  }

  return (event) => {
    for (const reporter of listening) {
      reporter(event);
    }
  };
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

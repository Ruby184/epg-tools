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

/** Which half of a run an event is about — what a JSON consumer filters on. */
export type RunPhase = 'run' | 'grab' | 'merge' | 'prune';

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

/** What a run counts, and what {@link EpgEventInput} `*:done` events carry. */
export interface GrabCounts {
  fetched: number;
  empty: number;
  fromCache: number;
  unchanged: number;
  failed: number;
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
   */
  | { type: 'site:started'; site: string; channels: number; days: number; requests: number }
  | ({ type: 'site:done'; site: string } & GrabCounts)
  /** The site could not be read or run at all, so none of it was grabbed. */
  | { type: 'site:failed'; site: string; error: unknown }
  /** The site's own code, saying something — `ctx.log`. */
  | { type: 'site:note'; site: string; message: string }
  /** The site's own code, saying something that matters — `ctx.warn`. */
  | { type: 'site:warning'; site: string; message: string }
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
  | { type: 'merge:done'; output: string }
  | { type: 'prune:done'; removed: number; before: string };

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
  'merge:done': { level: 'info', phase: 'merge' },
  'prune:done': { level: 'info', phase: 'prune' },
} as const satisfies Record<EpgEventType, EventKind>;

/**
 * What a reporter is given: what happened, and how loudly.
 *
 * An intersection over the union, so narrowing on `type` still works and every
 * member gains the two stamped fields without any of them saying so.
 */
export type EpgEvent = EpgEventInput & EventKind;

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

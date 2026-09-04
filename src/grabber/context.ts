/**
 * What a site's own code is handed — the request contexts, and the parse one.
 *
 * Free functions rather than methods on the run, because a run is no longer the
 * only caller: `epg try` puts one channel-day through the very same shapes, and
 * a copy of them there would be a copy that drifts. What a site sees when it is
 * being tried has to be what it sees when it is being grabbed, or trying it
 * proves nothing.
 *
 * Everything the shapes need that a run happens to own — the client, the site's
 * own notes, where `log` and `warn` go — arrives as {@link ContextDeps}, so
 * nothing here knows what a `SiteRun` is.
 */

import { dayToDate } from '../core/days.js';
import type { Says } from '../core/events.js';
import { ProgrammeBuilder } from '../xmltv/builder.js';
import type { Request } from './planner.js';
import type { ResolvedBatching } from './planner.js';
import type {
  BaseRequestContext,
  BatchMode,
  ChannelsDaysRequestContext,
  GrabberChannel,
  PacedRequest,
  ParseContext,
  RequestContextFor,
  SiteState,
  StreamContext,
} from './types.js';
import type { KyInstance } from 'ky';

/** What a context is built from, beyond the request itself. */
export interface ContextDeps {
  http: KyInstance;
  /** The site's own `Map`, as it will be given to the site. */
  state: SiteState;
  /** Where `ctx.log` and `ctx.warn` go. */
  says: Says;
  signal?: AbortSignal;
}

/** What every request context carries, whichever shape the rest of it takes. */
export function baseContext(request: Request, deps: ContextDeps): BaseRequestContext {
  return {
    channelDays: request.pairs.map(({ channel, day, cached }) => ({
      channel,
      day,
      date: dayToDate(day),
      ...(cached === undefined ? {} : { cached }),
    })),
    http: deps.http,
    state: deps.state,
    ...deps.says,
    ...(deps.signal ? { signal: deps.signal } : {}),
  };
}

/**
 * The days a request covers, as a context that batches them says them.
 *
 * A Date of its own everywhere one is handed out, `from` and `to` included.
 * They are mutable — `Object.freeze` does not help, a Date keeps its value in
 * an internal slot rather than a property — so the hazard worth removing is not
 * that a site can change one, it is that changing one would silently change the
 * others: `from` and `dates[0]` as the same object is a bug nobody would find.
 */
export function manyDays(
  request: Request,
): Pick<ChannelsDaysRequestContext, 'days' | 'dates' | 'from' | 'to'> {
  return {
    days: request.days,
    dates: request.days.map(dayToDate),
    from: dayToDate(request.days[0]!),
    to: dayToDate(request.days[request.days.length - 1]!),
  };
}

/**
 * The context for one request, in the shape this site's mode declares — plus
 * the channel-days it is for, which the plan already worked out.
 */
export function requestContext(
  request: Request,
  batching: ResolvedBatching,
  deps: ContextDeps,
): RequestContextFor<BatchMode> {
  const context = {
    ...baseContext(request, deps),
    ...(batching.manyChannels ? { channels: request.channels } : { channel: request.channels[0]! }),
    ...(batching.manyDays
      ? manyDays(request)
      : { day: request.days[0]!, date: dayToDate(request.days[0]!) }),
  };

  // The mode and this shape were chosen together right here; the compiler
  // cannot follow that through the conditional type.
  return context as RequestContextFor<BatchMode>;
}

/**
 * The context a stream is given: every channel and day it is being asked
 * about, and somewhere to say what it noticed on the way through.
 *
 * Built rather than cast from {@link requestContext}'s: a stream site always
 * resolves to `both`, so this shape is not one of several and needs no
 * assertion to say which — a member added to `StreamContext` fails to compile
 * here instead of being quietly missing at runtime.
 */
export function streamContext(request: Request, deps: ContextDeps): StreamContext {
  return {
    ...baseContext(request, deps),
    ...manyDays(request),
    channels: request.channels,
  };
}

/** What a parse needs that a request context does not carry. */
export interface ParseDeps extends ContextDeps {
  /**
   * How a request made *from inside* a parse is paced.
   *
   * A run puts it on the site's own queue ahead of the planned ones, so a
   * channel-day in hand is finished rather than joined by another. Anything
   * with no queue to speak of runs the task.
   */
  paced: PacedRequest;
}

/**
 * The context for parsing one channel-day out of what a request returned.
 *
 * `programme` is bound to the channel-day being parsed, which is what lets a
 * parse repeat neither the id nor the language on every programme it builds.
 */
export function parseContext<TRaw>(
  channel: GrabberChannel,
  day: string,
  payload: TRaw,
  deps: ParseDeps,
): ParseContext<TRaw> {
  return {
    channel,
    date: dayToDate(day),
    day,
    payload,
    http: deps.http,
    state: deps.state,
    ...deps.says,
    ...(deps.signal ? { signal: deps.signal } : {}),
    paced: deps.paced,
    programme: (start, title, options) =>
      new ProgrammeBuilder({
        channel: channel.xmltvId,
        start,
        title,
        ...(channel.lang === undefined ? {} : { lang: channel.lang }),
        ...options,
      }),
  };
}

/**
 * Talking to Schedules Direct: one token, six calls, and no secrets anywhere
 * they could be read back.
 *
 * Apart from the site for two reasons. It is a state machine — a token is good
 * for a day, is reused until the service says otherwise, and is replaced when it
 * is — and it is the only part of this adapter that handles credentials, which
 * is a smaller thing to keep an eye on when it is one file.
 *
 * **The token lives in hooks**, not in the calls, so a call below is a path and
 * a body and nothing else — and nothing outside this file ever holds one. There
 * are two clients to make that true: `client`, which is the site's own with the
 * service's prefix on it and is what earns a token, and `clientWithAuth`, which
 * extends it with the hooks that spend one. The split is what keeps the hooks
 * from having to recognise the authentication call and skip it — the request
 * that asks for a token is made by a client that knows nothing about tokens.
 *
 * Renewal is `ky`'s own forced retry rather than a second request of ours, so it
 * counts against `retry.limit`, shows up in `beforeRetry`, and cannot become a
 * loop of its own.
 */

import ky, { HTTPError, type KyInstance, type Options as KyOptions, type RetryOptions } from 'ky';
import { createHash } from 'node:crypto';
import { GrabberError } from '../../core/error.js';
import type { PacedRequest } from '../types.js';
import {
  SCHEDULES_DIRECT_URL,
  wireMessage,
  type WireArtwork,
  type WireHeadend,
  type WireLineup,
  type WireMd5Response,
  type WireProgram,
  type WireSchedule,
  type WireStatus,
  type WireToken,
} from './wire.js';

/** How the service wants a password: SHA1, hex, lower case. */
export function passwordHash(password: string): string {
  return createHash('sha1').update(password, 'utf8').digest('hex');
}

/** What one station is being asked about, in the shape both schedule calls take. */
export interface StationDays {
  stationID: string;
  /** The days as `YYYY-MM-DD`. Left out entirely, the service sends everything it has. */
  date?: string[];
}

/** Where the token is kept between runs. */
export const TOKEN = 'token';
export const TOKEN_EXPIRES = 'tokenExpires';

/**
 * How close to the end of a token's life is too close to start a run with.
 *
 * A run is not instant, and a token expiring between the first call and the last
 * costs a re-authentication mid-pass — which works, and is what the retry is
 * for, but the point of keeping one is to make that the exception.
 */
const EXPIRY_MARGIN_MS = 300_000;

/**
 * What this service needs of a retry policy, which is not what `ky` defaults to.
 *
 * `ky` does not retry `POST`, and every call here but two is one — so a single
 * 503 part way through a pass would fail every station-day left in it. The
 * statuses are `ky`'s own; an expired token needs none of them, since that retry
 * is forced from the hook below rather than matched on a status.
 */
export const SCHEDULES_DIRECT_RETRY: RetryOptions = {
  limit: 2,
  methods: ['get', 'post'],
  backoffLimit: 30_000,
};

/** Where a token is kept, when it may be kept at all. */
export interface SchedulesDirectSession {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => boolean;
}

export interface SchedulesDirectClientOptions {
  /** The site's own client, so proxy, timeout and the run's signal all apply. */
  http: KyInstance;
  username: string;
  /** Already hashed — see {@link passwordHash}. The plaintext never reaches here. */
  passwordSha1: string;
  /**
   * Where a token outlives the run, and whether it should at all.
   *
   * The site's own bag when it may be kept, nothing when it may not — a token is
   * a bearer credential good for a day, and a cache directory is a file on
   * someone's disk.
   */
  session?: SchedulesDirectSession;
  /**
   * How a call reaches the source — the site's queue, through a pass's `paced`.
   *
   * Defaults to running the task, which is what a caller with no queue wants:
   * the lineup helpers, and this file's own tests.
   */
  paced?: PacedRequest;
  /** For a message that names the site, as every other adapter error does. */
  site?: string;
  /** The service, for a mirror or a stand-in. A `ky` prefix, so a trailing slash is optional. */
  url?: string;
  /** Overrides {@link SCHEDULES_DIRECT_RETRY}, for a caller who knows better. */
  retry?: RetryOptions;
}

/**
 * The service, as this adapter uses it.
 *
 * One method per endpoint and nothing else — no token among them, deliberately:
 * authenticating is this file's business, and a client that handed one out would
 * be inviting a caller to put it somewhere. What they answer with is the wire
 * shape, because deciding what it means is the mapping's job rather than the
 * transport's.
 */
export interface SchedulesDirectClient {
  status: () => Promise<WireStatus>;
  /** What a region has on offer, which needs no lineup on the account. */
  headends: (where: { country: string; postalCode: string }) => Promise<WireHeadend[]>;
  lineup: (id: string) => Promise<WireLineup>;
  schedulesMd5: (stations: StationDays[]) => Promise<WireMd5Response>;
  schedules: (stations: StationDays[]) => Promise<WireSchedule[]>;
  programs: (ids: string[]) => Promise<WireProgram[]>;
  artwork: (ids: string[]) => Promise<WireArtwork[]>;
}

/**
 * When a token expires, as milliseconds.
 *
 * Epoch **seconds** on the wire — what the service documents and what it really
 * sends. The check is not about the wire: this value comes back out of a cache
 * file, where anything could be sitting.
 */
function expiryOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value * 1000 : undefined;
}

/**
 * A token worth starting a run with, or nothing.
 *
 * Both halves have to be there and the expiry has to be far enough off: a token
 * kept without one would be used until the service refused it, which is a wasted
 * round trip every run rather than one authentication a day.
 */
function storedToken(session: SchedulesDirectSession | undefined, now: number): string | undefined {
  const token = session?.get(TOKEN);
  const expires = expiryOf(session?.get(TOKEN_EXPIRES));

  return typeof token === 'string' &&
    token !== '' &&
    expires !== undefined &&
    expires - now > EXPIRY_MARGIN_MS
    ? token
    : undefined;
}

/**
 * Strip anything that would identify the account out of a message.
 *
 * A hook rather than a wrapper at each call site, for the reason the Xtream
 * adapter gives: it then covers retries, and anything added later. What there is
 * to find is the token and the password hash — both long runs of hex — and the
 * JSON body of the authentication call, which `ky` puts in the message of a
 * failed request.
 */
export function schedulesDirectHooks(hooks: KyOptions['hooks']): NonNullable<KyOptions['hooks']> {
  return {
    ...hooks,
    beforeError: [
      ...(hooks?.beforeError ?? []),
      ({ error }) => {
        error.message = error.message
          .replaceAll(/\b[0-9a-f]{32,}\b/gi, '…')
          .replaceAll(/("(?:password|token)"\s*:\s*)"[^"]*"/gi, '$1"…"');

        return error;
      },
    ],
  };
}

/**
 * What the service said about a request it refused, where it said anything.
 *
 * From `error.data` rather than from the response: `ky` parses the body of a
 * failed request into it and the response is spent by the time this sees it, so
 * reading it again answers nothing — which is how "HTTP 400" ends up in an error
 * that could have said "Invalid username or password."
 */
function refusal(error: unknown): string | undefined {
  if (!(error instanceof HTTPError)) {
    return undefined;
  }

  return error.data === undefined
    ? `HTTP ${String(error.response.status)}`
    : wireMessage(error.data);
}

/**
 * A client for one site's account.
 *
 * The token is memoised as a *promise*, so two calls that start together
 * authenticate once; a failure clears it, so the next call tries again rather
 * than awaiting a rejection for ever.
 */
export function createSchedulesDirectClient(
  options: SchedulesDirectClientOptions,
): SchedulesDirectClient {
  const { http, session, site = 'schedulesdirect', url = SCHEDULES_DIRECT_URL } = options;
  const paced: PacedRequest = options.paced ?? ((task) => task({}));

  /** The service, unauthenticated: what asks for a token, and nothing else. */
  const client: KyInstance = http.extend({ prefix: url });

  let pending: Promise<string> | undefined;

  /**
   * Earn a token.
   *
   * Deliberately **not** paced. It is called from inside `beforeRequest`, which
   * runs inside the queued task of the call that wants the token — so taking a
   * slot of its own would be a task waiting for the slot it is already holding,
   * which at the default concurrency of 1 is a hang rather than a slow run. It
   * is also one request a day, to an endpoint that is not the one a `rateLimit`
   * is about.
   */
  const authenticate = async (): Promise<string> => {
    let answer: WireToken;

    try {
      answer = await client
        .post('token', { json: { username: options.username, password: options.passwordSha1 } })
        .json<WireToken>();
    } catch (error) {
      // A wrong password, an expired subscription and an account locked for too
      // many attempts are three different things to do something about, and the
      // service tells them apart in its own words — but it does so at HTTP 400,
      // so those words are in the body of a thrown error rather than in an
      // answer anything here would otherwise read.
      const said = refusal(error);

      if (said === undefined) {
        throw error;
      }

      throw new GrabberError(`${site}: Schedules Direct refused the account — ${said}`);
    }

    if (typeof answer.token !== 'string' || answer.token === '') {
      throw new GrabberError(
        `${site}: Schedules Direct returned no token — ${wireMessage(answer)}`,
      );
    }

    session?.set(TOKEN, answer.token);

    if (expiryOf(answer.tokenExpires) !== undefined) {
      session?.set(TOKEN_EXPIRES, answer.tokenExpires);
    }

    return answer.token;
  };

  /** The token to send, authenticating only if there is not one worth sending. */
  const ensureToken = async (): Promise<string> => {
    const held = storedToken(session, Date.now());

    if (held !== undefined) {
      return held;
    }

    pending ??= authenticate().catch((error: unknown) => {
      pending = undefined;

      throw error;
    });

    return pending;
  };

  /** Drop the token everywhere it is held, so the next request earns a new one. */
  const forgetToken = (): void => {
    pending = undefined;
    session?.delete(TOKEN);
    session?.delete(TOKEN_EXPIRES);
  };

  /**
   * The service with a token on every request, and a new one when it is refused.
   *
   * `extend` appends to what it is extending rather than replacing it, so the
   * site's own hooks — and the prefix above — still apply; these two run last
   * and do one thing each.
   */
  const clientWithAuth: KyInstance = client.extend({
    retry: options.retry ?? SCHEDULES_DIRECT_RETRY,
    hooks: {
      beforeRequest: [
        async ({ request: sending }) => {
          sending.headers.set('token', await ensureToken());
        },
      ],
      afterResponse: [
        async ({ request: refused, response, retryCount }) => {
          // The status, not a code in the body: `TOKEN_EXPIRED` is the only
          // account error the service answers 403 to — invalid, expired, locked
          // out, hash wrong and JSON-access-off are all 400 — so the status line
          // says it, and reading the body would mean parsing a `/programs`
          // answer twice to learn what it already said.
          //
          // `retryCount === 0` is the once. A second 403 is an account that
          // cannot authenticate rather than a token that aged out mid-run, and
          // retrying that is how a wrong password becomes a loop.
          if (response.status !== 403 || retryCount > 0) {
            return;
          }

          forgetToken();

          const headers = new Headers(refused.headers);

          headers.set('token', await ensureToken());

          // Forced through `ky` rather than sent again by hand, so it counts
          // against `retry.limit` and is visible to anything watching retries.
          return ky.retry({ request: new Request(refused, { headers }), code: 'TOKEN_EXPIRED' });
        },
      ],
    },
  });

  /** One call: a path, a body if it takes one, and an answer of the shape asked for. */
  const request = <T>(path: string, body?: unknown): Promise<T> =>
    paced(({ signal }) =>
      clientWithAuth(path, {
        method: body === undefined ? 'get' : 'post',
        ...(body === undefined ? {} : { json: body }),
        ...(signal ? { signal } : {}),
      }).json<T>(),
    );

  /**
   * A call whose answer is a list.
   *
   * The service answers a whole-request failure with an *object* even where
   * success is an array — at HTTP 200, so nothing threw and nothing but the
   * shape says anything is wrong.
   */
  const requestList = async <T>(path: string, body: unknown): Promise<T[]> => {
    const answer = await request<T[] | Record<string, unknown>>(path, body);

    if (Array.isArray(answer)) {
      return answer;
    }

    throw new GrabberError(`${site}: Schedules Direct refused ${path} — ${wireMessage(answer)}`);
  };

  return {
    status: () => request<WireStatus>('status'),
    headends: (where) =>
      // Its own spelling: the service takes `postalcode`, all lower case.
      requestList<WireHeadend>(
        `headends?${new URLSearchParams({ country: where.country, postalcode: where.postalCode }).toString()}`,
        undefined,
      ),
    lineup: (id) => request<WireLineup>(`lineups/${encodeURIComponent(id)}`),
    schedulesMd5: (stations) => request<WireMd5Response>('schedules/md5', stations),
    schedules: (stations) => requestList<WireSchedule>('schedules', stations),
    programs: (ids) => requestList<WireProgram>('programs', ids),
    artwork: (ids) => requestList<WireArtwork>('metadata/programs', ids),
  };
}

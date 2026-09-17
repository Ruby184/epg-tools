/**
 * A stand-in for Schedules Direct, over real HTTP.
 *
 * Not a test: it is what the tests in this directory are pointed at, in the
 * shape the rest of the suite stands its servers up in — a real `node:http`
 * listener on a loopback port, so the client under test does what it would do
 * against the service itself, `ky` retries and all.
 *
 * Two things it does that a stub would not. It **issues tokens** rather than
 * accepting any string, so "renews once and replays the call" is a thing a test
 * can assert rather than a thing it can only mock. And it answers every request
 * from state a test can change mid-run, which is how an expiry, a refusal or a
 * flaky endpoint is arranged without another server.
 */

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  WireAiring,
  WireArtwork,
  WireHeadend,
  WireImage,
  WireLineup,
  WireMd5Response,
  WireProgram,
  WireSchedule,
  WireStatus,
  WireToken,
} from '../../src/grabber/schedules-direct/wire.js';

/** One request as the service saw it. */
export interface SdCall {
  path: string;
  method: string;
  /** The `token` header, which is the whole of how a call authenticates. */
  token: string | undefined;
  /** What came after the `?`, for the two calls that ask with one. */
  query: string;
  /** What the client called itself, which the service asks every client to say. */
  userAgent: string | undefined;
  body: unknown;
}

/** What the service will answer with, until a test says otherwise. */
export interface SdAnswers {
  status?: WireStatus;
  lineup?: WireLineup;
  /** Answered instead of the md5s computed from {@link SdServer.setSchedule}. */
  md5?: WireMd5Response;
  /** Answered instead of the schedules a test set up. */
  schedules?: WireSchedule[];
  programs?: WireProgram[];
  artwork?: WireArtwork[];
  /** What `GET /headends` answers with — a region's offering, not the account's. */
  headends?: WireHeadend[];
  /** Answered instead of a fresh token — for the shapes that are not a token. */
  token?: WireToken;
}

export interface SdServer {
  url: string;
  /** Every call, in order. */
  calls: SdCall[];
  /** How many calls were made to one path, `token` included. */
  countOf: (path: string) => number;
  /** The calls made to one path. */
  callsTo: (path: string) => SdCall[];
  /** Change what the service answers with. */
  answer: (answers: SdAnswers) => void;
  /**
   * Make every token issued so far stop working.
   *
   * The next authenticated request is refused with `TOKEN_EXPIRED`, exactly as
   * the service does — a 403 carrying the code — and a request bearing a token
   * issued *after* this is fine again. With `always`, every token is refused
   * however new, which is what an account that cannot authenticate looks like
   * from the outside.
   */
  expireTokens: (options?: { always?: boolean }) => void;
  /**
   * Take this token as one of its own.
   *
   * For the case where a run starts with a token it was given rather than one it
   * earned — without this the stand-in refuses it, and what looks like a test of
   * reuse is a test of renewal.
   */
  accept: (token: string) => void;
  /** Refuse the next authentication, in the service's own shape. */
  refuseAccount: (code: number, message: string) => void;
  /** Fail the next `times` calls to this path with a status. */
  failNext: (path: string, status: number, times?: number) => void;
  /**
   * What one station has on one day.
   *
   * The md5 is **computed from it**, so "unchanged" means what it means: a test
   * that changes a schedule changes its md5, and one that does not leaves it
   * alone. A stub returning a fixed hash would make every md5 case a test of the
   * stub.
   */
  setSchedule: (stationID: string, day: string, airings: WireAiring[]) => void;
  /** Answer for one station with a code instead of a schedule — `7020`, `7100`. */
  failStation: (stationID: string, code: number) => void;
  /** The programme detail to answer `/programs` with. */
  setProgram: (program: WireProgram) => void;
  /** The pictures one programme's artwork call answers with. */
  setArtwork: (programID: string, images: WireImage[]) => void;
  /**
   * Answer `6001` for this programme the first `times` it is asked for, as the
   * service does while it is still generating one.
   */
  queueProgram: (programID: string, times: number) => void;
}

let running: Server | undefined;

/** Close whatever the last `sdServer()` started. Call from `afterEach`. */
export async function stopSdServer(): Promise<void> {
  const server = running;

  running = undefined;

  if (server !== undefined) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** The body of a request, parsed, or `undefined` for one that carried none. */
async function bodyOf(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

/** The service, listening on a port of the operating system's choosing. */
export async function sdServer(initial: SdAnswers = {}): Promise<SdServer> {
  const calls: SdCall[] = [];
  const answers: SdAnswers = { ...initial };
  const valid = new Set<string>();
  const failures = new Map<string, { status: number; times: number }>();

  /** What each station has, by day — and what its md5 is therefore. */
  const schedules = new Map<string, Map<string, WireAiring[]>>();
  const programs = new Map<string, WireProgram>();
  const artwork = new Map<string, WireImage[]>();
  /** Programmes to answer `6001` for, and how many more times. */
  const queuedPrograms = new Map<string, number>();
  const stationFailures = new Map<string, number>();

  let issued = 0;
  let alwaysExpired = false;
  let refusal: { code: number; message: string } | undefined;

  /** The md5 of one station-day, as the service's own is: over its content. */
  const md5Of = (airings: WireAiring[]): string =>
    createHash('md5').update(JSON.stringify(airings)).digest('base64').slice(0, 22);

  const send = (response: ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };

  const server = createServer((request, response) => {
    void (async () => {
      const asked = new URL(request.url ?? '/', 'http://sd');
      const path = asked.pathname.replace('/20141201/', '');
      const sent = request.headers['token'];
      // One value even where the header was repeated: a second `token:` is not
      // a second credential, and the service would read neither.
      const token = typeof sent === 'string' ? sent : undefined;

      calls.push({
        path,
        method: request.method ?? 'GET',
        token,
        query: asked.search.replace('?', ''),
        userAgent: request.headers['user-agent'],
        body: await bodyOf(request),
      });

      const failing = failures.get(path);

      if (failing !== undefined && failing.times > 0) {
        failing.times -= 1;
        send(response, failing.status, { code: 9999, message: 'try again' });

        return;
      }

      if (path === 'token') {
        if (refusal !== undefined) {
          const { code, message } = refusal;

          refusal = undefined;
          // The service says which of the account failures this is, at HTTP 400
          // — its own shape, because that is where the message has to be read
          // from to be reported.
          send(response, 400, { response: 'INVALID_USER', code, message });

          return;
        }

        if (answers.token !== undefined) {
          // At HTTP 200 whatever it says: an offline service answers with a
          // token in hand, and only its code tells you not to use it.
          send(response, 200, answers.token);

          return;
        }

        issued += 1;

        const fresh = `token-${String(issued)}`;

        valid.add(fresh);
        send(response, 200, {
          code: 0,
          message: 'OK',
          token: fresh,
          tokenExpires: Math.floor(Date.now() / 1000) + 86_400,
        });

        return;
      }

      if (token === undefined || alwaysExpired || !valid.has(token)) {
        send(response, 403, {
          response: 'TOKEN_EXPIRED',
          code: 4006,
          message: 'Token has expired. Request new token.',
        });

        return;
      }

      if (path === 'status') {
        send(response, 200, answers.status ?? { account: { messages: [] }, lineups: [] });
      } else if (path.startsWith('lineups/') && request.method !== 'GET') {
        // The service's own answers, `changesRemaining` included — a number for
        // an add and a string for a delete, which is how its documentation
        // shows them and so how a client has to read them.
        send(
          response,
          200,
          request.method === 'PUT'
            ? { response: 'OK', code: 0, message: 'Added lineup.', changesRemaining: 5 }
            : { response: 'OK', code: 0, message: 'Deleted lineup.', changesRemaining: '6' },
        );
      } else if (path.startsWith('lineups/')) {
        send(response, 200, answers.lineup ?? { map: [], stations: [] });
      } else if (path === 'schedules/md5') {
        if (answers.md5 !== undefined) {
          send(response, 200, answers.md5);

          return;
        }

        const asked = (calls.at(-1)?.body ?? []) as { stationID: string; date?: string[] }[];
        const out: WireMd5Response = {};

        for (const { stationID, date } of asked) {
          const held = schedules.get(stationID);
          const failure = stationFailures.get(stationID);
          const forStation: Record<string, { code?: number; md5?: string; lastModified?: string }> =
            {};

          for (const day of date ?? [...(held?.keys() ?? [])]) {
            const airings = held?.get(day);

            if (failure !== undefined) {
              forStation[day] = { code: failure };
            } else if (airings !== undefined) {
              forStation[day] = {
                code: 0,
                md5: md5Of(airings),
                lastModified: '2026-09-12T00:00:00Z',
              };
            }
          }

          out[stationID] = forStation;
        }

        send(response, 200, out);
      } else if (path === 'schedules') {
        if (answers.schedules !== undefined) {
          send(response, 200, answers.schedules);

          return;
        }

        const asked = (calls.at(-1)?.body ?? []) as { stationID: string; date?: string[] }[];

        send(
          response,
          200,
          asked.flatMap(({ stationID, date }): WireSchedule[] => {
            const failure = stationFailures.get(stationID);

            if (failure !== undefined) {
              return [{ stationID, code: failure, minDate: '2026-09-01', maxDate: '2026-09-14' }];
            }

            const held = schedules.get(stationID);
            const days = date ?? [...(held?.keys() ?? [])];
            const has = days.filter((day) => held?.get(day) !== undefined);
            const has_not = days.filter((day) => held?.get(day) === undefined);

            // As the live service answers it: the days it has in one entry, and
            // **one entry per day it will not answer for**, each naming its own
            // date. A station can therefore appear more than once.
            return [
              ...(has.length === 0 && has_not.length > 0
                ? []
                : [{ stationID, programs: has.flatMap((day) => held?.get(day) ?? []) }]),
              ...has_not.map((day): WireSchedule => ({
                stationID,
                code: 7020,
                response: 'SCHEDULE_RANGE_EXCEEDED',
                requestedDate: day,
                minDate: '2026-09-01',
                maxDate: '2026-09-14',
              })),
            ];
          }),
        );
      } else if (path === 'headends') {
        send(response, 200, answers.headends ?? []);
      } else if (path === 'programs') {
        if (answers.programs !== undefined) {
          send(response, 200, answers.programs);

          return;
        }

        const asked = (calls.at(-1)?.body ?? []) as string[];

        send(
          response,
          200,
          asked.flatMap((id) => {
            const left = queuedPrograms.get(id) ?? 0;

            if (left > 0) {
              queuedPrograms.set(id, left - 1);

              return [{ programID: id, code: 6001, message: 'Program is queued for generation.' }];
            }

            const held = programs.get(id);

            return held === undefined ? [] : [held];
          }),
        );
      } else if (path === 'metadata/programs') {
        // Exactly as the live service behaves: without the trailing slash it
        // refuses every body, its own documented example included. Answering
        // here rather than 404ing is what makes a client that forgets the slash
        // fail this suite instead of only failing in production.
        send(response, 400, {
          response: 'INCORRECT_REQUEST',
          code: 1008,
          message: 'The request is improperly formatted.',
        });
      } else if (path === 'metadata/programs/') {
        if (answers.artwork !== undefined) {
          send(response, 200, answers.artwork);

          return;
        }

        const asked = (calls.at(-1)?.body ?? []) as string[];

        send(
          response,
          200,
          asked.map((id) => ({ programID: id, data: artwork.get(id) ?? [] })),
        );
      } else {
        send(response, 404, { code: 404, message: `no such path: ${path}` });
      }
    })();
  });

  running = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    calls,
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/20141201/`,
    countOf: (path) => calls.filter((call) => call.path === path).length,
    callsTo: (path) => calls.filter((call) => call.path === path),
    answer: (next) => Object.assign(answers, next),
    accept: (token) => void valid.add(token),
    expireTokens: (options) => {
      alwaysExpired = options?.always === true;
      valid.clear();
    },
    refuseAccount: (code, message) => {
      refusal = { code, message };
    },
    failNext: (path, status, times = 1) => failures.set(path, { status, times }),
    setSchedule: (stationID, day, airings) => {
      const held = schedules.get(stationID) ?? new Map<string, WireAiring[]>();

      held.set(day, airings);
      schedules.set(stationID, held);
    },
    failStation: (stationID, code) => void stationFailures.set(stationID, code),
    setProgram: (program) => void programs.set(program.programID ?? '', program),
    setArtwork: (programID, images) => void artwork.set(programID, images),
    queueProgram: (programID, times) => void queuedPrograms.set(programID, times),
  };
}

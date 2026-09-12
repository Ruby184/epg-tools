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

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  WireArtwork,
  WireLineup,
  WireMd5Response,
  WireProgram,
  WireSchedule,
  WireStatus,
} from '../../src/grabber/schedules-direct/wire.js';

/** One request as the service saw it. */
export interface SdCall {
  path: string;
  method: string;
  /** The `token` header, which is the whole of how a call authenticates. */
  token: string | undefined;
  body: unknown;
}

/** What the service will answer with, until a test says otherwise. */
export interface SdAnswers {
  status?: WireStatus;
  lineup?: WireLineup;
  md5?: WireMd5Response;
  schedules?: WireSchedule[];
  programs?: WireProgram[];
  artwork?: WireArtwork[];
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

  let issued = 0;
  let alwaysExpired = false;
  let refusal: { code: number; message: string } | undefined;

  const send = (response: ServerResponse, status: number, body: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  };

  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', 'http://sd').pathname.replace('/20141201/', '');
      const sent = request.headers['token'];
      // One value even where the header was repeated: a second `token:` is not
      // a second credential, and the service would read neither.
      const token = typeof sent === 'string' ? sent : undefined;

      calls.push({
        path,
        method: request.method ?? 'GET',
        token,
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
      } else if (path.startsWith('lineups/')) {
        send(response, 200, answers.lineup ?? { map: [], stations: [] });
      } else if (path === 'schedules/md5') {
        send(response, 200, answers.md5 ?? {});
      } else if (path === 'schedules') {
        send(response, 200, answers.schedules ?? []);
      } else if (path === 'programs') {
        send(response, 200, answers.programs ?? []);
      } else if (path === 'metadata/programs') {
        send(response, 200, answers.artwork ?? []);
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
  };
}

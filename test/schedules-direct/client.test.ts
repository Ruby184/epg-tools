import ky from 'ky';
import { afterEach, describe, expect, it } from 'vitest';
import { GrabberError } from '../../src/core/error.js';
import {
  createSchedulesDirectClient,
  passwordHash,
  schedulesDirectHooks,
  TOKEN,
  TOKEN_EXPIRES,
  type SchedulesDirectClientOptions,
} from '../../src/grabber/schedules-direct/client.js';
import { sdServer, stopSdServer, type SdServer } from './server.js';

afterEach(stopSdServer);

const PASSWORD = 'hunter2';

/** A client against this stand-in, with whatever a case wants to change. */
function client(source: SdServer, options: Partial<SchedulesDirectClientOptions> = {}) {
  return createSchedulesDirectClient({
    http: ky.create({ hooks: schedulesDirectHooks(undefined) }),
    username: 'someone@example.com',
    passwordSha1: passwordHash(PASSWORD),
    url: source.url,
    site: 'sd.example',
    ...options,
  });
}

/** A session that keeps what it is given, as the site's own bag does. */
function session(entries: [string, unknown][] = []) {
  const held = new Map<string, unknown>(entries);

  return {
    held,
    get: (key: string) => held.get(key),
    set: (key: string, value: unknown) => void held.set(key, value),
    delete: (key: string) => held.delete(key),
  };
}

describe('the Schedules Direct client', () => {
  it('hashes the password the way the service asks', () => {
    // Lower-case hex sha1 — the service refuses anything else outright, with a
    // code of its own for it.
    expect(passwordHash(PASSWORD)).toBe('f3bbbd66a63d4bf1747940578ec3d0103530e21d');
    expect(passwordHash(PASSWORD)).toMatch(/^[0-9a-f]{40}$/);
  });

  it('authenticates once, and carries the token on every call after', async () => {
    const source = await sdServer();
    const sd = client(source);

    await sd.status();
    await sd.schedules([{ stationID: '1', date: ['2026-09-12'] }]);
    await sd.programs(['EP1']);

    expect(source.countOf('token')).toBe(1);
    // Every call but the one that earned it goes out carrying it.
    expect(source.calls.filter((call) => call.path !== 'token').map((call) => call.token)).toEqual([
      'token-1',
      'token-1',
      'token-1',
    ]);
  });

  it('reuses a token the last run stored, without authenticating at all', async () => {
    const source = await sdServer();

    // One the service already knows, so the call goes through on it — otherwise
    // this would be testing renewal rather than reuse.
    source.accept('from-yesterday');

    const kept = session([
      [TOKEN, 'from-yesterday'],
      [TOKEN_EXPIRES, Math.floor(Date.now() / 1000) + 86_400],
    ]);

    await client(source, { session: kept }).status();

    expect(source.countOf('token')).toBe(0);
    expect(source.callsTo('status')[0]?.token).toBe('from-yesterday');
  });

  it('authenticates when the stored token is spent, and keeps the new one', async () => {
    const source = await sdServer();
    const kept = session([
      [TOKEN, 'stale'],
      // Inside the margin: not expired yet, but too close to start a run with.
      [TOKEN_EXPIRES, Math.floor(Date.now() / 1000) + 60],
    ]);

    await client(source, { session: kept }).status();

    expect(source.countOf('token')).toBe(1);
    expect(kept.held.get(TOKEN)).toBe('token-1');
    expect(kept.held.get(TOKEN_EXPIRES)).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('keeps no token at all when it was told not to', async () => {
    const source = await sdServer();
    // No session: nowhere for a token to be written down.
    const sd = client(source);

    await sd.status();
    await sd.status();

    // Nowhere to keep one between clients, so each run of this one authenticates
    // — but within the client the promise is memoised, so it is still once.
    expect(source.countOf('token')).toBe(1);
  });

  it('earns a new token when the service says the old one expired, and replays the call', async () => {
    const source = await sdServer();
    const kept = session();
    const sd = client(source, { session: kept });

    await sd.status();
    // Everything issued so far stops working, as a token does after a day.
    source.expireTokens();

    await expect(sd.lineup('USA-OTA-90210')).resolves.toBeDefined();

    // Twice: the first token, and the one earned after the refusal.
    expect(source.countOf('token')).toBe(2);
    // The call was made again, and the second attempt carried the new token.
    expect(source.callsTo('lineups/USA-OTA-90210').map((call) => call.token)).toEqual([
      'token-1',
      'token-2',
    ]);
    expect(kept.held.get(TOKEN)).toBe('token-2');
  });

  it('gives up rather than looping when a fresh token is refused too', async () => {
    const source = await sdServer();
    const sd = client(source);

    await sd.status();

    // Nothing this stand-in issues will be accepted again, which is what an
    // account that cannot authenticate looks like from the outside.
    source.expireTokens({ always: true });

    await expect(sd.status()).rejects.toThrow();

    // Bounded: `retry.limit` is what stops it, so the run fails rather than
    // asking for tokens until the service locks the account.
    expect(source.countOf('token')).toBeLessThanOrEqual(3);
  });

  it('fails the site in the service`s own words when the account is refused', async () => {
    const source = await sdServer();

    source.refuseAccount(4003, 'Invalid username or password.');

    const error = await client(source)
      .status()
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(GrabberError);
    expect((error as Error).message).toContain('sd.example');
    // What the service said, rather than "HTTP 400".
    expect((error as Error).message).toContain('Invalid username or password.');
    expect((error as Error).message).toContain('4003');
  });

  it('keeps the password hash and the token out of anything it throws', async () => {
    const source = await sdServer();

    source.failNext('token', 500, 3);

    const error = await client(source)
      .status()
      .catch((thrown: unknown) => thrown);

    const said = `${(error as Error).message}\n${(error as Error).stack ?? ''}`;

    expect(said).not.toContain(passwordHash(PASSWORD));
    expect(said).not.toContain(PASSWORD);
  });

  it('asks for artwork at the path the service accepts, slash and all', async () => {
    const source = await sdServer();

    source.setArtwork('EP1', [{ uri: 'a.jpg', category: 'Iconic' }]);

    // The fixture answers 1008 without the trailing slash, exactly as the live
    // service does — so this passing is the whole assertion.
    await expect(client(source).artwork(['EP1'])).resolves.toEqual([
      { programID: 'EP1', data: [{ uri: 'a.jpg', category: 'Iconic' }] },
    ]);
  });

  it('hands back an artwork refusal rather than reading it as pictures', async () => {
    const source = await sdServer({
      // Where the list would be, which is where the service puts it: 11 of 300
      // real programmes that claimed artwork answered exactly like this.
      artwork: [{ programID: 'EP1', data: { response: 'INVALID_PROGRAMID', code: 6000 } }],
    });

    await expect(client(source).artwork(['EP1'])).resolves.toEqual([
      { programID: 'EP1', data: { response: 'INVALID_PROGRAMID', code: 6000 } },
    ]);
  });

  it('says what it is and which version, as the service asks every client to', async () => {
    const source = await sdServer();

    await client(source).status();

    // Not decoration: the service uses it to tell a subscriber on an old
    // release that there is a newer one, and to attribute a bug to the right
    // software. Every call, the token call included.
    for (const call of source.calls) {
      expect(call.userAgent).toMatch(/^epg-tools\/\d+\.\d+\.\d+/);
    }
  });

  it('leaves a user agent the caller set alone', async () => {
    const source = await sdServer();

    await client(source, {
      http: ky.create({ headers: { 'user-agent': 'something-else/1.0' } }),
    }).status();

    expect(source.calls.map((call) => call.userAgent)).toEqual([
      'something-else/1.0',
      'something-else/1.0',
    ]);
  });

  it('stops when the service says it is offline, rather than being refused call by call', async () => {
    const source = await sdServer();

    // At HTTP 200, with a token in hand and `tokenExpires: 0`: nothing but the
    // code says anything is wrong.
    source.answer({
      token: {
        response: 'SERVICE_OFFLINE',
        code: 3000,
        message: 'Server offline for maintenance.',
        token: 'CAFEDEADBEEF',
        tokenExpires: 0,
      },
    });

    await expect(client(source).status()).rejects.toThrow(/offline.*wait at least half an hour/s);
  });

  it('retries a POST, which ky on its own would not', async () => {
    const source = await sdServer({ programs: [{ programID: 'EP1' }] });

    source.failNext('programs', 503, 1);

    await expect(client(source).programs(['EP1'])).resolves.toEqual([{ programID: 'EP1' }]);
    // Twice: the 503, then the one that worked. Without `methods: ['get','post']`
    // the first would have been the last.
    expect(source.countOf('programs')).toBe(2);
  });

  it('sends its calls through the queue it was given, but never the token', async () => {
    const source = await sdServer();
    const paced: string[] = [];
    const sd = client(source, {
      paced: async (task) => {
        paced.push('task');

        return task({});
      },
    });

    await sd.status();

    // One task for the call. The token is earned inside `beforeRequest`, which
    // already runs inside that task — pacing it too would be a task waiting for
    // the slot it is holding, which at a concurrency of 1 never comes.
    expect(paced).toHaveLength(1);
    expect(source.countOf('token')).toBe(1);
  });

  it('says what the service refused a whole request with, where success is a list', async () => {
    const source = await sdServer();

    // The shape the service uses for a request-level failure even on endpoints
    // whose success is an array — at HTTP 200, so only the shape says so.
    source.answer({ schedules: { code: 7020, message: 'no such station' } as never });

    await expect(client(source).schedules([{ stationID: 'nope' }])).rejects.toThrow(
      /no such station/,
    );
  });
});

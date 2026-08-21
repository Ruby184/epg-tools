import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { KyInstance } from 'ky';
import { describe, expect, it } from 'vitest';
import { retryAfterMs, sitePacing } from '../src/grabber/pacing.js';
import type { AnySiteConfig } from '../src/grabber/types.js';

/** A site config with just enough on it for the pacing to be built. */
function site(overrides: Partial<AnySiteConfig> = {}): AnySiteConfig {
  return {
    site: 'example.tv',
    channels: [],
    async request() {
      return {};
    },
    parseDay: () => [],
    ...overrides,
  } as AnySiteConfig;
}

/**
 * A server whose answers are scripted per request, so a 429 followed by a 200
 * is deterministic rather than a matter of timing.
 */
async function scripted(answers: { status: number; headers?: Record<string, string> }[]): Promise<{
  url: string;
  hits: number;
  close(): void;
}> {
  let hits = 0;
  const server: Server = createServer((_request, response) => {
    const answer = answers[Math.min(hits, answers.length - 1)]!;
    hits++;
    response.writeHead(answer.status, answer.headers);
    response.end('{}');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/`,
    get hits() {
      return hits;
    },
    close: () => server.close(),
  };
}

/**
 * One request, its body discarded.
 *
 * Nothing here reads a response, and a body left unread keeps its stream open.
 * That matters because `afterResponse` makes ky clone the response: cancelling
 * one branch of the tee cannot release the source while the other is still
 * outstanding, so the pending cancellation is left for a later `abort()` to
 * reject — into nobody, which is an unhandled rejection and a failed run.
 *
 * `throwHttpErrors` is off because these tests are about what the pacing does
 * with a 4xx, not about the error ky would raise for one; that path reads the
 * body itself.
 */
async function hit(http: KyInstance, url: string): Promise<Response> {
  const response = await http.get(url, { retry: 0, throwHttpErrors: false });

  await response.body?.cancel();

  return response;
}

describe('retryAfterMs', () => {
  it('reads delta-seconds', () => {
    expect(retryAfterMs('30')).toBe(30_000);
    expect(retryAfterMs('0')).toBe(0);
    expect(retryAfterMs(' 2 ')).toBe(2000);
  });

  it('reads an HTTP date, relative to now', () => {
    const now = Date.parse('2026-08-21T12:00:00.000Z');
    expect(retryAfterMs('Fri, 21 Aug 2026 12:00:30 GMT', now)).toBe(30_000);
    // A date already past asks for no wait at all, not a negative one.
    expect(retryAfterMs('Fri, 21 Aug 2026 11:59:00 GMT', now)).toBe(0);
  });

  it('says nothing for a header that says nothing', () => {
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs('')).toBeUndefined();
    expect(retryAfterMs('soon')).toBeUndefined();
    // `Number('   ')` is 0, which would pass for "retry immediately".
    expect(retryAfterMs('   ')).toBeUndefined();
    expect(retryAfterMs('\n')).toBeUndefined();
  });
});

describe('sitePacing', () => {
  it('holds the whole queue on a 429, then releases it with its tasks intact', async () => {
    const server = await scripted([{ status: 429 }]);

    try {
      const logs: string[] = [];
      // Stamped from inside the log callback, which runs in the same tick as
      // the hold's timer is scheduled. Reading the clock after the request
      // instead would time from somewhere in the middle of the hold — the
      // response still has to make its way back — and call a hold that worked
      // too short.
      let heldFrom = 0;
      const { queue, http, dispose } = sitePacing(
        site({ backoff: { fallbackMs: 60, maxMs: 60 } }),
        {
          log: (message) => {
            logs.push(message);

            if (message.includes('holding requests')) {
              heldFrom = Date.now();
            }
          },
        },
      );

      const ran: string[] = [];
      let openGate = (): void => {};
      const gate = new Promise<void>((resolve) => {
        openGate = resolve;
      });

      // One task holds the single concurrency slot, so the other two are still
      // waiting their turn when the source objects — which is the case that
      // matters: a hold must not lose them.
      const held = queue.add(async () => {
        await gate;
        ran.push('gate');
      });
      const waiting = [queue.add(() => void ran.push('a')), queue.add(() => void ran.push('b'))];

      await hit(http, server.url);

      expect(queue.isPaused).toBe(true);
      expect(queue.size).toBe(2); // still queued, not thrown away
      expect(logs).toContain('[example.tv] HTTP 429: holding requests for 60ms');

      openGate();
      await Promise.all([held, ...waiting]);

      // They ran, and only once the hold was over.
      expect(ran).toEqual(['gate', 'a', 'b']);
      expect(Date.now() - heldFrom).toBeGreaterThanOrEqual(60);
      expect(queue.isPaused).toBe(false);
      dispose();
    } finally {
      server.close();
    }
  });

  it('takes the wait from Retry-After, capped by maxMs', async () => {
    const server = await scripted([{ status: 429, headers: { 'retry-after': '600' } }]);

    try {
      const logs: string[] = [];
      const { http, dispose } = sitePacing(site({ backoff: { maxMs: 40 } }), {
        log: (message) => logs.push(message),
      });

      await hit(http, server.url);

      // Ten minutes is what it asked for; a grab is not sitting still for that.
      expect(logs).toContain('[example.tv] HTTP 429: holding requests for 40ms');
      dispose();
    } finally {
      server.close();
    }
  });

  it('halves concurrency on a slow-down and gives it back on clean responses', async () => {
    const server = await scripted([
      { status: 429 },
      ...Array.from({ length: 10 }, () => ({ status: 200 })),
    ]);

    try {
      const { queue, http, dispose } = sitePacing(
        site({ concurrency: 4, backoff: { fallbackMs: 1, maxMs: 1 } }),
      );

      await hit(http, server.url);
      expect(queue.concurrency).toBe(2);

      // Recovery is one at a time, and only after a clean stretch.
      for (let i = 0; i < 9; i++) {
        await http.get(server.url, { retry: 0 });
      }

      expect(queue.concurrency).toBe(2);
      await http.get(server.url, { retry: 0 });
      expect(queue.concurrency).toBe(3);
      dispose();
    } finally {
      server.close();
    }
  });

  it('charges one concurrency penalty per hold, not one per response', async () => {
    const server = await scripted([{ status: 429 }]);

    try {
      const { queue, http, dispose } = sitePacing(
        site({ concurrency: 8, backoff: { fallbackMs: 200, maxMs: 200 } }),
      );

      // Four requests in flight together are told off together: one violation,
      // one penalty. Halving per response would leave concurrency at 1, and
      // then charge 30 clean responses to climb back.
      await Promise.all(Array.from({ length: 4 }, () => hit(http, server.url)));

      expect(server.hits).toBe(4);
      expect(queue.concurrency).toBe(4);
      dispose();
    } finally {
      server.close();
    }
  });

  it('leaves the queue alone when backoff is off', async () => {
    const server = await scripted([{ status: 429 }]);

    try {
      const { queue, http, dispose } = sitePacing(site({ backoff: false }));

      await hit(http, server.url);

      expect(queue.isPaused).toBe(false);
      dispose();
    } finally {
      server.close();
    }
  });

  it('releases a hold when the run is cancelled, so the queue can reach idle', async () => {
    const server = await scripted([{ status: 429, headers: { 'retry-after': '600' } }]);

    try {
      const controller = new AbortController();
      const { queue, http, dispose } = sitePacing(site({ backoff: { maxMs: 30_000 } }), {
        signal: controller.signal,
      });

      await hit(http, server.url);
      expect(queue.isPaused).toBe(true);

      controller.abort(new Error('cancelled'));

      // A paused queue with tasks in it never reaches idle, so a cancelled run
      // in the middle of a hold would otherwise wait out the whole 30 seconds.
      expect(queue.isPaused).toBe(false);
      await queue.onIdle();
      dispose();
    } finally {
      server.close();
    }
  });

  it('rate-limits by a sliding window, reporting when it is waiting', async () => {
    const logs: string[] = [];
    const { queue, dispose } = sitePacing(site({ rateLimit: { requests: 2, perMs: 80 } }), {
      log: (message) => logs.push(message),
    });

    const started: number[] = [];
    const began = Date.now();
    await Promise.all(
      Array.from({ length: 4 }, () => queue.add(() => void started.push(Date.now() - began))),
    );

    expect(started).toHaveLength(4);
    // Two through at once, the rest only after the window moves on.
    expect(started[2]!).toBeGreaterThanOrEqual(70);
    expect(logs).toContain('[example.tv] rate limit reached, waiting for the window');
    dispose();
  });
});

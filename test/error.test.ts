import { HTTPError, NetworkError, TimeoutError } from 'ky';
import { describe, expect, it } from 'vitest';
import {
  causes,
  errorChain,
  errorMessage,
  failureOf,
  MAX_CAUSE_DEPTH,
  unanswered,
} from '../src/core/error.js';

/** A request as ky made it, and the response it got. */
function answered(status: number): HTTPError {
  const request = new Request('https://example.tv/detail/1');

  return new HTTPError(new Response(null, { status }), request, {} as never);
}

describe('errorMessage', () => {
  it('says what went wrong, whatever was thrown — even what cannot be read', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});

    revoke();

    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('nope')).toBe('nope');
    expect(errorMessage(proxy)).toBe('[something that cannot be read]');
    expect(
      errorMessage({
        toString() {
          throw new Error('no');
        },
      }),
    ).toBe('[something that cannot be read]');
  });
});

describe('errorChain', () => {
  it('says what went wrong, and what caused it, down to where nothing did', () => {
    const error = new Error('the lineup could not be read', {
      cause: new TypeError('fetch failed', { cause: 'ECONNRESET' }),
    });

    expect(errorChain(error)).toBe('the lineup could not be read: fetch failed: ECONNRESET');
    expect(errorChain(undefined)).toBe('undefined');
    expect(errorChain('nope')).toBe('nope');
  });

  it('stops at a depth, where a cycle would go for ever — sooner, for one already down a chain', () => {
    const looped = new Error('again');

    (looped as { cause?: unknown }).cause = looped;

    expect(errorChain(looped).split(': ')).toHaveLength(MAX_CAUSE_DEPTH + 1);
    expect(errorChain(looped, 3).split(': ')).toHaveLength(MAX_CAUSE_DEPTH - 2);
    expect(errorChain(looped, MAX_CAUSE_DEPTH + 5)).toBe('again');
  });

  it('says what it can of a chain it cannot read to its end', () => {
    const { proxy, revoke } = Proxy.revocable({}, {});

    revoke();

    const unreadable = Object.defineProperty(new Error('outer'), 'cause', {
      get() {
        throw new Error('no reading this');
      },
    });

    expect(errorChain(new Error('outer', { cause: proxy }))).toBe(
      'outer: [something that cannot be read]',
    );
    expect(errorChain(unreadable)).toBe('outer');
    expect(failureOf(proxy)).toBe('error');
    expect(failureOf(unreadable)).toBe('error');
  });
});

describe('causes', () => {
  it('walks down `cause`, error or not, and stops where there is none', () => {
    const deepest = { reason: 'busy', cause: 'nope' };
    const inner = new Error('inner', { cause: deepest });
    const error = new Error('outer', { cause: inner });

    expect([...causes(error)]).toEqual([error, inner, deepest, 'nope']);
    expect([...causes(undefined)]).toEqual([]);
    expect([...causes('thrown')]).toEqual(['thrown']);
  });

  it('stops at a depth, where a cycle would go for ever', () => {
    const looped = new Error('again');

    (looped as { cause?: unknown }).cause = looped;

    expect([...causes(looped)]).toHaveLength(MAX_CAUSE_DEPTH + 1);
  });
});

describe('failureOf', () => {
  it('names a failure by the status the source answered with', () => {
    expect(failureOf(answered(404))).toBe('404');
    expect(failureOf(answered(503))).toBe('503');
  });

  it('names one nothing answered: a timeout, or the network', () => {
    const request = new Request('https://example.tv/');

    expect(failureOf(new TimeoutError(request))).toBe('timeout');
    expect(failureOf(new NetworkError(request, {} as never))).toBe('network');
    // Node's own, and the signal's.
    expect(failureOf(new TypeError('fetch failed'))).toBe('network');
    expect(failureOf(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }))).toBe(
      'network',
    );
    expect(failureOf(new DOMException('took too long', 'TimeoutError'))).toBe('timeout');
  });

  it('reads a timeout beneath a fetch that failed, as undici and ky leave it', () => {
    const request = new Request('https://example.tv/');

    for (const code of [
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
    ]) {
      const failed = new TypeError('fetch failed', {
        cause: Object.assign(new Error('timed out'), { code }),
      });

      expect(failureOf(failed)).toBe('timeout');
      expect(failureOf(new NetworkError(request, { cause: failed } as never))).toBe('timeout');
    }

    expect(failureOf(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }))).toBe('timeout');
    // Refused beneath it is the network, as is a fetch that says no more.
    expect(
      failureOf(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }),
        }),
      ),
    ).toBe('network');
  });

  it('reads no answer beneath a fetch that says nothing answered', () => {
    const wrapped = new TypeError('fetch failed', {
      cause: Object.assign(new Error('Not Found'), { response: { status: 404 } }),
    });

    expect(failureOf(wrapped)).toBe('network');
    expect(unanswered(wrapped)).toBe(true);

    // Nor on the error that says so, whatever status it carries too.
    const named = Object.assign(new Error('the network failed'), {
      name: 'NetworkError',
      response: { status: 404 },
    });

    expect(failureOf(named)).toBe('network');
    expect(unanswered(named)).toBe(true);
  });

  it('reads the status undici answered with, beside its code', () => {
    // As undici's `request` throws for one, and its retry gives up with.
    const refused = Object.assign(new Error('Response status code 404: Not Found'), {
      name: 'ResponseStatusCodeError',
      code: 'UND_ERR_RESPONSE_STATUS_CODE',
      statusCode: 404,
    });
    const retried = Object.assign(new Error('Request failed'), {
      code: 'UND_ERR_REQ_RETRY',
      statusCode: 503,
    });

    expect(failureOf(refused)).toBe('404');
    expect(unanswered(refused)).toBe(false);
    expect(failureOf(retried)).toBe('503');
    expect(unanswered(retried)).toBe(true);
    // And one of its own that nothing answered, still the network.
    expect(
      failureOf(Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' })),
    ).toBe('network');
  });

  it('reads what a site wrapped, and what a ky of its own threw, for what is underneath', () => {
    expect(failureOf(new Error('no detail for 1', { cause: answered(404) }))).toBe('404');
    // Another copy of ky: a name and a shape, not this package's class.
    expect(failureOf(Object.assign(new Error('Not Found'), { response: { status: 410 } }))).toBe(
      '410',
    );
  });

  it('names anything else an error — a site’s own about an answer it could not use among it', () => {
    expect(
      failureOf(Object.assign(new Error('an empty body'), { response: { status: 200 } })),
    ).toBe('error');
    // Though a status that is no success is the source's, a `304` among them.
    expect(failureOf(Object.assign(new Error('moved'), { statusCode: 302 }))).toBe('302');
    expect(failureOf(answered(304))).toBe('304');
    expect(failureOf(new SyntaxError('Unexpected token < in JSON'))).toBe('error');
    expect(failureOf('nope')).toBe('error');
    expect(failureOf(undefined)).toBe('error');
  });
});

describe('unanswered', () => {
  it('is a source that did not answer, or said not now', () => {
    for (const error of [
      answered(429),
      answered(503),
      answered(408),
      new TypeError('fetch failed'),
      new TimeoutError(new Request('https://example.tv/')),
    ]) {
      expect(unanswered(error)).toBe(true);
    }
  });

  it('is not a source that answered no, nor anything else', () => {
    for (const error of [answered(404), answered(400), new SyntaxError('bad JSON'), 'nope']) {
      expect(unanswered(error)).toBe(false);
    }
  });
});

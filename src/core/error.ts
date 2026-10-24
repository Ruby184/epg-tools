/**
 * Fail the run with a message and an exit code.
 *
 * The XMLTV protocol's error path is always the same shape — one line on
 * stderr, a non-zero exit — so a capability should not have to write the line,
 * remember that stderr is the only place it may go, and then thread a code
 * back through its return value. Throwing this instead says the same thing in
 * one expression, and `runXmltvGrabber` does the rest.
 *
 * It lives here rather than with the grabber because the `epg` CLI reaches the
 * same wall: a configuration that cannot say what a site's password is fails
 * identically whichever command was asked for, and both print one line.
 *
 * It is not for programming errors: those (a bad version string, a capability
 * name that collides) throw `TypeError` and are meant to reach the developer
 * as a stack trace.
 */
export class GrabberError extends Error {
  override readonly name = 'GrabberError';

  /** The process exit code. 1 — a failed run — unless given. */
  readonly code: number;

  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

/**
 * What to put in a log line about something that went wrong.
 *
 * A `catch` binds `unknown`, and a grab logs plenty of them — a failed request,
 * a parse that threw, a site that could not be resolved. The message when there
 * is one, and whatever it was when there is not: a run's log should not be the
 * place a stray `throw 'nope'` becomes a crash.
 */
export function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    // Something that cannot even be read — a revoked proxy, an object whose
    // `toString` throws — said as such, rather than thrown from where it was
    // being said.
    return '[something that cannot be read]';
  }
}

/** How deep a `cause` chain is followed before it is called a cycle. */
export const MAX_CAUSE_DEPTH = 8;

/**
 * `error`, then what caused it, and what caused that — down `cause` wherever
 * there is one, error or not, since a site may hand on anything, and no
 * further than {@link MAX_CAUSE_DEPTH}, where a cycle would go for ever.
 */
export function* causes(error: unknown): Generator<unknown> {
  let current = error;

  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current !== undefined; depth++) {
    yield current;

    if (typeof current !== 'object' || current === null) {
      return;
    }

    try {
      current = (current as { cause?: unknown }).cause;
    } catch {
      // A `cause` that cannot be read — a revoked proxy, a getter that throws
      // — is where the chain ends, rather than a throw from reading it.
      return;
    }
  }
}

/**
 * Statuses that say "not now" rather than "no": asked too often or too early,
 * or a request that took too long. A 5xx says the same, and is read as such
 * below.
 */
const NOT_NOW = new Set([408, 425, 429]);

/** What a refused, dropped or unresolvable connection is called by Node. */
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);

/**
 * What a connection that took too long is called, by Node and by undici —
 * whose `fetch` says `fetch failed` and leaves the timeout to its `cause`.
 */
const TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
]);

/**
 * What a failed request came to: the status the source answered with,
 * `'timeout'` or `'network'` where it did not answer, and `'error'` for
 * anything else — an answer `.json()` could not read, a site's own throw. What
 * `requestsBy` counts a failure under, and what {@link unanswered} decides by.
 *
 * Read down the `cause` chain, so a site that wraps a failed request in an
 * error of its own is still read for what happened underneath. And by name and
 * shape rather than `instanceof`: a site may bring a ky of its own, whose error
 * classes are not the ones this package imports.
 */
export function failureOf(error: unknown): `${number}` | 'timeout' | 'network' | 'error' {
  try {
    return readFailure(error);
  } catch {
    // Whatever was thrown cannot be read — a revoked proxy, a getter that
    // throws — so all that is known is that something was.
    return 'error';
  }
}

/** {@link failureOf}, reading what may throw for being read. */
function readFailure(error: unknown): `${number}` | 'timeout' | 'network' | 'error' {
  /** Said where nothing answered, unless what is beneath says it timed out. */
  let unanswering: 'network' | undefined;

  for (const current of causes(error)) {
    if (typeof current !== 'object' || current === null) {
      break;
    }

    const candidate = current as {
      name?: unknown;
      message?: unknown;
      code?: unknown;
      response?: { status?: unknown };
      statusCode?: unknown;
    };
    // ky's, on the response it answered with — or undici's own, whose errors
    // for a status carry it beside their code. One that is not a success, as
    // ky throws for: a site's own error about a `200` it could not use is the
    // site's.
    const answered =
      typeof candidate.response?.status === 'number'
        ? candidate.response.status
        : typeof candidate.statusCode === 'number'
          ? candidate.statusCode
          : undefined;
    const status = answered !== undefined && answered >= 300 ? answered : undefined;

    if (candidate.name === 'TimeoutError') {
      return 'timeout';
    }

    // Nothing answered — and how, its cause may say: undici's timeouts arrive
    // as a `fetch failed`, and ky wraps that in a `NetworkError`. Read before
    // a status on the same error, as it is before one beneath it.
    if (
      candidate.name === 'NetworkError' ||
      (candidate.name === 'TypeError' && candidate.message === 'fetch failed')
    ) {
      unanswering = 'network';
    }

    // An answer, whatever else is below it — unless what is above it, or the
    // error itself, says nothing answered, which a status cannot undo.
    if (unanswering === undefined && status !== undefined) {
      return `${status}`;
    }

    if (typeof candidate.code === 'string') {
      if (TIMEOUT_CODES.has(candidate.code)) {
        return 'timeout';
      }

      if (NETWORK_CODES.has(candidate.code) || candidate.code.startsWith('UND_ERR_')) {
        return 'network';
      }
    }
  }

  return unanswering ?? 'error';
}

/**
 * Whether an error means the source did not answer — the network failed, the
 * request timed out, or the source said "not now" (408, 425, 429, a 5xx) —
 * rather than that it answered and what it said was wrong. Read as
 * {@link failureOf} reads it.
 */
export function unanswered(error: unknown): boolean {
  const failure = failureOf(error);

  if (failure === 'timeout' || failure === 'network') {
    return true;
  }

  const status = Number(failure);

  return NOT_NOW.has(status) || status >= 500;
}

/**
 * The same, with what caused it, and what caused that.
 *
 * {@link errorMessage} reads `.message` and nothing else, which makes a chain
 * unreachable — and a grab builds them: "the source says this channel-day is
 * unchanged, but nothing is cached for it" has the 304 that said so underneath,
 * and reading only the top of that leaves the reader with the conclusion and
 * none of the evidence. Kept out of the default line because a chain per
 * failure is noise until you are looking for one.
 */
export function errorChain(
  error: unknown,
  /** How far down a chain `error` is already, of the {@link MAX_CAUSE_DEPTH} followed. */
  depth = 0,
): string {
  // Something, however little: `undefined` thrown is said as itself.
  return error === undefined
    ? errorMessage(error)
    : [...causes(error)]
        .slice(0, Math.max(1, MAX_CAUSE_DEPTH - depth + 1))
        .map(errorMessage)
        .join(': ');
}

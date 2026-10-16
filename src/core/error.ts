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
  return error instanceof Error ? error.message : String(error);
}

/** How deep a `cause` chain is followed before it is called a cycle. */
export const MAX_CAUSE_DEPTH = 8;

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
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
]);

/**
 * Whether an error means the source did not answer — the network failed, the
 * request timed out, or the source said "not now" (408, 425, 429, a 5xx) —
 * rather than that it answered and what it said was wrong.
 *
 * Read down the `cause` chain, so a site that wraps a failed request in an
 * error of its own is still read for what happened underneath. And by name and
 * shape rather than `instanceof`: a site may bring a ky of its own, whose error
 * classes are not the ones this package imports.
 */
export function unanswered(error: unknown): boolean {
  let current = error;

  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth++) {
    if (typeof current !== 'object' || current === null) {
      return false;
    }

    const candidate = current as {
      name?: unknown;
      message?: unknown;
      code?: unknown;
      response?: { status?: unknown };
      cause?: unknown;
    };

    if (candidate.name === 'NetworkError' || candidate.name === 'TimeoutError') {
      return true;
    }

    // An answer, whatever else is below it: its status says which kind.
    if (typeof candidate.response?.status === 'number') {
      return NOT_NOW.has(candidate.response.status) || candidate.response.status >= 500;
    }

    if (
      (candidate.name === 'TypeError' && candidate.message === 'fetch failed') ||
      (typeof candidate.code === 'string' &&
        (NETWORK_CODES.has(candidate.code) || candidate.code.startsWith('UND_ERR_')))
    ) {
      return true;
    }

    current = candidate.cause;
  }

  return false;
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
export function errorChain(error: unknown, depth = 0): string {
  const message = errorMessage(error);
  const cause = error instanceof Error ? error.cause : undefined;

  return cause === undefined || depth >= MAX_CAUSE_DEPTH
    ? message
    : `${message}: ${errorChain(cause, depth + 1)}`;
}

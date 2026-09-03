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

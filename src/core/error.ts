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

/**
 * Writing text a command has to be sure of.
 *
 * Both entry points — the `epg` CLI and a `tv_grab_*` grabber — end by handing
 * an exit code back to whoever called them, and a caller that then exits must
 * not lose the last line. On POSIX a piped stdout is asynchronous, so `write()`
 * alone only queues the bytes: `process.exit()` discards whatever is still
 * queued, and a slow reader gets no backpressure. So a command either awaits
 * what it writes, or queues it and drains once before resolving.
 */

import type { Writable } from 'node:stream';

/**
 * One line, queued rather than awaited — for progress and per-failure
 * messages, which a run should not pause for. The {@link drain} at the end of
 * the run is what keeps them from being lost.
 */
export function queueLine(stream: Writable, line: string): void {
  stream.write(`${line}\n`);
}

/**
 * Write and wait for the chunk to be flushed, so a caller is free to exit as
 * soon as the run resolves.
 */
export function writeFlushed(stream: Writable, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(text, (error) => error ? reject(error) : resolve());
  });
}

/**
 * Write whole lines, each terminated for you, and wait for them to be flushed.
 *
 * Everything a command puts on stdout outside a document is a list of lines —
 * one capability per line, two version lines, one description — and every
 * message on stderr is one line, so the terminator is never the caller's
 * decision to make.
 */
export function writeLines(stream: Writable, ...lines: string[]): Promise<void> {
  return writeFlushed(stream, lines.map((line) => `${line}\n`).join(''));
}

/**
 * Wait for everything already written to a stream to be flushed.
 *
 * A zero-length write is ordered behind the chunks queued before it, so this
 * one call covers every unawaited write in the run — progress lines, and
 * whatever a capability put on stderr — without each of them being awaited.
 *
 * Deliberately not the `drain` event, which is emitted only after a `write()`
 * that returned false: a command whose output never fills the buffer — the
 * usual case, a handful of short lines — would wait for an event that is never
 * emitted. That event answers "may I write more?"; this answers "is what I
 * wrote out?".
 *
 * Best effort by design: a reader that has already gone away (`… | head`) must
 * not turn a finished run into a rejection.
 */
export function drain(stream: Writable): Promise<void> {
  return new Promise((resolve) => {
    stream.write('', () => resolve());
  });
}

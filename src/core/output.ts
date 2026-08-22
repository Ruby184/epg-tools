/**
 * Where a document is written: a path, or a stream someone already has.
 *
 * Three destinations behave differently in ways a caller should not have to
 * remember, so they all resolve to one thing — a stream to write and whether
 * it may be closed:
 *
 * - a **file** is written [atomically](./atomic.ts): beside its own path, and
 *   renamed into place when the writing ends, so a reader never sees a
 *   half-written guide and a crash leaves the previous one intact;
 * - a **socket** is connected to and closed, which is how tvheadend's
 *   *External XMLTV* module takes a guide: it listens, reads until the writer
 *   closes, and parses what it got. Writing a regular file over that path
 *   would silently do nothing useful, so a path that *is* a socket is read as
 *   one rather than needing an option to say so;
 * - a **stream** we were handed — stdout, or a test's sink — is written to but
 *   never closed, since it is not ours to end.
 */

import { once } from 'node:events';
import { stat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import path from 'node:path';
import { Writable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { atomicFile } from './atomic.js';

/** An output that cannot be written: no socket there, or nobody listening. */
export class OutputError extends Error {
  override readonly name = 'OutputError';
}

/** A path to write, or a stream to write to. */
export type OutputTarget = string | Writable;

export interface OutputSink {
  /**
   * Where the document goes — and whoever takes it owns its errors. A stream
   * opened with a signal that has already fired arrives destroyed, so the
   * `error` it is about to emit needs somewhere to go. {@link writeOutput} has
   * `pipeline` see to that.
   */
  stream: Writable;
  /** Whether writing may close it — false for a stream we were handed. */
  end: boolean;
}

/**
 * The length a socket path may not exceed. The address is a fixed-size field
 * in the kernel — 108 bytes including the terminator on Linux, less on some
 * BSDs — and going over it fails as a plain `EINVAL`, which says nothing about
 * the actual problem.
 */
const SOCKET_PATH_MAX = 103;

/** Say what went wrong in terms of the path, not of errno. */
function explain(error: NodeJS.ErrnoException, socketPath: string): string {
  if (error.name === 'AbortError') {
    return 'cancelled';
  }

  if (error.code === 'ECONNREFUSED') {
    return 'nothing is listening on it';
  }

  const length = Buffer.byteLength(socketPath);

  if (error.code === 'EINVAL' && length > SOCKET_PATH_MAX) {
    return `its path is ${length} bytes, past the ~${SOCKET_PATH_MAX} an address field holds`;
  }

  return error.message;
}

/**
 * Connect, naming the failure a caller can act on. `label` is what to call it.
 *
 * A connection is the one part of opening an output that can sit there: the
 * path exists and something is bound to it, but nothing is reading. So a
 * cancelled run gives up on it rather than waiting to be refused.
 */
async function connect(socketPath: string, label: string, signal?: AbortSignal): Promise<Socket> {
  // The socket takes the signal itself: aborting destroys it and raises an
  // `AbortError` where a refused connection would arrive, whether the abort
  // comes while waiting or was there before we asked.
  const socket = createConnection({ path: socketPath, signal });

  try {
    // `once` rejects on `error` for any event but that one, and takes both of
    // its listeners away whichever fires — so there is no pair of handlers here
    // to keep in step, and no `removeAllListeners` reaching for someone else's.
    await once(socket, 'connect');
  } catch (error) {
    throw new OutputError(
      `Cannot write to socket ${label}: ${explain(error as NodeJS.ErrnoException, socketPath)}`,
    );
  }

  return socket;
}

/** Is this path an existing socket? A path that is not there yet is a file. */
async function isSocket(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isSocket();
  } catch {
    return false;
  }
}

/** What a caller may say about writing, beyond where it goes. */
export interface OutputOptions {
  /**
   * Give up on the write. A file being written is discarded rather than taking
   * the place of whatever is already there, which is the whole point of writing
   * it beside its own path first; a socket is connected to no longer, or closed
   * part-written, and the reader on the other end learns what it always would
   * from a writer that stopped.
   */
  signal?: AbortSignal;
}

/** Resolve a target to a stream, and to whether finishing it means closing it. */
export async function openOutput(
  target: OutputTarget,
  options: OutputOptions = {},
): Promise<OutputSink> {
  if (typeof target !== 'string') {
    return { stream: target, end: false };
  }

  const resolved = path.resolve(target);

  if (!(await isSocket(resolved))) {
    return { stream: atomicFile(resolved, options.signal), end: true };
  }

  // Connect by whichever name is shorter. A socket bound from a deep working
  // directory as `./x.sock` is reachable, while the same file named absolutely
  // is past what an address field holds — resolving it would be the only
  // reason the connection failed.
  return {
    stream: await connect(
      target.length < resolved.length ? target : resolved,
      resolved,
      options.signal,
    ),
    end: true,
  };
}

/** Write a document to wherever `target` says. */
export async function writeOutput(
  target: OutputTarget,
  source: AsyncIterable<string> | Iterable<string>,
  options: OutputOptions = {},
): Promise<void> {
  const sink = await openOutput(target, options);

  try {
    // The signal goes to the pipeline as well as to the source that feeds it:
    // a source of its own may be a plain array, or a generator that never
    // thought to ask, and a write is exactly as long as what it is writing.
    await pipeline(source, sink.stream, { end: sink.end, signal: options.signal });
  } catch (error) {
    // A failing or cancelled write rejects the moment it fails, while the
    // stream is still tearing down — and tearing down is what takes the temp
    // file away. Waiting for it is the difference between "the write failed"
    // and "the write failed and may still have left something behind".
    //
    // `finished` rather than `once(stream, 'close')`: that one rejects on
    // `error`, and a stream torn down by a failure or an abort emits one
    // *before* it closes, so the wait was abandoned exactly when it mattered —
    // whenever the error happened to land after the line rather than before it.
    // A race, and so a temp file left behind now and then rather than every
    // time. This settles after `close` either way, and `cleanup` leaves none of
    // its listeners on a stream that is already done with.
    if (sink.end && !sink.stream.closed) {
      await finished(sink.stream, { cleanup: true }).catch(() => {});
    }

    throw error;
  }
}

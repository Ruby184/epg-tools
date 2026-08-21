/**
 * Where a document is written: a path, or a stream someone already has.
 *
 * Three destinations behave differently in ways a caller should not have to
 * remember, so they all resolve to one thing — a stream to write and whether
 * it may be closed:
 *
 * - a **file** goes to `<path>.tmp-<random>` and renames itself into place
 *   when the writing ends, so a reader never sees a half-written guide and a
 *   crash leaves the previous one intact;
 * - a **socket** is connected to and closed, which is how tvheadend's
 *   *External XMLTV* module takes a guide: it listens, reads until the writer
 *   closes, and parses what it got. Writing a regular file over that path
 *   would silently do nothing useful, so a path that *is* a socket is read as
 *   one rather than needing an option to say so;
 * - a **stream** we were handed — stdout, or a test's sink — is written to but
 *   never closed, since it is not ours to end.
 */

import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import { rmdir, stat, unlink } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** An output that cannot be written: no socket there, or nobody listening. */
export class OutputError extends Error {
  override readonly name = 'OutputError';
}

/** A path to write, or a stream to write to. */
export type OutputTarget = string | Writable;

export interface OutputSink {
  /** Where the document goes. */
  stream: Writable;
  /** Whether writing may close it — false for a stream we were handed. */
  end: boolean;
}

/**
 * A stream that writes beside the file it is for and takes its place once the
 * document is complete, so a reader never sees half a guide and a failure
 * leaves whatever was already there.
 *
 * Both halves hang off the file operations rather than the stream: the
 * directory is made as part of opening, so there is no separate step to await
 * and no order to get wrong, and closing is where the write becomes final —
 * the one moment that comes whether the stream ended or was destroyed.
 */
function atomicFile(file: string): fs.WriteStream {
  const dir = path.dirname(file);
  // Random suffix, so concurrent builds never clobber each other's temp file.
  const tmpPath = `${file}.tmp-${randomBytes(6).toString('hex')}`;
  // The topmost directory `mkdir` had to create, which is how far back a
  // failed write may undo itself. `undefined` when the path already existed.
  let created: string | undefined;

  /** Take back a write that never happened, and the path made to hold it. */
  const discard = async (): Promise<void> => {
    await unlink(tmpPath).catch(() => {});

    // Deepest first, one level at a time. A recursive remove would be wrong
    // here — `recursive` deletes the children too, so a directory another
    // process had since put a file in would go with it, and `force` only
    // suppresses "not there". Plain `rmdir` refuses a non-empty directory,
    // which is the guard wanted; stopping at `created` keeps this to what the
    // write itself made.
    for (let current = dir; created !== undefined; current = path.dirname(current)) {
      try {
        await rmdir(current);
      } catch {
        return;
      }

      if (current === created) {
        return;
      }
    }
  };

  const stream = fs.createWriteStream(tmpPath, {
    // Sync the data out before the descriptor is closed, which is to say
    // before the rename below. Without it the rename can reach the disk first
    // and a crash leaves an empty file where a complete guide used to be.
    flush: true,
    fs: {
      ...fs,
      open(filePath, flags, mode, callback) {
        fs.mkdir(dir, { recursive: true }, (error, firstCreated) => {
          if (error) {
            callback(error, -1);
            return;
          }

          created = firstCreated;
          fs.open(filePath, flags, mode, callback);
        });
      },
      close(fd, callback) {
        fs.close(fd, (error) => {
          if (error) {
            callback(error);
            return;
          }

          // Destroyed rather than ended: the document is incomplete, so it
          // goes away instead of taking the real file's place, and so does
          // any directory that was made only to hold it.
          if (!stream.writableFinished) {
            discard()
              .catch(() => {})
              .finally(() => callback(null));
            return;
          }

          fs.rename(tmpPath, file, callback);
        });
      },
    },
  });

  return stream;
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
  if (error.code === 'ECONNREFUSED') {
    return 'nothing is listening on it';
  }

  const length = Buffer.byteLength(socketPath);

  if (error.code === 'EINVAL' && length > SOCKET_PATH_MAX) {
    return `its path is ${length} bytes, past the ~${SOCKET_PATH_MAX} an address field holds`;
  }

  return error.message;
}

/** Connect, naming the failure a caller can act on. `label` is what to call it. */
function connect(socketPath: string, label: string): Promise<Socket> {
  const socket = createConnection({ path: socketPath });

  return new Promise((resolve, reject) => {
    socket.once('connect', () => {
      socket.removeAllListeners('error');
      resolve(socket);
    });

    socket.once('error', (error: NodeJS.ErrnoException) => {
      reject(new OutputError(`Cannot write to socket ${label}: ${explain(error, socketPath)}`));
    });
  });
}

/** Is this path an existing socket? A path that is not there yet is a file. */
async function isSocket(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isSocket();
  } catch {
    return false;
  }
}

/** Resolve a target to a stream, and to whether finishing it means closing it. */
export async function openOutput(target: OutputTarget): Promise<OutputSink> {
  if (typeof target !== 'string') {
    return { stream: target, end: false };
  }

  const resolved = path.resolve(target);

  if (!(await isSocket(resolved))) {
    return { stream: atomicFile(resolved), end: true };
  }

  // Connect by whichever name is shorter. A socket bound from a deep working
  // directory as `./x.sock` is reachable, while the same file named absolutely
  // is past what an address field holds — resolving it would be the only
  // reason the connection failed.
  return {
    stream: await connect(target.length < resolved.length ? target : resolved, resolved),
    end: true,
  };
}

/** Write a document to wherever `target` says. */
export async function writeOutput(
  target: OutputTarget,
  source: AsyncIterable<string> | Iterable<string>,
): Promise<void> {
  const sink = await openOutput(target);

  try {
    await pipeline(source, sink.stream, { end: sink.end });
  } catch (error) {
    // A failing source rejects the moment it fails, while the stream is still
    // tearing down — and tearing down is what takes the temp file away.
    // Waiting for it is the difference between "the write failed" and "the
    // write failed and may still have left something behind".
    if (sink.end && !sink.stream.closed) {
      await once(sink.stream, 'close').catch(() => {});
    }

    throw error;
  }
}

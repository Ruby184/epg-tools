/**
 * Writing a file so that a reader never sees half of one.
 *
 * The invariant is the same wherever it is used: write beside the real path,
 * then rename over it — a rename is atomic, so the file is either the old one
 * or the new one and never a partial. What differs is what is being written,
 * and the two shapes here are the two answers to that:
 *
 * - {@link atomicFile} is a **stream**, for a document as long as a guide. It
 *   makes the directory it needs, takes the directory away again if the write
 *   comes to nothing, and syncs the data out before the rename.
 * - {@link writeFileAtomic} takes a **string** that is already in hand, for the
 *   thousands of small entries a cache is made of. It syncs nothing and makes
 *   no directory, because at that many writes both cost more than they are
 *   worth: an `fsync` each is around eight times the total cost of the write,
 *   and a `mkdir -p` before every one of 7,000 entries is a quarter of a second
 *   spent learning what the caller already knew.
 *
 * The asymmetry is the point, so it is written down here rather than left to
 * look like an oversight in one of the two.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Where the write goes until it is finished. Random rather than pid- or
 * counter-based, so two runs writing the same output never share one.
 */
export function tempName(file: string): string {
  return `${file}.tmp-${randomBytes(6).toString('hex')}`;
}

/**
 * Write `data` to `file` through a temporary name, leaving nothing behind if it
 * fails. The directory must exist — see the note above.
 */
export async function writeFileAtomic(
  file: string,
  data: string,
  signal?: AbortSignal,
): Promise<void> {
  const tmp = tempName(file);

  try {
    // The write takes the signal; the rename does not, deliberately. It is the
    // moment the file becomes real, and half of it cannot happen — so once the
    // data is down, finishing costs one syscall and leaves nothing behind.
    await writeFile(tmp, data, { encoding: 'utf8', signal });
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
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
export function atomicFile(file: string, signal?: AbortSignal): fs.WriteStream {
  const dir = path.dirname(file);
  const tmpPath = tempName(file);
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
    // Its own, rather than only the one the write is piped with: aborting
    // destroys the stream, and destroying it is what takes the temp file away —
    // including when the abort lands between opening this and writing to it.
    signal,
    // Sync the data out before the descriptor is closed, which is to say
    // before the rename below. Without it the rename can reach the disk first
    // and a crash leaves an empty file where a complete guide used to be.
    flush: true,
    fs: {
      ...fs,
      open(filePath, flags, mode, callback) {
        // Over before this was reached, which is what an abort landing early
        // looks like: a stream closed before it ever took a descriptor never
        // calls `close` below, so a file made now would be made for nobody and
        // left for nobody to remove. The way to leave nothing behind is to make
        // nothing — and nothing is waiting to hear about it, which is the one
        // reason this returns without answering the callback: `closed` means the
        // destroy that emitted it has finished.
        //
        // An abort *during* the work below needs none of this. A stream that
        // has begun opening is one Node waits for before it finishes destroying
        // — so the descriptor becomes the stream's, `close` is called, and the
        // discard there is what undoes it.
        if (stream.closed) {
          return;
        }

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

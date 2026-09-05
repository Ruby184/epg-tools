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
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import path from 'node:path';
import { PassThrough, Writable, type Readable, type Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';
import { atomicFile } from './atomic.js';

/** An output that cannot be written: no socket there, or nobody listening. */
export class OutputError extends Error {
  override readonly name = 'OutputError';
}

/** A path to write, or a stream to write to. */
export type OutputTarget = string | Writable;

/** What a document can be compressed with on the way out. */
export type CompressionFormat = 'gzip' | 'brotli' | 'zstd';

/** A format, and how hard to work at it — on that format's own scale. */
export interface CompressionOptions {
  format: CompressionFormat;
  level?: number;
}

/**
 * What each extension promises whoever finds the file, which is what makes it
 * the answer rather than a guess.
 */
const BY_EXTENSION: Record<string, CompressionFormat | undefined> = {
  '.gz': 'gzip',
  '.br': 'brotli',
  '.zst': 'zstd',
};

/**
 * The format a name promises, if it promises one — `.gz`, `.br`, `.zst`.
 *
 * The same table both ways: what a guide written to `guide.xml.gz` is
 * compressed with, and what one *read* from a url ending the same way is likely
 * to hold. Likely, because a name is a promise rather than a fact — see
 * `defineXmltvSite`, which sniffs the bytes and keeps this for the one format
 * that cannot be sniffed.
 */
export function compressionFromName(name: string): CompressionFormat | undefined {
  return BY_EXTENSION[path.extname(name).toLowerCase()];
}

/**
 * The stream that undoes one format — the mirror of {@link compressor}.
 *
 * Nothing to say about levels: a decompressor takes what it is given.
 */
export function decompressor(format: CompressionFormat): Transform {
  switch (format) {
    case 'gzip':
      return zlib.createGunzip();
    case 'brotli':
      return zlib.createBrotliDecompress();
    default:
      // Newer than this package's floor, as on the way out.
      if (typeof zlib.createZstdDecompress !== 'function') {
        throw new OutputError('Reading zstd needs Node 22.15 or newer (23.8 in the 23.x line)');
      }

      return zlib.createZstdDecompress();
  }
}

/**
 * The bytes of a guide on disk, decompressed by what its name promises.
 *
 * One helper rather than three copies: `epg validate`, `epg filter` and
 * `--channels` all want exactly this, and a fourth format would otherwise have
 * to be remembered in three places.
 *
 * `compression` overrides the name — `false` for "plain, whatever it is called",
 * which is what a config's own `compress: false` means about its output.
 *
 * `pipeline` rather than `.pipe`, so a truncated member or a missing file
 * reaches the reader as an error instead of an early end: a guide that stops
 * short otherwise looks exactly like a small one.
 */
export function guideBytes(file: string, compression?: CompressionFormat | false): Readable {
  const format =
    compression === undefined
      ? compressionFromName(file)
      : compression === false
        ? undefined
        : compression;
  const bytes = createReadStream(file);

  if (format === undefined) {
    return bytes;
  }

  const out = new PassThrough();

  pipeline(bytes, decompressor(format), out).catch((error: unknown) => {
    out.destroy(error as Error);
  });

  return out;
}

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
  /**
   * Compress what is written.
   *
   * A path whose name says which — `.gz`, `.br`, `.zst` — is taken as asking for
   * it, since that is what the name promises whoever finds the file. So this is
   * for what a name cannot say: a format for a socket or a stream, `false` to
   * write a plain document to a compressed-sounding path anyway, and `{ level }`
   * to choose how hard to try.
   *
   * A guide is enormously compressible, which is worth having when it is served
   * over a network or kept as a fortnight of days. Check what reads it first: a
   * consumer reading `xmltv.xml` off disk usually copes with gzip, fewer with
   * the other two, and tvheadend's socket wants the document itself.
   */
  compress?: CompressionFormat | false | CompressionOptions;
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
  //
  // In bytes, because that is what the kernel counts: a relative path of
  // accented or CJK characters can be fewer UTF-16 units than the absolute one
  // and more of what actually has to fit.
  return {
    stream: await connect(
      Buffer.byteLength(target) < Buffer.byteLength(resolved) ? target : resolved,
      resolved,
      options.signal,
    ),
    end: true,
  };
}

/**
 * The compression a write should go through, if any.
 *
 * The name decides by default, because a file called `.gz` that is not gzip is
 * a worse outcome than either — and the extension is the one thing about the
 * destination a caller has already said. An explicit format outranks it, in both
 * directions.
 */
function compressorFor(
  target: OutputTarget,
  compress: OutputOptions['compress'],
): Transform | undefined {
  if (compress === false) {
    return undefined;
  }

  const asked = typeof compress === 'object' ? compress : compress && { format: compress };
  const format =
    asked?.format ??
    (typeof target === 'string' ? BY_EXTENSION[path.extname(target).toLowerCase()] : undefined);

  return format === undefined ? undefined : compressor(format, asked?.level);
}

/** A compressor's own knob for how hard to try. */
function params(key: number, level: number): { params: Record<number, number> } {
  return { params: { [key]: level } };
}

/**
 * The quality brotli is asked for when nobody says.
 *
 * Not brotli's own default, which is 11 and takes **six and a half minutes** on
 * a 92 MiB guide — long enough that a nightly build looks hung. Quality 7 takes
 * 5.6 seconds, which is what gzip spends, and leaves 0.63 MiB against gzip's
 * 2.60. Above it the curve turns vertical: 10 costs 34 seconds to save 50 KiB,
 * and 11 the rest of the afternoon to save 130.
 *
 * A default, not a ceiling — ask for `{ level: 11 }` and it is yours.
 */
const BROTLI_QUALITY = 7;

/**
 * The stream for one format, with `level` said the way that format says it.
 *
 * One option, three scales, and no pretence otherwise: 0–9 for gzip, 0–11 for
 * brotli, 1–22 for zstd. Remapping them onto a shared range would only mean
 * nobody could ask their format for what it actually offers.
 *
 * Exported because a write to a file is not the only place a guide is
 * compressed: `epg serve` negotiates one over HTTP and needs the same stream,
 * built the same way, so a served guide and a written one cannot differ in what
 * `{ level }` means.
 */
export function compressor(format: CompressionFormat, level?: number): Transform {
  switch (format) {
    case 'gzip':
      return zlib.createGzip({ level });
    case 'brotli':
      return zlib.createBrotliCompress(
        params(zlib.constants.BROTLI_PARAM_QUALITY, level ?? BROTLI_QUALITY),
      );
    default:
      // Newer than this package's floor — Node 22.15, or 23.8 in the 23.x line —
      // so it is asked for rather than assumed, and says what it wants rather
      // than failing as "createZstdCompress is not a function".
      if (typeof zlib.createZstdCompress !== 'function') {
        throw new OutputError(
          'Compressing with zstd needs Node 22.15 or newer (23.8 in the 23.x line)',
        );
      }

      // Left at zstd's own default of 3, which is already 99 times smaller in
      // less time than gzip takes: nothing to improve on by guessing.
      return zlib.createZstdCompress(
        level === undefined ? {} : params(zlib.constants.ZSTD_c_compressionLevel, level),
      );
  }
}

/** Write a document to wherever `target` says. */
export async function writeOutput(
  target: OutputTarget,
  source: AsyncIterable<string> | Iterable<string>,
  options: OutputOptions = {},
): Promise<void> {
  const sink = await openOutput(target, options);
  const compressor = compressorFor(target, options.compress);
  const chain =
    compressor === undefined
      ? ([source, sink.stream] as const)
      : ([source, compressor, sink.stream] as const);

  try {
    // The signal goes to the pipeline as well as to the source that feeds it:
    // a source of its own may be a plain array, or a generator that never
    // thought to ask, and a write is exactly as long as what it is writing.
    //
    // `end` is the last stream's, so a handed-in stream stays open while the
    // compressor between them is finished off — which is what flushes it.
    //
    // One call whatever the chain holds: `pipeline` takes an array, and reads an
    // iterable in it exactly as it does a positional one — `as const` is what
    // makes those two shapes tuples rather than arrays, which is all the
    // overload wanted. The source stays the iterable it was rather than becoming
    // a `Readable.from`, which would put a stream between the signal and the
    // generator it cancels.
    await pipeline(chain, { end: sink.end, signal: options.signal });
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

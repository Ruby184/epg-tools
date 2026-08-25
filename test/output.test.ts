import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { promisify } from 'node:util';
import {
  brotliDecompress as brotliCallback,
  gunzip as gunzipCallback,
  zstdDecompress as zstdCallback,
} from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import { openOutput, writeOutput } from '../src/core/output.js';

const gunzip = promisify(gunzipCallback);
const brotli = promisify(brotliCallback);
/** Newer than this package's floor, so the tests either side of it are skipped. */
const zstd = zstdCallback === undefined ? undefined : promisify(zstdCallback);

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'epg-output-test-'));
}

describe('writeOutput', () => {
  it('creates the directory it needs and renames into place', async () => {
    const dir = await tempDir();
    const output = join(dir, 'nested', 'guide.xml');

    await writeOutput(output, ['<tv>', '</tv>']);

    expect(await readFile(output, 'utf8')).toBe('<tv></tv>');
    // Renamed into place, with no temp file left beside it.
    expect(await readdir(join(dir, 'nested'))).toEqual(['guide.xml']);
  });

  it('cleans up after a stream that is opened and never written', async () => {
    const dir = await tempDir();
    const output = join(dir, 'guide.xml');
    const sink = await openOutput(output);

    sink.stream.destroy();
    await new Promise<void>((resolve) => sink.stream.once('close', resolve));

    // The temp file the stream opened goes with it; the output was never made.
    expect(await readdir(dir)).toEqual([]);
  });

  it('makes nothing at all when the abort beats the open', async () => {
    const dir = await tempDir();
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    // Destroyed before it can take a descriptor, so `close` comes before the
    // open hook has even been entered — the ordering that used to leave a
    // 0-byte temp file behind for nobody, because the open went on to make one
    // after the stream was gone. Now the open is refused instead, so there is
    // nothing to clean up and nothing to wait for.
    const sink = await openOutput(join(dir, 'nested', 'guide.xml'), {
      signal: controller.signal,
    });
    // A stream handed over is the caller's to listen to, and this one is
    // destroyed on arrival — `writeOutput` has `pipeline` do it.
    sink.stream.on('error', () => {});

    expect(sink.stream.closed).toBe(true);
    // Long enough that the open would have made its file by now if it were
    // going to — it has already been skipped for the same reason.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await readdir(dir)).toEqual([]);
  });

  describe('gzip', () => {
    /** What a reader of the file would do with it. */
    async function gunzipped(file: string): Promise<string> {
      return (await gunzip(await readFile(file))).toString('utf8');
    }

    it('compresses a path that says it is compressed', async () => {
      const dir = await tempDir();
      const output = join(dir, 'guide.xml.gz');

      await writeOutput(output, ['<tv>', '<programme/>', '</tv>']);

      // The name is the ask: a file called `.gz` that is not gzip is worse than
      // either answer. The bytes are gzip's, starting with its magic number.
      const bytes = await readFile(output);

      expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0x1f, 0x8b, 0x08]));
      expect(await gunzipped(output)).toBe('<tv><programme/></tv>');
      expect(await readdir(dir)).toEqual(['guide.xml.gz']);
    });

    it('takes an explicit answer over the name, in both directions', async () => {
      const dir = await tempDir();
      const named = join(dir, 'named.xml.gz');
      const plain = join(dir, 'plain.xml');

      await writeOutput(named, ['<tv></tv>'], { compress: false });
      await writeOutput(plain, ['<tv></tv>'], { compress: 'gzip' });

      expect(await readFile(named, 'utf8')).toBe('<tv></tv>');
      expect(await gunzipped(plain)).toBe('<tv></tv>');
    });

    it('compresses harder or quicker when asked', async () => {
      const dir = await tempDir();
      // Programme-shaped text, because the levels differ on prose repeated at a
      // distance: over 500 bare `<programme id="n"/>` elements level 1 comes out
      // *smaller* than level 9, which says more about the document than the flag.
      const document = [
        '<tv>',
        ...Array.from(
          { length: 200 },
          (_, i) =>
            `<programme start="2026071720${String(i % 60).padStart(2, '0')}00 +0200" ` +
            `channel="one.example.tv"><title lang="sk">Programme number ${i}</title>` +
            `<desc lang="sk">A description of about the length a real one has, with words ` +
            `that repeat across the document often enough for a level to matter.</desc></programme>`,
        ),
        '</tv>',
      ];
      const quick = join(dir, 'quick.xml.gz');
      const small = join(dir, 'small.xml.gz');

      await writeOutput(quick, document, { compress: { format: 'gzip', level: 1 } });
      await writeOutput(small, document, { compress: { format: 'gzip', level: 9 } });

      expect(await gunzipped(quick)).toBe(await gunzipped(small));
      expect((await stat(small)).size).toBeLessThan((await stat(quick)).size);
    });

    it('reads .br as asking for brotli', async () => {
      const dir = await tempDir();
      const output = join(dir, 'guide.xml.br');

      await writeOutput(output, ['<tv>', '<programme/>', '</tv>']);

      expect((await brotli(await readFile(output))).toString('utf8')).toBe('<tv><programme/></tv>');
    });

    it.skipIf(zstd === undefined)('reads .zst as asking for zstd', async () => {
      const dir = await tempDir();
      const output = join(dir, 'guide.xml.zst');

      await writeOutput(output, ['<tv>', '<programme/>', '</tv>']);

      expect((await zstd!(await readFile(output))).toString('utf8')).toBe('<tv><programme/></tv>');
    });

    it.skipIf(zstd !== undefined)('says what zstd needs where the runtime has none', async () => {
      const dir = await tempDir();

      await expect(writeOutput(join(dir, 'guide.xml.zst'), ['<tv></tv>'])).rejects.toThrow(
        /zstd needs Node 22.15 or newer/,
      );
    });

    it('asks brotli for a quality a guide can wait for', async () => {
      const dir = await tempDir();
      const document = Array.from({ length: 300 }, (_, i) => `<programme id="${i}">x</programme>`);
      const byDefault = join(dir, 'default.xml.br');
      const asked = join(dir, 'asked.xml.br');

      await writeOutput(byDefault, document);
      await writeOutput(asked, document, { compress: { format: 'brotli', level: 7 } });

      // Brotli's own default is quality 11, which on a 92 MiB guide takes six
      // and a half minutes — so this asks for 7, and that is what the bytes say.
      expect(await readFile(byDefault)).toEqual(await readFile(asked));
    });

    it('compresses into a stream it was handed, without ending it', async () => {
      const chunks: Buffer[] = [];
      let ended = false;
      const sink = new Writable({
        write(chunk: Buffer, _encoding, done) {
          chunks.push(Buffer.from(chunk));
          done();
        },
        final(done) {
          ended = true;
          done();
        },
      });

      await writeOutput(sink, ['<tv>', '</tv>'], { compress: 'gzip' });

      // The compressor is finished off — which is what flushes it — while the
      // stream it feeds is left open, since it was never ours to end.
      expect((await gunzip(Buffer.concat(chunks))).toString('utf8')).toBe('<tv></tv>');
      expect(ended).toBe(false);
    });

    it('leaves nothing behind when a compressed write is cancelled', async () => {
      const dir = await tempDir();
      const controller = new AbortController();

      async function* endless(): AsyncGenerator<string> {
        yield '<tv>';

        while (true) {
          yield '<programme/>';
          await new Promise((resolve) => setImmediate(resolve));
        }
      }

      setTimeout(() => controller.abort(new Error('cancelled')), 20);

      // Which stream notices first is not worth pinning down: the abort reaches
      // the compressor and the source at once, and either may be the one that
      // rejects. That it stops, and leaves nothing, is the claim.
      await expect(
        writeOutput(join(dir, 'guide.xml.gz'), endless(), { signal: controller.signal }),
      ).rejects.toThrow();

      // Half a compressed guide is worth even less than half a plain one, and
      // the temp file goes with the stream either way.
      expect(await readdir(dir)).toEqual([]);
    });
  });

  describe('cancelling', () => {
    /** A source as long as the guide it stands for, which is the point. */
    async function* endless(): AsyncGenerator<string> {
      yield '<tv>';

      while (true) {
        yield '<programme/>';
        await new Promise((resolve) => setImmediate(resolve));
      }
    }

    it('stops a write and leaves nothing where the file goes', async () => {
      const dir = await tempDir();
      const output = join(dir, 'guide.xml');
      const previous = '<tv>the one already there</tv>';
      await writeFile(output, previous, 'utf8');

      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error('cancelled')), 5);

      await expect(writeOutput(output, endless(), { signal: controller.signal })).rejects.toThrow();

      // The write is discarded rather than taking the place of what is there,
      // and its temp file goes with it.
      expect(await readFile(output, 'utf8')).toBe(previous);
      expect(await readdir(dir)).toEqual(['guide.xml']);
    });

    it('stops a source that never thought to ask', async () => {
      const dir = await tempDir();
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error('cancelled')), 5);

      // Not a generator taking the signal — an iterable that cannot stop
      // itself, which is what the pipeline's own signal is for.
      const forever = {
        *[Symbol.iterator](): Generator<string> {
          while (true) {
            yield '<programme/>';
          }
        },
      };

      await expect(
        writeOutput(join(dir, 'guide.xml'), forever, { signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(await readdir(dir)).toEqual([]);
    });

    it('gives up on a socket nothing is reading', async () => {
      const dir = await tempDir();
      const socketPath = join(dir, 'xmltv.sock');
      // Bound, so the path is a socket, but the backlog is never accepted from.
      const server = createServer();
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));

      try {
        const controller = new AbortController();
        controller.abort(new Error('cancelled'));

        // The socket carries the signal, so an abort arrives on the same
        // listener a refused connection would.
        await expect(
          writeOutput(socketPath, ['<tv></tv>'], { signal: controller.signal }),
        ).rejects.toThrow(/Cannot write to socket .*: cancelled/);
      } finally {
        server.close();
      }
    });

    it('leaves an already-written file alone when the abort lands first', async () => {
      const dir = await tempDir();
      const output = join(dir, 'guide.xml');
      const controller = new AbortController();
      controller.abort(new Error('cancelled'));

      await expect(
        writeOutput(output, ['<tv></tv>'], { signal: controller.signal }),
      ).rejects.toThrow();

      expect(await readdir(dir)).toEqual([]);
    });
  });

  it('leaves the previous file untouched when the source fails part way', async () => {
    const dir = await tempDir();
    const output = join(dir, 'guide.xml');

    await writeFile(output, '<tv>the good one</tv>', 'utf8');

    async function* halfway(): AsyncGenerator<string> {
      yield '<tv>';
      throw new Error('the feed went away');
    }

    await expect(writeOutput(output, halfway())).rejects.toThrow('the feed went away');

    // The half-written document is gone rather than renamed over the guide —
    // a reader between two runs still gets the last complete one.
    expect(await readFile(output, 'utf8')).toBe('<tv>the good one</tv>');
    expect(await readdir(dir)).toEqual(['guide.xml']);
  });

  it('removes the directories it made for a write that failed', async () => {
    const dir = await tempDir();
    const output = join(dir, 'a', 'b', 'guide.xml');

    async function* halfway(): AsyncGenerator<string> {
      yield '<tv>';
      throw new Error('the feed went away');
    }

    await expect(writeOutput(output, halfway())).rejects.toThrow('the feed went away');

    // Nothing left of the attempt, not even the path made to hold it.
    expect(await readdir(dir)).toEqual([]);
  });

  it('keeps a directory it did not make, and one that is not empty', async () => {
    const dir = await tempDir();
    const output = join(dir, 'a', 'b', 'guide.xml');

    // `a` is somebody else's, and something lands in `b` while we are writing.
    await mkdir(join(dir, 'a'), { recursive: true });
    await writeFile(join(dir, 'a', 'theirs.txt'), 'not ours', 'utf8');

    async function* halfway(): AsyncGenerator<string> {
      yield '<tv>';
      // Only once our own write has made `b` — otherwise this would create it,
      // and the case under test is a directory we made that someone else used.
      await vi.waitFor(() => stat(join(dir, 'a', 'b')));
      await writeFile(join(dir, 'a', 'b', 'alongside.txt'), 'also not ours', 'utf8');
      throw new Error('the feed went away');
    }

    await expect(writeOutput(output, halfway())).rejects.toThrow('the feed went away');

    // `b` was ours to remove but is no longer empty, so it stays — and `a`
    // was never ours. A recursive remove would have taken both files with it.
    expect(await readdir(join(dir, 'a', 'b'))).toEqual(['alongside.txt']);
    expect((await readdir(join(dir, 'a'))).sort()).toEqual(['b', 'theirs.txt']);
  });

  it('writes to a stream it was handed without closing it', async () => {
    const written: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer | string, _encoding, done): void {
        written.push(String(chunk));
        done();
      },
    });

    await writeOutput(sink, ['<tv>', '</tv>']);

    expect(written.join('')).toBe('<tv></tv>');
    // stdout is not ours to end: a second document must still be writable.
    expect(sink.writableEnded).toBe(false);

    await writeOutput(sink, ['<tv/>']);
    expect(written.join('')).toBe('<tv></tv><tv/>');
  });

  it('connects to a path that is a socket instead of replacing it', async () => {
    const dir = await tempDir();
    const output = join(dir, 'x.sock');
    const chunks: string[] = [];

    let resolveDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const server = createServer((socket) => {
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => chunks.push(chunk));
      socket.on('end', () => resolveDone());
    });

    await new Promise<void>((resolve) => server.listen(output, resolve));

    try {
      await writeOutput(output, ['<tv>', '</tv>']);
      await done;

      expect(chunks.join('')).toBe('<tv></tv>');
      expect((await stat(output)).isSocket()).toBe(true);
      expect(await readdir(dir)).toEqual(['x.sock']);
    } finally {
      server.close();
    }
  });

  it('takes a socket path that has stopped being one as an ordinary file', async () => {
    const dir = await tempDir();
    const output = join(dir, 'x.sock');
    const server = createServer();

    // Node unlinks the path when its server closes, so by now nothing is
    // there — and a path that is not a socket is a file to write.
    await new Promise<void>((resolve) => server.listen(output, resolve));
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await writeOutput(output, ['<tv/>']);

    expect(await readFile(output, 'utf8')).toBe('<tv/>');
    expect((await stat(output)).isFile()).toBe(true);
  });
});

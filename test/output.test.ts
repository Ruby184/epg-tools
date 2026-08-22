import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { openOutput, writeOutput } from '../src/core/output.js';

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

  describe('cancelling', () => {
    /** A source as long as the guide it stands for, which is the point. */
    async function* endless(): AsyncGenerator<string> {
      yield '<tv>';

      for (;;) {
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
          for (;;) {
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

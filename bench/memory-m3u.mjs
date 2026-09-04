/**
 * Memory benchmark: peak heap while reading a large M3U playlist.
 *
 * Usage: npm run bench:memory:m3u  (or: node bench/memory-m3u.mjs [entries])
 *
 * The companion to `bench/memory.mjs`, and the measurement that actually
 * separates this module from the alternatives: `bench/m3u.bench.ts` says
 * `parseM3uString` is the faster of the whole-document parsers, but every one
 * of them — ours included, in that form — holds the entire playlist and the
 * entire model at once. This measures the form that does not.
 *
 * Each measurement runs in its own child process so the heaps do not pollute
 * one another. The fixture is generated with our own streaming writer.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2];

const MiB = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/** Sample the live working set rather than uncollected garbage — see memory.mjs. */
function sampler() {
  let peak = 0;

  global.gc();

  const baseline = process.memoryUsage().heapUsed;

  return {
    sample() {
      global.gc();
      peak = Math.max(peak, process.memoryUsage().heapUsed);
    },
    report(label, entries) {
      this.sample();
      console.log(
        JSON.stringify({
          label,
          entries,
          peakHeap: peak - baseline,
          rss: process.memoryUsage.rss(),
        }),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Child modes: measure one library each, print JSON on stdout.
// ---------------------------------------------------------------------------

if (mode === 'stream') {
  const { parseM3uFile } = await import(path.join(here, '../dist/m3u/main.js'));
  const meter = sampler();
  let entries = 0;

  for await (const event of parseM3uFile(process.argv[3])) {
    if (event.type !== 'entry') {
      continue;
    }

    entries++;

    if (entries % 1000 === 0) {
      meter.sample();
    }
  }

  meter.report('epg-tools parseM3uFile (stream)', entries);
  process.exit(0);
}

if (mode === 'string') {
  const { parseM3uString } = await import(path.join(here, '../dist/m3u/main.js'));
  const meter = sampler();
  const playlist = parseM3uString(readFileSync(process.argv[3], 'utf8'));

  meter.report('epg-tools parseM3uString (whole document)', playlist.entries.length);
  process.exit(0);
}

if (mode === 'iptv') {
  const { parseM3U } = await import('@iptv/playlist');
  const meter = sampler();
  const playlist = parseM3U(readFileSync(process.argv[3], 'utf8'));

  meter.report('@iptv/playlist parseM3U', playlist.channels?.length ?? 0);
  process.exit(0);
}

if (mode === 'generator') {
  const { M3uParser } = await import('m3u-parser-generator');
  const meter = sampler();
  const playlist = new M3uParser({ ignoreErrors: true }).parse(
    readFileSync(process.argv[3], 'utf8'),
  );

  meter.report('m3u-parser-generator parse', playlist.medias?.length ?? 0);
  process.exit(0);
}

if (mode === 'legacy') {
  const { default: parser } = await import('iptv-playlist-parser');
  const meter = sampler();
  const playlist = parser.parse(readFileSync(process.argv[3], 'utf8'));

  meter.report('iptv-playlist-parser parse', playlist.items?.length ?? 0);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Parent: generate the fixture, run each child, print the table.
// ---------------------------------------------------------------------------

const { writeM3uToFile } = await import(path.join(here, '../dist/m3u/main.js'));

const count = Number(process.argv[2] ?? 100_000);
const file = path.join(tmpdir(), `epg-tools-bench-${process.pid}.m3u`);

/** Proportioned like iptv-org's index.m3u — see `bench/m3u.bench.ts`. */
function* generateEntries() {
  for (let i = 0; i < count; i++) {
    const attributes = new Map([
      ['tvg-id', `Channel${i}.us@SD`],
      ['tvg-logo', `https://images.example.com/channels/${i}/colorLogoPNG.png`],
    ]);

    if (i % 20 === 0) {
      attributes.set(
        'http-user-agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
      );
    }

    attributes.set('group-title', ['News', 'Movies', 'Sports', 'General'][i % 4]);

    yield {
      url: `https://cdn.example.com/live/channel${i}/index.m3u8`,
      name: `Channel ${i} (1080p)`,
      duration: -1,
      attributes,
      ...(i % 16 === 0
        ? { directives: [{ name: 'EXTVLCOPT', value: 'http-referrer=https://example.com/' }] }
        : {}),
    };
  }
}

console.log(`Generating fixture: ${count.toLocaleString('en-US')} entries ...`);
await writeM3uToFile(
  file,
  {
    header: { attributes: new Map([['x-tvg-url', 'https://example.com/guide.xml.gz']]) },
    entries: generateEntries(),
  },
  { eol: '\r\n' },
);

console.log(`Fixture: ${MiB(statSync(file).size)}\n`);

try {
  const results = ['stream', 'string', 'iptv', 'generator', 'legacy'].map((childMode) => {
    const stdout = execFileSync(
      process.execPath,
      ['--expose-gc', fileURLToPath(import.meta.url), childMode, file],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );

    return JSON.parse(stdout.trim().split('\n').at(-1));
  });

  const pad = (value, width) => String(value).padStart(width);

  console.log(
    `${'library'.padEnd(44)}${pad('entries', 10)}${pad('peak heap', 12)}${pad('RSS', 12)}`,
  );

  for (const result of results) {
    console.log(
      `${result.label.padEnd(44)}${pad(result.entries.toLocaleString('en-US'), 10)}${pad(MiB(result.peakHeap), 12)}${pad(MiB(result.rss), 12)}`,
    );
  }

  const [stream] = results;

  for (const other of results.slice(1)) {
    console.log(
      `\nStreaming peak heap is ${(other.peakHeap / stream.peakHeap).toFixed(1)}× smaller than ${other.label}.`,
    );
  }
} finally {
  rmSync(file, { force: true });
}

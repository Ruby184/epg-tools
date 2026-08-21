/**
 * Memory benchmark: peak heap while reading a large XMLTV file.
 *
 * Usage: npm run bench:memory  (or: node bench/memory.mjs [channels] [days])
 *
 * Each measurement runs in its own child process so heaps don't pollute
 * each other. The fixture file is generated with our own streaming writer.
 */
import { execFileSync } from 'node:child_process';
import { rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2];

const MiB = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

// ---------------------------------------------------------------------------
// Child modes: measure one library each, print JSON on stdout.
// ---------------------------------------------------------------------------

if (mode === 'stream') {
  const { parseXmltvFile } = await import(path.join(here, '../dist/xmltv/main.js'));
  const file = process.argv[3];
  let programmes = 0;
  let peak = 0;

  global.gc();
  const baseline = process.memoryUsage().heapUsed;

  for await (const event of parseXmltvFile(file)) {
    if (event.type === 'warning') {
      continue;
    }

    if (event.type === 'programme') {
      programmes++;

      // Force a GC before sampling so `peak` reflects the live working set
      // (one buffered programme at a time), not transient garbage still
      // awaiting collection — the latter is pure GC-timing noise (V8 grows
      // the heap between collections) and swamps the number this benchmark
      // exists to show.
      if (programmes % 1000 === 0) {
        global.gc();
        peak = Math.max(peak, process.memoryUsage().heapUsed);
      }
    }
  }

  global.gc();
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  console.log(
    JSON.stringify({
      label: 'epg-tools parseXmltvFile (stream)',
      programmes,
      peakHeap: peak - baseline,
      rss: process.memoryUsage.rss(),
    }),
  );
  process.exit(0);
}

if (mode === 'iptv') {
  const { readFile } = await import('node:fs/promises');
  const { parseXmltv } = await import('@iptv/xmltv');
  const file = process.argv[3];

  global.gc();
  const baseline = process.memoryUsage().heapUsed;

  const xml = await readFile(file, 'utf8');
  const parsed = parseXmltv(xml);
  global.gc(); // measure the live retained guide, matching the streaming child
  const peak = process.memoryUsage().heapUsed;

  console.log(
    JSON.stringify({
      label: '@iptv/xmltv parseXmltv (whole document)',
      programmes: parsed.programmes?.length ?? 0,
      peakHeap: peak - baseline,
      rss: process.memoryUsage.rss(),
    }),
  );
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Parent: generate the fixture, run both children, print the comparison.
// ---------------------------------------------------------------------------

const channels = Number(process.argv[2] ?? 200);
const days = Number(process.argv[3] ?? 7);
const perDay = 24;

const { writeXmltvToFile } = await import(path.join(here, '../dist/xmltv/main.js'));

const DAY_MS = 86_400_000;
const BASE = Date.UTC(2026, 6, 17);
const file = path.join(tmpdir(), `epg-tools-bench-${process.pid}.xml`);

function* generateChannels() {
  for (let c = 0; c < channels; c++) {
    yield {
      id: `channel-${c}.example.tv`,
      displayName: [
        { value: `Channel ${c}`, lang: 'en' },
        { value: `Kanál ${c}`, lang: 'sk' },
      ],
      icon: [{ src: `https://example.tv/logo-${c}.png`, width: 120, height: 60 }],
    };
  }
}

function* generateProgrammes() {
  const duration = DAY_MS / perDay;

  for (let c = 0; c < channels; c++) {
    for (let d = 0; d < days; d++) {
      for (let p = 0; p < perDay; p++) {
        const start = BASE + d * DAY_MS + p * duration;

        yield {
          channel: `channel-${c}.example.tv`,
          start: new Date(start),
          stop: new Date(start + duration),
          title: [
            { value: `Programme ${c}-${d}-${p}`, lang: 'en' },
            { value: `Relácia ${c}-${d}-${p}`, lang: 'sk' },
          ],
          desc: [
            {
              value: `Description of programme ${p} on channel ${c}, day ${d}. Contains some & special <characters> that need escaping.`,
              lang: 'en',
            },
          ],
          category: [
            { value: 'News', lang: 'en' },
            { value: 'Správy', lang: 'sk' },
          ],
          episodeNum: [{ system: 'xmltv_ns', value: `${d}.${p}.` }],
          icon: [{ src: `https://example.tv/prog-${c}-${p}.jpg` }],
        };
      }
    }
  }
}

console.log(
  `Generating fixture: ${channels} channels × ${days} days × ${perDay} programmes/day ...`,
);
await writeXmltvToFile(file, {
  meta: { generatorInfoName: 'epg-tools-bench' },
  channels: generateChannels(),
  programmes: generateProgrammes(),
});

const size = statSync(file).size;
console.log(
  `Fixture: ${MiB(size)} (${(channels * days * perDay).toLocaleString('en-US')} programmes)\n`,
);

try {
  const results = ['stream', 'iptv'].map((childMode) => {
    const stdout = execFileSync(
      process.execPath,
      ['--expose-gc', fileURLToPath(import.meta.url), childMode, file],
      { encoding: 'utf8' },
    );
    return JSON.parse(stdout.trim().split('\n').at(-1));
  });

  const pad = (value, width) => String(value).padStart(width);
  console.log(`${'library'.padEnd(48)}${pad('peak heap', 12)}${pad('RSS', 12)}`);

  for (const result of results) {
    console.log(
      `${result.label.padEnd(48)}${pad(MiB(result.peakHeap), 12)}${pad(MiB(result.rss), 12)}`,
    );
  }

  const [stream, iptv] = results;
  console.log(
    `\nStreaming parser peak heap is ${(iptv.peakHeap / stream.peakHeap).toFixed(1)}× smaller for this file.`,
  );
} finally {
  rmSync(file, { force: true });
}

# epg-tools

[![npm](https://img.shields.io/npm/v/epg-tools.svg)](https://www.npmjs.com/package/epg-tools)
[![CI](https://github.com/Ruby184/epg-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/Ruby184/epg-tools/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/epg-tools.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/epg-tools.svg)](./LICENSE)

Memory-efficient EPG toolkit for building [XMLTV](https://github.com/XMLTV/xmltv) guides:

- **Grabber** — define multiple site configs, fetched in parallel with [p-queue](https://github.com/sindresorhus/p-queue) and [ky](https://github.com/sindresorhus/ky)
- **Day cache** — every `site + channel + day` is cached; building a 14-day guide only fetches the days that are missing or stale. Files of ndjson or XMLTV, one SQLite file, memory, or a driver of your own
- **Streaming XMLTV** — a dependency-free, XMLTV-specialized streaming parser (tokenizer technique inspired by [txml](https://github.com/TobiasNickel/tXml), fused directly with the typed model) plus a streaming serializer, so merging many sources never loads a whole guide into memory — and parsing is faster than any whole-document XMLTV parser we measured (2.3× `@iptv/xmltv`, 11× `fast-xml-parser`, 13× `epg-parser`; see [Benchmarks](#benchmarks))
- **Complete DTD coverage** — every element and attribute of the official [xmltv.dtd](https://github.com/XMLTV/xmltv/blob/master/xmltv.dtd) round-trips (`video`, `audio`, PDC/VPS starts, showview/videoplus, clumpidx, `url system=`, credit persons with inline `image`/`url`, …); output is validated against the official DTD in the test suite
- **Provider extensions preserved** — non-DTD attributes and elements round-trip instead of being dropped, so consumers like [tvheadend's XPath-based grabber](https://github.com/tvheadend/tvheadend/blob/master/docs/class/epggrabber_modules.md#xmltv-xpath-examples-and-notes) can extract them: `uniqueID` on `<programme>`, `eit` codes on `<category>`, `<crid><series>…</series></crid>`, `<live/>`, `<lcn>`
- **Warnings, not crashes** — malformed feeds never abort the stream. A bad programme is skipped and [reported as a warning](./docs/xmltv.md#warnings), not thrown: one bad programme in a 20 MB feed costs you one programme, not the guide
- **Fluent builders** — [`ProgrammeBuilder`](./docs/xmltv.md#builders) and friends write the language-tagged model for you, and `parseDay` is handed one already bound to the channel-day it is parsing
- **Merge strategies** — combine multiple sources per channel, including merging multi-language attributes of the same programme. Two sources rarely agree to the second, so the same broadcast is [recognized within a tolerance](./docs/configuration.md#what-counts-as-the-same-broadcast) — corroborated by the title, and by the two durations where they are known — and a programme that two adjacent days both reported is emitted once rather than twice
- **The output cleaned up on the way out** — a programme with no `stop` runs to the next one's start (capped, so an off-air night stays a gap), a `stop` reaching past that start is pulled back, and a `transform` hook per site or over the whole guide handles the rest: category maps, title cleanups, dropping a source's filler. What `tv_sort` and WebGrab+Plus's postprocess are for, [on by default](./docs/configuration.md#cleaning-up-the-output)
- **`+1` channels for free** — declare a channel as [another one shifted](./docs/configuration.md#derived-channels) and it is built from days already in the cache, costing no requests: `{ xmltvId: 'skyone.plus1.uk', from: 'skyone.uk', offset: 60 }`. It gets the name a playlist uses for it, and a generated `tv_grab_*` lists and selects it like any other channel
- **Channel lists that line up** — read and write the two formats the community keeps by hand: [M3U playlists](./docs/m3u.md) (streaming, where every published parser holds the document — and correct on [where the display name begins](./docs/m3u.md#where-the-display-name-begins), which two of the three other JS parsers get wrong on the 4.9% of iptv-org's entries that carry a comma inside a quoted value) and [`*.channels.xml`](./docs/channels.md) as iptv-org/epg and WebGrab+Plus write it. `epg channels --against playlist.m3u` says which of the channels you want will get no guide, and `--check` fails a CI step over it — a `tvg-id` that does not equal a `<channel id>` is the commonest "no EPG" failure there is, and nothing anywhere reports it
- **Only the channels you want** — `--channels` [selects rather than filters](./docs/configuration.md#keeping-only-some-channels): a channel left out is never fetched and never cached, so 60 of a source's 900 cost 60 channels' worth of requests. Takes a playlist, a `*.channels.xml`, a guide or a plain list of ids. And [`epg filter`](./docs/configuration.md#subsetting-a-guide-you-already-have) does the same to a guide somebody else wrote, in constant memory — 8.5 MiB of live heap whether the guide is 17 MB or 66 MB, where `tv_grep` holds the document
- **Serve it and check it** — [`epg serve`](./docs/configuration.md#serving-the-guide) holds the guide behind HTTP for a consumer that polls, answering `304 Not Modified` from cache metadata rather than by merging again, and [`epg validate`](./docs/configuration.md#validating-a-guide) reads a guide back and reports what is wrong with it, grouped by rule so the report stays the same size whatever the guide's
- **An XMLTV grabber, from the same config** — [`epg init-grabber`](./docs/tv-grab.md) turns it into a `tv_grab_*` executable that tvheadend and `tv_find_grabbers` can drive

Requires Node.js >= 20.4 (Node >= 23.6 to load `epg.config.ts` directly via native type stripping).

## Install

```sh
npm install epg-tools
```

## Just want the XMLTV parser?

The parser and serializer live behind their own entry point and pull in nothing else — no grabber, no cache, no config loading, no runtime dependencies. If all you need is to read or write XMLTV, this is the whole API surface you touch:

```ts
import { parseXmltvFile } from 'epg-tools/xmltv';

// Constant memory: one programme is held at a time, whether the guide is 16 MiB or 16 GiB
for await (const event of parseXmltvFile('guide.xml')) {
  if (event.type === 'programme') {
    console.log(event.value.start, event.value.title[0]?.value);
  } else if (event.type === 'warning') {
    console.warn(`${event.value.code} at line ${event.value.line}: ${event.value.message}`);
  }
}
```

Events are `meta`, `channel`, `programme`, `processing-instruction` and `warning` — a malformed guide never throws mid-stream, it just reports what it skipped and keeps going, and a top-level processing instruction is surfaced rather than dropped, with the position that puts it back where it was.

Small guide and you'd rather have it all at once? `parseXmltvString` is the synchronous whole-document form:

```ts
import { parseXmltvString } from 'epg-tools/xmltv';

const { meta, channels, programmes, warnings } = parseXmltvString(xml);
```

Writing back out mirrors it — `writeXmltvStream` (async generator of string chunks), `writeXmltvToFile`, or the `XmltvParseStream` / `XmltvSerializeStream` Node `Transform`s if you'd rather drop into `stream.pipeline()`. See [the XMLTV documentation](./docs/xmltv.md) for the parser, the serializer, the builders and the date helpers, and [Benchmarks](#benchmarks) for how it measures up against `@iptv/xmltv`, `epg-parser` and `fast-xml-parser`.

## Quick start

Already have a guide to point at? Someone else's `xmltv.xml.gz` is a source with
nothing to write:

```ts
import { defineConfig, defineXmltvSite } from 'epg-tools';

export default defineConfig({
  sites: [defineXmltvSite({ site: 'published.example', url: 'https://example.test/guide.xml.gz' })],
  output: 'public/epg.xml',
});
```

The document is streamed through the parser and split into the cache a
channel-day at a time, never held whole. On a 43 MiB guide — 1,000 channels over
a week, 126,000 programmes:

| | smallest heap it finishes in |
|---|---|
| streamed and split | **40 MiB** |
| parsed whole, then split | **192 MiB** |

The first number stays where it is as the guide grows; the second follows the
document. Channels come from the guide's own head rather than a list you
maintain, the next run [asks whether anything
changed](./docs/site-config.md#asking-only-when-it-is-worth-it) instead of
downloading again, and what comes out merges with any hand-written site below.
See [a published guide as a source](./docs/site-config.md#a-published-guide-as-a-source).

For a source with no guide to publish, write the site yourself. Create
`epg.config.ts`:

```ts
import { defineConfig, defineSiteConfig } from 'epg-tools';

const example = defineSiteConfig({
  site: 'example.tv',
  channels: [
    { xmltvId: 'one.example.tv', siteId: '101', name: 'Example One', logo: 'https://example.tv/one.png' },
  ],
  concurrency: 2,
  rateLimit: { requests: 8, perMs: 1_000 },
  ky: {
    prefix: 'https://api.example.tv',
    headers: { 'x-api-key': process.env.EXAMPLE_KEY! },
    retry: 2,
  },
  async request({ channel, date, http }) {
    return http.post('epg', {
      json: { channel_id: channel.siteId, date: date.toISOString() },
    }).json<{ items: { start: string; end: string; title: string; desc?: string }[] }>();
  },
  parseDay({ payload, programme }) {
    // `programme` is the XMLTV builder, already bound to this channel-day —
    // no channel id, and text elements take the channel's `lang`.
    return payload.items.map((item) => {
      const p = programme(new Date(item.start), item.title).stop(new Date(item.end));
      return item.desc ? p.desc(item.desc) : p;
    });
  },
});

export default defineConfig({
  sites: [example], // order = priority when several sites cover the same channel
  days: 14,
  output: 'public/epg.xml',
  // indent: 2,     // pretty-print the guide; omit for compact output (default)
  // extensions: false,  // leave provider extensions out, for a DTD-valid guide
  // allowMissing: '5%',  // exit 0 with up to this much of the guide missing
  cache: {
    dir: '.epg-cache',
    driver: 'ndjson', // or 'xmltv', 'sqlite', or a driver of your own
    staleness: {
      alwaysRefetchDays: 1, // always refetch today
      maxAgeDays: 7,        // bust anything grabbed more than 7 days ago
      emptyMaxAgeDays: 1,   // and a day that came back empty after one
    },
  },
  merge: {
    channelStrategy: 'merge-programmes',
    programmeStrategy: 'merge',
    // match: { startToleranceMs: 300_000, titles: 'when-shifted' },  // the default
    // fillStop: true,      // a programme with no end runs to the next one's start
    // clipOverlaps: true,  // and a stop past that start is pulled back to it
  },
});
```

Then:

```sh
epg build            # grab stale/missing days, then write the merged guide
epg grab             # grab only
epg merge            # write the guide from cache only
epg serve            # hold the guide behind HTTP for a consumer that polls
epg try <site> <ch>  # one channel-day: the request, the payload, the programmes
epg validate         # read the guide and report what is wrong with it
epg filter guide.xml --channels my-60.m3u -o small.xml  # keep 60 of 900
epg channels --against playlist.m3u   # which wanted channels will get no guide
epg prune            # drop cached days older than today
epg init-grabber tv_grab_sk_example   # write an XMLTV grabber for this config
epg build -d 14 -o public/epg.xml
epg build --offset 1 # start the window tomorrow instead of today
epg build -o /home/hts/.hts/tvheadend/epggrab/xmltv.sock  # write into a socket
```

Any output — `config.output`, `-o`, or the grabber's `--output` — may be a Unix
socket instead of a file, which is how tvheadend's **External XMLTV** module
takes one. A path that is *not* a socket is written to a temp file and renamed
into place, so a reader never sees half a guide.

| option | meaning |
|---|---|
| `-c, --config <path>` | config file; defaults to `epg.config.ts\|js\|mjs` in the working directory |
| `-d, --days <n>` | override the config's `days` |
| `--offset <n>` | start the window n days from today; may be negative |
| `-o, --output <path>` | override the output file, or a Unix socket to stream into — a `.gz`, `.br` or `.zst` name [compresses it](./docs/configuration.md#compressing-the-guide) |
| `--cache-dir <dir>` | override the cache directory |
| `--cache-driver <name>` | override where cached days are kept: `ndjson`, `xmltv`, `sqlite` or `memory` |
| `--refresh` | refetch every day in the window, ignoring what is cached — the days still land in the cache for the run after |
| `--before <day>` | `prune` only: remove days before `YYYY-MM-DD`, default today |
| `--log-level <l>` | how much to report: `error`, `warn`, `info` (default) or `debug` |
| `-v, --verbose` | same as `--log-level debug`; `-q, --quiet` is `--log-level error` |
| `--reporter <name>` | `progress` (default — a live line on a terminal, `text` anywhere else), `text`, or `json` for one object per line |
| `--failures <how>` | `block` (default) — one capped block at the end — or `inline` |
| `-V, --version` | print the package name and version |
| `-h, --help` | print the usage |
| `--description`, `--grabber-version`, `--force` | `init-grabber` only — see [XMLTV grabber](./docs/tv-grab.md) |

It exits **0** on success, **1** when the run failed or the guide is short a
channel-day, and **2** for anything you typed wrong — an unknown option,
command, or `--before` value, each printed with the usage.

Full option semantics, every config field and its default, and how the cache
decides what to refetch are in [Configuration and CLI](./docs/configuration.md).

## Documentation

| page | what is in it |
|---|---|
| [Configuration and CLI](./docs/configuration.md) | Every `EpgConfig` field and default, the cache, the `epg` commands and options, merge strategies |
| [Site configuration](./docs/site-config.md) | Writing a site: channels, `request`, `parseDay`, batching, per-site HTTP and proxies, rate limits and backoff |
| [XMLTV parser, serializer and builders](./docs/xmltv.md) | The standalone `epg-tools/xmltv` entry point — parsing, warnings, serializing, the stream `Transform`s, builders, dates |
| [M3U playlists](./docs/m3u.md) | The standalone `epg-tools/m3u` entry point — parsing, the model, warnings, serializing, and reading a playlist as a channel list |
| [Channel lists and matching](./docs/channels.md) | The standalone `epg-tools/channels` entry point — reading and writing `*.channels.xml`, matching two channel lists, `epg channels` |
| [Using it as an XMLTV grabber](./docs/tv-grab.md) | `tv_grab_*` executables, the grabber protocol, capabilities of your own, configuration stages, channel lineups |
| [Programmatic API](./docs/api.md) | `build`/`runGrab`/`runMerge`/`guideStream` and the full export map for every entry point |

Contributing? See [CONTRIBUTING.md](./CONTRIBUTING.md). Release notes are in
[CHANGELOG.md](./CHANGELOG.md).

## Benchmarks

Run them yourself with `npm run bench` (speed, vitest bench) and `npm run bench:memory`.

**Memory** is the point of this library — parsing a 16.2 MiB guide (33,600 programmes), measured in isolated processes on Node 24 as live heap after a forced GC (the retained working set, not transient garbage):

| library | peak heap | RSS |
|---|--:|--:|
| `epg-tools` `parseXmltvFile` (streaming) | **1.0 MiB** | 76 MiB |
| `@iptv/xmltv` `parseXmltv` (whole document) | 83.8 MiB | 333 MiB |

The streaming parser's footprint stays flat regardless of guide size (only one `<programme>` element is held at a time — ~1 MiB whether the guide is 16 MiB or 16 GiB), while whole-document parsers grow linearly with the guide — here **81× smaller**, and a 14-day multi-source merge on a Raspberry Pi is exactly where that difference matters.

**Speed** on a 2,315 KiB / 1,440-programme document — every DTD element populated on every programme (credits, video/audio, ratings, subtitles, extensions, …), comparable in density to the example in `epg-parser`'s own README (ops/sec, higher is better):

| parse | ops/sec | vs `parseXmltvString` |
|---|--:|--:|
| `epg-tools` `parseXmltvStream` (whole string) | **18.5** | — |
| `epg-tools` `parseXmltvString` (sync, whole document) | 18.2 | 1.01× slower |
| `epg-tools` `parseXmltvStream` (64 KiB chunks) | 17.4 | 1.06× slower |
| `epg-tools` `XmltvParseStream` (Node Transform, 64 KiB chunks) | 15.5 | 1.20× slower |
| `@iptv/xmltv` `parseXmltv` | 7.9 | 2.34× slower |
| `fast-xml-parser` (generic XML, not XMLTV-specific) | 1.64 | 11.3× slower |
| `epg-parser` | 1.43 | 12.9× slower |

| write | ops/sec |
|---|--:|
| `epg-tools` `writeXmltvStream` | **27.7** |
| `epg-tools` `XmltvSerializeStream` (Node Transform) | 20.9 |
| `@iptv/xmltv` `writeXmltv` | 12.0 |

The document is the compact (default) serialization. `parseXmltvString` vs `@iptv/xmltv`'s `parseXmltv` is the direct apples-to-apples comparison — both are synchronous, call-it-and-get-a-result APIs. `fast-xml-parser` and `epg-parser` are the two other libraries people commonly reach for to parse XMLTV (the former a generic XML parser, the latter built on it plus `xml-js`/`lodash`); both build a full generic DOM before any XMLTV-specific interpretation, which shows. The XMLTV-specialized scanner behind all of our numbers parses straight into the typed model in one pass (no intermediate DOM, lazy entity decoding, charcode date parsing) — even the *streaming* variant, which holds only one programme in memory at a time, beats every whole-document parser tested here. The `XmltvParseStream` / `XmltvSerializeStream` Node `Transform`s add a little per-event pipe overhead over the async-generator/`parseXmltvString` forms, in exchange for slotting into `stream.pipeline()`.

## License

MIT

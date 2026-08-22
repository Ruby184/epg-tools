# Configuration and CLI

The config file describes the whole build: which sites to grab, how many days,
where the guide goes, and how the pieces are cached and merged. Everything on
this page is about the run as a whole — what one *site* looks like is
[Site configuration](./site-config.md).

- [The config file](#the-config-file)
- [`EpgConfig` reference](#epgconfig-reference)
- [Cache reference](#cache-reference)
- [CLI reference](#cli-reference)
- [How caching works](#how-caching-works)
- [Merge strategies](#merge-strategies)

## The config file

`epg` looks for `epg.config.ts`, `epg.config.js` or `epg.config.mjs` in the
working directory, or wherever `--config` points. The file must **default
export** either an `EpgConfig` or a `defineConfig` factory.

```ts
import { defineConfig, defineSiteConfig } from 'epg-tools';

const example = defineSiteConfig({ /* … see Site configuration … */ });

export default defineConfig({
  sites: [example],   // order = priority when several sites cover the same channel
  days: 14,
  output: 'public/epg.xml',
  cache: { dir: '.epg-cache' },
});
```

Node >= 23.6 loads `epg.config.ts` directly via native type stripping. On
Node 20 or 22, use `epg.config.js` / `epg.config.mjs`, or compile the TS file
first.

The factory form takes a context and is how a config gets answers it cannot
hardcode — a username, a password, a region. See
[Asking for more than channels](./tv-grab.md#asking-for-more-than-channels).

## `EpgConfig` reference

| field | type | default | what it is |
|---|---|---|---|
| `sites` | `AnySiteConfig[]` | **required** | The sites to grab, in priority order — the first covering a channel wins on conflicts. |
| `output` | `string` | **required** | Where the guide is written: a path, replaced atomically once complete, or a Unix socket to stream it into. |
| `days` | `number` | `7` | How many days to grab and include in the guide. A site may override it. |
| `cache` | `EpgCacheConfig` | see [below](#cache-reference) | Where and how cached days are kept. |
| `siteConcurrency` | `number` | all sites at once | How many sites grab in parallel. Lower it when many sites would otherwise open too many connections at once. |
| `localConcurrency` | `number` | `16` | How much cache work and parsing runs at once **across every site** — see [How caching works](#how-caching-works) — and, on the way back out, how many channel-days a merge [reads ahead of the writer](#across-the-day-boundary). Bounds open files rather than pacing any source. |
| `merge` | `MergeOptions` | `{ channelStrategy: 'merge-programmes', programmeStrategy: 'merge', fillStop: true, clipOverlaps: true }` | How several sites covering one channel are combined, what counts as the same broadcast (`match`), and how the programmes are [cleaned up](#cleaning-up-the-output) on the way out — see [Merge strategies](#merge-strategies). |
| `meta` | `XmltvDocumentMeta` | — | Attributes for the root `<tv>` element — see [below](#root-tv-attributes). |
| `indent` | `string \| number` | omitted — compact | Pretty-print the guide with this indentation, mirroring `JSON.stringify`: a number of spaces or a string like `'\t'`. |

### Root `<tv>` attributes

`meta` fills in the root element's attributes — who produced the guide and
where it came from. Every field is optional.

```ts
export default defineConfig({
  sites: [example],
  output: 'public/epg.xml',
  meta: {
    generatorInfoName: 'epg-tools',
    generatorInfoUrl: 'https://github.com/Ruby184/epg-tools',
    sourceInfoName: 'Example TV',
    sourceInfoUrl: 'https://example.tv',
    sourceDataUrl: 'https://api.example.tv/epg',
    // date: xmltvDate('20260717000000 +0200'),
  },
});
```

| field | XMLTV attribute |
|---|---|
| `date` | `date` — the guide's generation time (an `XmltvDate`, see [Dates](./xmltv.md#dates)) |
| `sourceInfoName` / `sourceInfoUrl` | `source-info-name` / `source-info-url` |
| `sourceDataUrl` | `source-data-url` |
| `generatorInfoName` / `generatorInfoUrl` | `generator-info-name` / `generator-info-url` |

Non-DTD attributes go in `extraAttributes` and are emitted verbatim.

## Cache reference

| field | type | default | what it is |
|---|---|---|---|
| `dir` | `string` | `.epg-cache` in the working directory | Cache root. **Make it absolute** if the config is also used by a [grabber](./tv-grab.md), which runs from wherever it is called. |
| `format` | `'ndjson' \| 'xmltv'` | `'ndjson'` | On-disk representation for **newly written** entries: `ndjson` writes `<day>.ndjson`, one JSON programme per line; `xmltv` writes `<day>.xml`, the programmes as XMLTV — pick it when you want the cache files readable by other XMLTV tooling. A store reads entries in **either** format whatever it is set to, so changing it does not invalidate what is already there, and an entry only ever exists in one format (the other is removed on write). |
| `staleness` | `Partial<StalenessPolicy>` | `{ alwaysRefetchDays: 1, maxAgeDays: 7, emptyMaxAgeDays: 1 }` | When a cached day is refetched. `alwaysRefetchDays: 1` means today only, `2` today and tomorrow, `0` never force-refetch. `maxAgeDays` busts anything grabbed longer ago than that, and `emptyMaxAgeDays` does the same for an entry that came back with **no programmes** — a source that was briefly broken is asked again the next day instead of leaving a hole for a week, while a channel that genuinely has nothing on costs one request a day rather than one per run. `0` refetches an empty day on any later run; a value as large as `maxAgeDays` turns the distinction off. |
| `prune` | `boolean` | `true` | Remove cached days older than today after a successful grab. |

## CLI reference

```sh
epg build            # grab stale/missing days, then write the merged guide
epg grab             # grab only
epg merge            # write the guide from cache only
epg prune            # drop cached days older than today
epg init-grabber tv_grab_sk_example   # write an XMLTV grabber for this config
epg build -d 14 -o public/epg.xml
epg build --offset 1 # start the window tomorrow instead of today
epg build -o /home/hts/.hts/tvheadend/epggrab/xmltv.sock  # write into a socket
```

`build` is the default when no command is given.

| option | meaning |
|---|---|
| `-c, --config <path>` | config file; defaults to `epg.config.ts\|js\|mjs` in the working directory |
| `-d, --days <n>` | override the config's `days` |
| `--offset <n>` | start the window n days from today; may be negative |
| `-o, --output <path>` | override the output file, or a Unix socket to stream into |
| `--cache-dir <dir>` | override the cache directory |
| `--before <day>` | `prune` only: remove days before `YYYY-MM-DD`, default today |
| `-q, --quiet` | no progress on stdout; failures still go to stderr |
| `-v, --version` | print the package name and version |
| `-h, --help` | print the usage |
| `--description`, `--grabber-version`, `--force` | `init-grabber` only — see [XMLTV grabber](./tv-grab.md) |

It exits **0** on success, **1** when the run failed or the guide is short a
channel-day, and **2** for anything you typed wrong — an unknown option,
command, or `--before` value, each printed with the usage.

### Output, and sockets

Any output — `config.output`, `-o`, or the grabber's `--output` — may be a Unix
socket instead of a file. If the path is already a socket it is connected to
and streamed into, and closing it is what tells the reader the document is
complete; that is exactly what tvheadend's **External XMLTV** module expects,
so a cron job can push a guide straight into a running tvheadend without a
grabber being registered at all. A path that is *not* a socket is written to a
temp file and renamed into place, so a reader never sees half a guide.

### `--offset`

`--offset` shifts the window only; "now" is unchanged, so staleness and the
`grabbedAt` stamp keep using the real current time and the post-grab prune
never removes a day inside the window. Negative values work in both the
`--offset -1` and `--offset=-1` forms.

## How caching works

Each `site + channel + day` is one cache entry
(`<dir>/<site>/<channel>/<day>.ndjson` + a small meta sidecar recording when it
was grabbed). On every run a channel-day is refetched only when:

- it is not cached yet (e.g. day 14 after a day passed), or
- it is within `alwaysRefetchDays` from today (near-term EPG changes often), or
- it was grabbed more than `maxAgeDays` ago, or
- it holds no programmes and was grabbed more than `emptyMaxAgeDays` ago.

Everything else is served from disk. A run says how many channel-days came back
empty (`Grab done: 42 fetched (3 empty), …`), since nothing else would: no
request failed, and the entries are cached like any other. Old days are pruned automatically after a
grab (disable with `cache.prune: false`).

Passing a `signal` cancels a run: what is still queued — requests, staleness
checks, cache writes — is dropped rather than started, and what is in flight
aborts through the client it was issued on. The grab resolves with the partial
summary rather than rejecting, so the channel-days that landed are cached and
counted, and `failed` holds only what was actually interrupted instead of one
entry per channel-day the run never reached.

Cache work is queued too, and separately from requests: the staleness sweep at
the start of a run and each channel-day's `parseDay`-and-write go through one
queue for the whole process, `localConcurrency` wide (default 16). A site's
`concurrency` and `rateLimit` are about being kind to *that source*, so cache work
neither waits behind a rate limit nor takes a request's slot — what this bounds
is open files and how many parsed programme lists are alive at once, which a
14-day window over a few hundred channels would otherwise start all at once.
Writes are queued ahead of sweep reads, since a response already fetched is held
in memory until it is written while a staleness check only finds more to do.
Raising it is worth pairing with `UV_THREADPOOL_SIZE`, which is what actually
runs Node's file operations (four threads by default).

## Merge strategies

When several sites cover the same `xmltvId` (site order in `sites` = priority):

- `channelStrategy`
  - `merge-programmes` (default) — one `<channel>` with metadata merged from all covering sites (display names unioned by `(lang, value)`, icons by `src`, priority site first), programmes combined from all covering sites
  - `first-wins` — one `<channel>`, programmes only from the first covering site
  - `keep-all` — no deduplication
- `programmeStrategy` (for `merge-programmes`)
  - `merge` (default) — programmes describing the same broadcast become one element; language-tagged fields (`title`, `desc`, `category`, …) are unioned by `(lang, value)` — grab the same channel from a Slovak and an English source and get both languages in one programme
  - `concat` — keep all programmes sorted by start

### What counts as the same broadcast

Sources rarely agree to the second: one publishes the schedule on a five-minute
grid while another carries the real start. Matching on the instant alone would
leave two elements per programme, which is the one thing merging is for — so
`merge.match` decides, and by default:

| field | default | what it does |
|---|---|---|
| `startToleranceMs` | `300_000` | How far apart two starts may be and still be one broadcast. `0` matches the instant exactly. |
| `titles` | `'when-shifted'` | When titles must agree: only for starts that differ (`when-shifted`), for every pair (`always`), or never (`never`). Titles are compared case- and accent-insensitively, with whitespace collapsed; nothing a programme carries is rewritten. |

A five-minute window is safe because a shifted pair has two more hurdles: it
must agree on its title, and — when both sides say where they end — the shift
must be **smaller than the shorter of the two durations**. Programmes that
follow one another are separated by exactly the earlier one's duration, so that
last rule is what keeps two same-titled three-minute clips apart however wide
the tolerance is.

Inside one source's own list none of this applies: two entries in a schedule are
two broadcasts, and only entries naming the identical instant are pooled. For a
source pair no option describes, pass a predicate instead:

```ts
merge: {
  match: (a, b) => a.episodeNum?.[0]?.value === b.episodeNum?.[0]?.value,
}
```

### Cleaning up the output

Two defects arrive from almost every source, and the guide is in a position to
fix both because it has the programme that follows:

| field | default | what it does |
|---|---|---|
| `fillStop` | `true` (cap 6 h) | A programme with no `stop` gets the next one's start — capped, so the gap where a channel goes off air for the night stays a gap instead of becoming one nine-hour programme. `{ maxMs: 1_800_000 }` for a cap of your own, `false` to leave ends missing. |
| `clipOverlaps` | `true` | A `stop` that reaches past the next programme's start is pulled back to it. |
| `clampToWindow` | `false` | Leave out programmes starting outside the guide's window. Off, because a source handing back a few hours past the last day is giving you something. |
| `transform` | — | The last word on every programme: `(programme, { xmltvId, next }) => programme \| null`. |

A programme with no end is what a consumer can do least with — tvheadend shows
a zero-length event, some players nothing at all — and two programmes claiming
the same minute means it has to guess which is on. Both are why `tv_sort` exists
in the Perl suite; here they are the default.

The last programme of a channel keeps no `stop`: there is nothing after it to
take one from. Neither rule invents anything — the end comes from the next
programme's start or not at all.

`transform` runs **after** those two, so it sees the `stop` they settled and the
programme that follows (`next`):

```ts
merge: {
  transform: (programme, { xmltvId }) => ({
    ...programme,
    category: programme.category?.map((c) => ({ ...c, value: GENRES[c.value] ?? c.value })),
  }),
}
```

Returning `null` or `undefined` leaves the programme out, but the rules have
already run, so the gap stays. To drop something and have the gap close, use
[a site's own `transform`](./site-config.md#fixing-up-one-source), which runs
before them — or `clampToWindow` for what falls outside the window.

### Across the day boundary

A cache entry is a channel-day, but a source's idea of a day is its own — plenty
run 06:00 to 06:00, and plenty repeat the programme spanning midnight in both
days' payloads. So a day is held back as the guide is written and merged with
the next one before it is emitted: a programme two adjacent days both reported
appears once, and programmes come out in start order across the boundary (under
`concat` too, which keeps both copies but no longer emits them out of order).
The working set is two days of one channel — flat in the size of the guide,
whichever way.

Cache entries are read **ahead of the writer**, `localConcurrency` of them at a
time (`readAhead` on `generateGuide` directly). A merge is otherwise all
waiting: read a channel-day, write it, read the next — and since writing is
quick and reading is not, a few hundred channels over a fortnight is thousands
of round trips taken one at a time. Reading ahead overlaps them without giving
up the order, and the window is what bounds the memory, so what is alive at once
is those two days plus the entries already read. On a warm page cache it is
worth around 1.3× on 1,400 channel-days, and more wherever a read costs more
than a local SSD's — an SD card, a network share, a Raspberry Pi.

---

[← README](../README.md) · [Site configuration](./site-config.md) · [XMLTV parser](./xmltv.md) · [XMLTV grabber](./tv-grab.md) · [Programmatic API](./api.md)

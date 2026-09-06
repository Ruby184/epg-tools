# Configuration and CLI

The config file describes the whole build: which sites to grab, how many days,
where the guide goes, and how the pieces are cached and merged. Everything on
this page is about the run as a whole — what one *site* looks like is
[Site configuration](./site-config.md).

- [The config file](#the-config-file)
- [`EpgConfig` reference](#epgconfig-reference)
- [Cache reference](#cache-reference)
- [CLI reference](#cli-reference)
- [Cancelling a run](#cancelling-a-run)
- [Compressing the guide](#compressing-the-guide)
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
| `compress` | `'gzip' \| 'brotli' \| 'zstd' \| false \| { format, level? }` | what the output's name says | Compress the guide — see [Compressing the guide](#compressing-the-guide). A `.gz`, `.br` or `.zst` output already asks for it; this is for a socket, for a plain document under a compressed-sounding name, or for choosing a level. |
| `days` | `number` | `7` | How many days to grab and include in the guide. A site may override it. |
| `cache` | `EpgCacheConfig` | see [below](#cache-reference) | Where and how cached days are kept. |
| `siteConcurrency` | `number` | all sites at once | How many sites grab in parallel. Lower it when many sites would otherwise open too many connections at once. |
| `localConcurrency` | `number` | `16` | How much cache work and parsing runs at once **across every site** — see [How caching works](#how-caching-works) — and, on the way back out, how many channel-days a merge [reads ahead of the writer](#across-the-day-boundary). Bounds open files rather than pacing any source. |
| `merge` | `MergeOptions` | `{ channelStrategy: 'merge-programmes', programmeStrategy: 'merge', fillStop: true, clipOverlaps: true, dropContainers: true }` | How several sites covering one channel are combined, what counts as the same broadcast (`match`), and how the programmes are [cleaned up](#cleaning-up-the-output) on the way out — see [Merge strategies](#merge-strategies). |
| `derived` | `DerivedChannel[]` | none | Channels that are other channels shifted — a `+1` and its like, costing no requests. See [Derived channels](#derived-channels). |
| `channels` | `readonly string[]` | all of them | Keep only these channels, by `xmltvId` — see [keeping only some channels](#keeping-only-some-channels). `--channels` overrides it. |
| `meta` | `XmltvDocumentMeta` | — | Attributes for the root `<tv>` element — see [below](#root-tv-attributes). |
| `indent` | `string \| number` | omitted — compact | Pretty-print the guide with this indentation, mirroring `JSON.stringify`: a number of spaces or a string like `'\t'`. |
| `extensions` | `boolean \| string[] \| ExtensionFilter` | `true` — all of them | Which provider extensions the guide carries — see [Provider extensions](#provider-extensions). `false` leaves every one out, which is what makes the guide valid against the DTD. |
| `serve` | `{ port?, host?, path?, compress?, cors? }` | `8080`, `127.0.0.1`, `/guide.xml`, `gzip`, off | Where `epg serve` listens and what it serves — see [serving the guide](#serving-the-guide). |
| `allowMissing` | `number \| string` | none — anything missing fails | How much of the guide may be missing and the run still exit **0**: a number of channel-days, or a share like `'5%'` — see [allowing some of the guide to be missing](#allowing-some-of-the-guide-to-be-missing). |
| `reporter` | `'text' \| 'json' \| 'progress'` or a factory | `'progress'` | How a run reports what it is doing — see [how much it says](#how-much-it-says). `--reporter` overrides it among the names. |

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
| `driver` | `'ndjson' \| 'xmltv' \| 'sqlite' \| 'memory' \| CacheDriverFactory` | `'ndjson'` | Where and how cached days are kept. Both names are **one file** per channel-day under `dir`, its own meta included. `ndjson` writes `<day>.ndjson`: a meta line (`grabbedAt`, `programmeCount`, and the two versions [an entry records about itself](./api.md#what-an-entry-says-about-itself)), then one JSON programme per line, with dates in XMLTV form (`20260807203000 +0200`) so the offset the source wrote them in and how precise it was both survive. `xmltv` writes `<day>.xml`, one small indented document — its root element carrying `date` as XMLTV means it, and its meta in a [processing instruction](./xmltv.md#processing-instructions) rather than in an attribute no DTD defines. Whether an entry then validates is down to the listing in it: a cache keeps whatever the site produced, [provider extensions](#provider-extensions) included, and the merge reads them back — so leaving them out is a decision for the guide, not for the cache. Pick it when something other than this package reads the cache. A driver reads **its own** entries only, so switching means starting the cache again. `sqlite` keeps the whole cache in one `cache.sqlite` under `dir` instead of a file per channel-day — worth it at thousands of channels, where a directory tree is tens of thousands of inodes to walk and back up; it needs Node 24 (or 22.5 with `--experimental-sqlite`), and is [loaded only when named](./api.md#epg-toolscachesqlite). `memory` keeps entries only as long as the process, which is enough for a `build` — its grab and its merge share one cache — and nothing for two commands, since `epg grab` and then `epg merge` would find the second one empty. Or pass a function returning a [driver of your own](./api.md#epg-toolscache) — `({ dir, signal }) => driver`, or a [builder](./api.md#epg-toolscache) that takes your options and returns one — which is how a cache ends up in a database, a bucket, or nowhere at all. It may await, so opening a connection belongs there. |
| `staleness` | `Partial<StalenessPolicy>` | `{ refetchAll: false, alwaysRefetchDays: 1, maxAgeDays: 7, emptyMaxAgeDays: 1 }` | When a cached day is refetched. `refetchAll` is what `--refresh` sets: every day in the window is fetched whatever the cache holds, and it reaches days behind today, which `alwaysRefetchDays` never does. `alwaysRefetchDays: 1` means today only, `2` today and tomorrow, `0` never force-refetch. `maxAgeDays` busts anything grabbed longer ago than that, and `emptyMaxAgeDays` does the same for an entry that came back with **no programmes** — a source that was briefly broken is asked again the next day instead of leaving a hole for a week, while a channel that genuinely has nothing on costs one request a day rather than one per run. `0` refetches an empty day on any later run; a value as large as `maxAgeDays` turns the distinction off. |
| `prune` | `boolean` | `true` | Remove cached days older than today after a successful grab. |
| `invalidate` | `(meta, key) => boolean` | — | One more reason a cached entry is void. The stored shape is [already checked](./api.md#what-an-entry-says-about-itself), so this is for what that cannot describe: a release whose *grabbing* changed rather than its storing, a site whose channel ids were renamed, a cache to be emptied gradually. Return `true` and the entry goes, so the day reads as never grabbed. |

## CLI reference

```sh
epg build            # grab stale/missing days, then write the merged guide
epg grab             # grab only
epg merge            # write the guide from cache only
epg serve            # hold the guide behind HTTP for a consumer that polls
epg try example.tv one.example.tv   # one channel-day, with the working shown
epg validate         # read the guide and report what is wrong with it
epg channels --against playlist.m3u  # which wanted channels will get no guide
epg filter guide.xml --channels my-60.m3u -o small.xml  # subset a guide you have
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
| `-o, --output <path>` | override the output file, or a Unix socket to stream into — a `.gz`, `.br` or `.zst` name [compresses it](./configuration.md#compressing-the-guide) |
| `--cache-dir <dir>` | override the cache directory |
| `--cache-driver <name>` | override where cached days are kept: `ndjson`, `xmltv`, `sqlite` or `memory` |
| `--refresh` | refetch every day in the window, ignoring what is cached — the days still land in the cache for the run after |
| `--allow-missing <n>` | exit 0 with up to this much of the guide missing: a number of channel-days, or a share like `5%` |
| `--extensions <names>` | `build`/`merge` only: keep only these [provider extensions](#provider-extensions), comma-separated — `--extensions lcn,uniqueID` |
| `--no-extensions` | `build`/`merge` only: leave every one out, for a guide that validates against the DTD |
| `--port <n>` | `serve` only: port to listen on, default `8080` |
| `--host <h>` | `serve` only: address to bind, default `127.0.0.1` — see [serving the guide](#serving-the-guide) |
| `--serve-path <p>` | `serve` only: the path that answers with the guide, default `/guide.xml` |
| `--raw` | `try` only: print the whole payload, not the first 2000 characters |
| `--format <how>` | `validate` and `channels`: `text` (default) or `json` |
| `--strict` | `validate` only: count warnings as failures too |
| `--channels <what>` | `build`/`grab`/`merge`/`serve`, and required by `filter`: keep only these channels and fetch nothing for the rest — ids, or a file naming them. Repeatable — see [subsetting a guide](#keeping-only-some-channels) |
| `--indent <n\|str>` | `build`/`merge`/`filter`: pretty-print with this indentation, mirroring `JSON.stringify` |
| `--against <file>` | `channels` only: what you want a guide for — an M3U playlist, a `*.channels.xml` or an XMLTV guide |
| `--write` | `channels` only: write the ids the report suggested back into `--against`, in place — or to `-o` |
| `--check` | `channels` only: exit 1 unless every wanted channel matched by id |
| `--before <day>` | `prune` only: remove days before `YYYY-MM-DD`, default today |
| `--log-level <l>` | how much to report: `error`, `warn`, `info` (default) or `debug` |
| `-v, --verbose` | same as `--log-level debug` — every channel-day |
| `-q, --quiet` | same as `--log-level error` — failures only. Beats `--verbose` if both are given |
| `--reporter <name>` | how to report it: `progress` (default — a live line on a terminal, `text` anywhere else), `text` or `json` |
| `--failures <how>` | `block` (default) — one capped block at the end — or `inline` |
| `-V, --version` | print the package name and version |
| `-h, --help` | print the usage |
| `--description`, `--grabber-version`, `--force` | `init-grabber` only — see [XMLTV grabber](./tv-grab.md) |

`-v` is verbosity, not the version: the version is `-V`.

It exits **0** on success, **1** when the run failed or the guide is short more
than [`--allow-missing`](#allowing-some-of-the-guide-to-be-missing) forgives,
**2** for anything you typed wrong — an unknown option, command, `--before` or
`--allow-missing` value, each printed with the usage — and **130** when it was
[cancelled](#cancelling-a-run).

### How much it says

By default a run reports one line per site plus the summary. `--verbose` adds a
line per channel-day, which for 500 channels over a fortnight is about fourteen
thousand of them; `--quiet` leaves only failures. Between those, `warn` is the
level for a signal rather than progress — a source that has started refusing, a
channel a published guide has stopped carrying.

A failure is said once, in a block under the summary, capped so a source that is
down does not bury what did work:

```
Grab done: 40 fetched, 10 from cache, 84 failed
  FAILED [example.tv] 3 channels 2026-09-01..2026-09-07 (21 channel-day(s)): 503
  … 20 shown, 64 more
```

`--failures inline` writes each where it happens instead and holds nothing, for
a log read as it is written.

On a terminal that summary is preceded by a **single line, rewritten in place**,
off totals the planner has already worked out:

```
example.tv · 84/350 channel-days · 10 cached · 2 failed
```

It is erased whenever there is something worth keeping — a warning, a failure,
the summary — and again when the run ends, so nothing is left behind. Only on a
terminal, and only at the default verbosity: through a pipe, into a file, under
`--verbose` or `--quiet`, `--reporter progress` *is* the text reporter, so what
a script reads never depends on whether anyone was watching. `--reporter text`
asks for the lines outright.

And `--reporter json` writes one JSON object per line rather than text, which is
the thing a formatted line cannot be asked:

```console
$ epg grab --reporter json --log-level debug | jq -c 'select(.level == "error")'
{"type":"request:failed","site":"example.tv","entries":21,"error":{"name":"HTTPError", …
```

A config can name the reporter instead of the command line — or pass one of its
own, a function told everything the run knows. See [reporting what a run is
doing](./api.md#reporting-what-a-run-is-doing).

### Cancelling a run

`Ctrl-C` (or a `SIGTERM` from whatever manages the job) stops the run rather
than killing it:

```console
$ epg build
^C
Cancelled. 34 channel-day(s) reached the cache; no guide was written.
$ echo $?
130
```

Nothing more is asked of any source, whatever was in flight is aborted through
the client it went out on, and **the channel-days that already landed stay in
the cache** — so the next run carries on from there rather than starting over.
No guide is written: half a window is not what should replace a complete guide,
and the file in place is left alone. The post-grab prune is skipped too, since a
window this run never finished filling may still want the days it would remove.

Press again and it exits immediately. That is the answer when a site's own code
is deaf to the signal — the wind-down waits for whatever it left running, and
the second press does not.

Programmatically it is the same signal in `RunOptions`:

```ts
const controller = new AbortController();

const summary = await build(config, { signal: controller.signal });
```

A cancelled `grab` **resolves** with the partial summary rather than rejecting —
what reached the cache is counted, and only what was actually interrupted is in
`failed`. A cancelled `merge` **rejects**, because half a document is not a
guide; `writeGuide` then discards the file it was building instead of moving it
into place.

The signal reaches every wait long enough to be worth interrupting, the way
Node's own `fs` and stream APIs take one:

| where | what stops |
|---|---|
| requests | in flight through the site's client, queued ones dropped |
| the rate-limit hold after a `429` | the wait is abandoned, nothing is resent |
| cache reads and writes | a write stops **before** its rename, so an entry is either there in full or not at all |
| `epg prune` | between days — whole days removed, never half of one |
| parsing a guide | between chunks, and the file descriptor closes with it |
| writing a guide | between elements, and the part-written file is discarded |
| a socket output | the connection is given up on, rather than waiting to be read from |
| `--configure` prompts | the question stops waiting for an answer |

Two shapes of rejection come out of that, both standard: an aborted `fs` or
stream operation raises an `AbortError` carrying the reason as its `cause`,
while our own checks use `signal.throwIfAborted()` and so raise the reason
itself. Neither matters to the CLI, which asks `signal.aborted`.

### Output, and sockets

Any output — `config.output`, `-o`, or the grabber's `--output` — may be a Unix
socket instead of a file. If the path is already a socket it is connected to
and streamed into, and closing it is what tells the reader the document is
complete; that is exactly what tvheadend's **External XMLTV** module expects,
so a cron job can push a guide straight into a running tvheadend without a
grabber being registered at all. A path that is *not* a socket is written to a
temp file and renamed into place, so a reader never sees half a guide.

### Compressing the guide

A guide is enormously compressible: text, in a shape that repeats every
programme. An output whose name says which — `.gz`, `.br`, `.zst` — is
compressed with that format, because the name is what the file promises whoever
finds it. `compress` in the config is for what a name cannot say: a format for a
socket, `false` to write a plain document to a compressed-sounding path anyway,
and `{ format, level }` to choose how hard to try.

```ts
export default defineConfig({
  sites: [example],
  output: 'public/epg.xml.gz', // gzip, because the name says so
  // compress: { format: 'zstd', level: 12 },
});
```

Measured on a 500-channel fortnight — 92.4 MiB of XML, 280,000 programmes:

| asked for | size | smaller by | time |
|---|---|---|---|
| `gzip` (default level 6) | 2.60 MiB | 35× | 5.7s |
| `{ format: 'gzip', level: 1 }` | 4.11 MiB | 22× | 4.4s |
| `brotli` (**quality 7** here) | 0.63 MiB | 147× | 5.6s |
| `{ format: 'brotli', level: 11 }` | 0.50 MiB | 186× | **387s** |
| `zstd` (default level 3) | 0.93 MiB | 99× | 3.9s |
| `{ format: 'zstd', level: 12 }` | 0.64 MiB | 145× | 4.4s |

Three things worth taking from that. **gzip** is the interoperable one — reach
for it unless you know what reads the file. **zstd** is the quickest and beats
gzip on both axes, and needs Node 22.15 or newer. And **brotli's own default,
quality 11, takes six and a half minutes** on that guide, long enough to look
hung, so this defaults it to 7 instead — the same time gzip takes for a quarter
of gzip's size. Ask for `{ level: 11 }` if you want it.

Check what reads the guide before compressing it: a consumer reading
`xmltv.xml` off disk usually copes with gzip, fewer with the other two, and
tvheadend's socket wants the document itself.

### Provider extensions

A site can write anything the XMLTV DTD does not define — `uniqueID` on a
programme, `eit` codes on a category, `<lcn>`, `<crid><series>…</series></crid>`
— and it survives the cache and the merge to reach the guide, because a consumer
like tvheadend reads exactly that. It is also the one thing in a guide that
**cannot** validate against the DTD, since the DTD is the list of what is
defined.

`extensions` decides which of them the guide carries:

```ts
export default defineConfig({
  // ...
  extensions: false,               // none: a guide that validates
  // extensions: ['lcn', 'uniqueID'],  // or only the ones a consumer uses
  // extensions: ({ on, name }) => on === 'programme' && name !== 'debug',
});
```

On the command line, `--extensions lcn,uniqueID` and `--no-extensions`, both of
which override the config field. A filter has no command-line form, since a
command line cannot pass a function.

The cache is untouched by any of this — it keeps what the site produced, and the
choice is made on the way out. So one grab answers both consumers:

```sh
epg build                                  # the full guide, extensions and all
epg merge --no-extensions -o plain.xml     # and a DTD-valid one, no refetching
```

An element left holding nothing collapses to what the DTD allows rather than
being written empty: `<credits>` with only extensions in it is not written at
all, and `<video>` becomes `<video/>`.

### Trying one channel-day

`epg try <site> <channel> [day]` puts one channel-day through the whole path and
shows every step of it — what a site author needs while writing one, and what a
grab cannot show:

```sh
epg try example.tv one.example.tv          # today
epg try example.tv one.example.tv 2026-09-05
epg try example.tv 1 --raw                 # by site id, whole payload
```

```
example.tv → one.example.tv on 2026-09-03

  GET https://example.tv/api?ch=1&d=2026-09-03
    → 200, 143ms, 4.2 KB, application/json

  payload
    { "items": [ { "start": "06:00", "title": "Breakfast" } ] }

    [log]  the source sent 2 items

  2 programmes in 38ms
    <programme start="20260903060000 +0000" channel="one.example.tv">
      <title lang="en">Breakfast</title>
    </programme>
```

**The url is the point.** A grab cannot print one: a site builds its own inside
its own `request`, through the client it was given, so nothing above it ever
sees a url. `try` instruments that client instead — hooks around the site's own,
never instead of them — which is the only place a url exists.

The channel is taken by either of its ids, `xmltvId` or `siteId`. Batching is
honoured, so a site that asks for a week at a time is asked for a week here too
and what it does with one day of it is the thing being tried; `ctx.log` and
`ctx.warn` appear where the site said them.

**Nothing is written** and no cache is opened, so trying a site cannot poison
the guide a run would build, or make the next run think the day is already done.
A site that keeps its channel list between runs is asked for it afresh.

It exits **0** when programmes came out and **1** when none did — not an error,
since a channel with nothing on is an answer, but the commonest thing you are
here to look at, and enough for a shell loop over channels to tell.

### Serving the guide

`epg serve` holds the merged guide behind HTTP for a consumer that polls — the
serving half of what [`conditionalGet`](./site-config.md) does on the fetching
side, and for the same reason. A consumer asking hourly for a guide that changes
nightly spends twenty-three of those asks receiving a document it already has.

```sh
epg serve                          # http://127.0.0.1:8080/guide.xml
epg serve --port 9000 --host 0.0.0.0
epg serve --serve-path /xmltv.xml
```

```
GET /guide.xml → 200 in 412ms
GET /guide.xml → 304 in 1ms
```

That second line is the point. A `304 Not Modified` costs a header instead of a
merge, and `--reporter text -v` shows which of the two a poll got.

**What decides it.** A guide is a stream, so its bytes cannot be hashed without
buffering the document this package exists not to buffer. The cache answers
instead: the newest `grabbedAt` across the window, with how many entries are in
it. That reading is metadata only — no payloads, no parsing, no serializing —
worked out at most once a second (`revalidateMs`), and once for however many
polls arrive together.

**How much that actually saves is a driver question**, and by more than you
would guess. Measured over 3,500 channel-days (500 channels × 7 days), medians
of five rounds:

| | a `304` poll | the whole guide, for scale |
|---|---|---|
| `ndjson` (the default) | 230 ms | 840 ms |
| `sqlite` | **32 ms** | 840 ms |

On a file cache the sweep is one `open` and one read per channel-day, so it
costs a *quarter* of generating the guide rather than nothing like it — the
per-file syscall dominates, and the entries are small. On `sqlite` the same
sweep is one query. **If you are serving a guide of any size, that is the
driver to use**; the win over the network is the same either way, but the work
on your machine is twelve times smaller.

The keys are asked for in bounded batches (64 at a time, 8 in flight) rather
than as one enormous question. That is the caller's decision to make and not the
store's — a batch is one piece of work by the cache's own contract, precisely so
a store cannot multiply a caller's bound into a descriptor storm.

The one thing it cannot see is a channel that was not in the window when the
reading was taken: the entries are looked up by the channel list already in
hand, so a grab that adds a channel and refreshes nothing else writes a key
nobody asks about. The list is therefore resolved again when the fingerprint
moves, and in any case once its `sitesMaxAgeMs` (ten minutes) is up — a ceiling
on how long a new channel can stay invisible, without letting a poll drive the
request that resolving a fetched channel list can mean.

**`SIGHUP` skips the wait.** The ceiling is a guess at how long a new channel
may stay unseen; `kill -HUP` is you saying you know:

```sh
epg serve &
epg grab              # which adds a channel
kill -HUP %1          # served from the next request on, rather than in ten minutes
```

It asks a question rather than asserting an answer. If resolving finds the same
channels the guide is unchanged, the ETag is the one it had, and a poller still
gets its `304` — so a stray signal costs nothing. Every other command keeps what
`SIGHUP` has always meant: a grab whose terminal closed still stops.

It does not re-read the config file. Adding a *site*, or changing `days`, still
needs a restart.

What the ceiling costs depends on how a site gives its channels, and the
difference is worth knowing before leaving a server up for a fortnight:

| `channels` | what resolving again does | how a new channel appears |
|---|---|---|
| an array | returns it — free | only by editing the config, which means restarting anyway |
| a function with [`cacheChannels`](./site-config.md#a-channel-list-that-has-to-be-fetched) | reads the list the grab wrote to the cache; no request | within `sitesMaxAgeMs`, or at once on `SIGHUP` |
| a function without it | **asks the source**, every time the ceiling is reached | the same, at the price of a round trip |

The last row is the one to avoid on a long-lived server: an hourly poller turns
into a channel-list request per site per poll, where a grab makes one a day.
`cacheChannels` is the answer — the grab writes the list, `serve` reads it, and
the ceiling costs a cache lookup instead. One wrinkle even then: a stored list
older than `cacheChannels`'s own max age is refetched by whoever asks for it
next, `serve` included, so a server left running while the grabs stop still asks
once a day.

The guide streams straight into the response, so nothing is held in memory; a
consumer that hangs up mid-guide stops the merge feeding it, and is reported as
a disconnect rather than a failure — a reader that has seen enough, a proxy that
timed out or a closed tab is not something to be paged about.

**Behind a reverse proxy**, idle connections are held for 65 seconds. Node's own
default is 5, which is *below* the 60 nginx and Traefik keep, and that ordering
is what produces the intermittent `502` nobody can reproduce: the proxy sends a
request down a pooled socket at the moment Node is tearing it down. Holding
longer means the proxy is always the one to decide a connection is finished.

**For a browser**, set `serve.cors` — `true` for any origin, or one origin to
allow only it. It is off by default because loopback is not the boundary it
looks like: a page open in a browser on this machine can reach `127.0.0.1`, so
allowing every origin would publish the channel list that binding to loopback
declines to. Turning it on does the whole job rather than the one header —
`OPTIONS` is answered, `If-None-Match` is allowed through, and `ETag` is exposed,
without which a browser cannot read the validator and no conditional GET happens
at all.

`compress` (`gzip` by default) is used when the request's `Accept-Encoding` names it, and
`concurrency` (2) bounds how many guides are generated at once — a slot is held
for the whole response, a slow consumer included, since a merge reads the whole
cache and a burst of polls that each started one would make a cheap poll the
most expensive thing on the machine.

**It binds to loopback.** A guide is not a secret, but which sites you grab and
which channels you watch is not nothing, and a command that listened on every
interface because a flag was left off would be the wrong default to have chosen
once. `--host 0.0.0.0` is one word, and is a decision.

`SIGINT` or `SIGTERM` stops it, and it exits **0**: a server that was asked to
stop did what it was asked, so this is not the **130** a cancelled grab answers
with. `SIGHUP` reloads rather than stops, as [above](#serving-the-guide). It
does not grab — it serves what is in the cache, so run `epg grab` on whatever
schedule suits and leave this listening.

`serveGuide(config, options)` is the same thing as a library, returning
`{ url, port, reload, close, closed }` — see [the API reference](./api.md).

### Validating a guide

`epg validate` reads a guide and says what is wrong with it — the config's own
`output` by default, or a file named on the command line. A `.gz`, `.br` or
`.zst` name is decompressed on the way in, since that is what the name promised.

```sh
epg validate                       # the guide this config writes
epg validate public/epg.xml.gz     # or any other
epg validate --format json         # one document for CI to read
epg validate --strict              # warnings count as failures too
```

```
guide.xml — 200 channels, 33,600 programmes

  error   unknown-channel (14): a <programme> names a channel no <channel> describes
      sport2.example
      film4.example
  warning extensions (67,210): a provider extension, which no DTD describes — extensions: false removes them
      attribute uniqueID on <programme>
      element lcn on <channel>

14 errors, 67,210 warnings
```

It exits **1** when there is an error — or any warning, under `--strict`.

Findings are grouped **by rule, not by occurrence**: a guide where every
programme carries an extension is one line with a count, not a hundred thousand
lines. The names under each are examples, deduplicated and capped, so a report
stays the same size whatever the guide's — and so does the memory reading it: a
41 MB guide with 336,000 programmes validates in the same 8 MiB heap a 10 MB one
does.

A guide named on the command line needs **no config**: `epg validate
some/guide.xml` works in a directory with no project in it. Without a name it is
the config's `output`, and the config is then exactly what says where that is.

**`--format` is not `--reporter`.** They answer different questions.
`--format` is the shape of this command's output — one document, written once,
about a file that already exists, which is what a CI step wants: an `ok` to
branch on and a list to print. `--reporter` is how a *run* narrates itself while
it works, a stream of events with no end until the run has one. `validate` reads
a file rather than running anything, so `--reporter` has nothing to say about
it.

| severity | what it means |
|---|---|
| `error` | the guide is wrong: a `<programme>` naming a channel nothing describes, two programmes on one channel on at the same moment, a `<channel>` with no `<display-name>`, a `<programme>` with no `<title>`, two channels sharing an id, a programme that stops before it starts, or a document that ends mid-element |
| `warning` | the parser found something and coped: a dropped attribute, a duplicated element, markup it skipped — and [provider extensions](#provider-extensions), which are deliberate and are what `--no-extensions` removes |

Two programmes overlap when one starts strictly before the other has stopped.
Touching is not overlapping: the DTD makes a programme a half-closed interval —
on at its start, off just before its stop — so 11:00–12:00 and 12:00–13:00 do
not clash "not even for a moment". It is the constraint the DTD describes and
then says it has no way to express, which is why it lives here; a merge's
[`clipOverlaps`](#cleaning-up-the-output) is what keeps guides *this* package
writes clear of it.

What it does **not** check is element *order*. Parsing produces a model, and a
model has no order, so `<desc>` before `<title>` is invisible here. For that,
`xmllint --valid` beside a copy of `xmltv.dtd` is the tool — and a guide written
with `--no-extensions` is what makes that check pass.

### Keeping only some channels

A source that offers 900 channels and a household that watches 60 is the normal
case, not the awkward one — and the cost of the other 840 is paid three times
over: in requests, in cache, and at the consumer. Jellyfin loads every programme
of every channel in one request, which is about ten seconds at 870 channels.

```sh
epg build --channels my-60.m3u          # a playlist you already keep
epg build --channels wanted.txt         # a plain list of ids, one per line
epg build --channels bbc1.uk,bbc2.uk    # or just say them
```

`--channels` **selects** rather than filters: a channel left out is never
fetched and never cached, so 60 channels cost 60 channels' worth of requests.
`channels` in the config means the same thing, and the flag overrides it.

It takes ids, or a file naming them — an **M3U playlist**, a
**`*.channels.xml`**, an **XMLTV guide**, or a **plain list** with `#` comments
— told apart by content rather than by extension, as everywhere else here. A
guide is streamed rather than read whole, since subsetting somebody else's 900
channels is exactly what this is for and theirs may be 90 MiB. It is repeatable,
and the union of what each names, so a list kept in git plus one id you are
trying out works.

**Matched by id and nothing else.** A name that merely looks right is a
suggestion, and [`epg channels --against`](#which-channels-will-get-no-guide) is
what turns one into an id you can put in a config — guessing on your behalf is
how a guide ends up confidently describing the wrong channel. Anything selected
that no site produces is named once:

```
1 of 60 selected channels are produced by no site — bbcfour.uk.
`epg channels --against <file>` says what they look like.
```

A [derived channel](#derived-channels) may be selected without its source: what
it shifts is kept for it, since a shift with nothing to shift is nothing at all.
Select the source alone and the `+1` goes, rather than being left behind with
nothing to publish.

One thing it does not narrow: a site whose `channels` is a **function** still
resolves its whole list, because the selection is applied to the answer. It is
the channel-*days* that are never fetched, and those are the requests that scale
with the window.

### Subsetting a guide you already have

`epg filter` is the same question asked of a file rather than a run — for a
guide somebody else wrote, where there is nothing to grab:

```sh
epg filter guide.xml --channels my-60.m3u -o small.xml
epg filter big.xml.gz --channels bbc1.uk,bbc2.uk     # to stdout
```

It needs **no config at all** — a guide named on the command line is the whole
of what it wants — and streams, so the memory it uses does not depend on the
size of the guide: measured over a generated document, the live heap is 8.5 MiB
at 17 MB and 8.4 MiB at 66 MB. (`tv_grep`, the Perl equivalent, holds the whole
document.)

What survives is what a subset should: the root `<tv>` attributes, processing
instructions wherever they were, and provider extensions on the channels kept.
`--no-extensions` strips those, which is the way to take somebody's guide and
make it validate against the DTD; `--indent` gives it back a shape.

Two things do **not** survive, being things the parser does not model: XML
comments, and a `DOCTYPE` other than the standard one, which is rewritten as
`<!DOCTYPE tv SYSTEM "xmltv.dtd">`.

The summary and any parse warnings go to **stderr**, so stdout is only ever the
guide. A channel asked for that the source does not carry is named, and is not
an error — it is a fact about their guide, and the subset you asked for is still
what came back.

### Which channels will get no guide

`epg channels` answers the question that has no error message: an id in your
playlist that does not equal a `<channel id>` in the guide. Nothing fails — the
playlist loads, the guide loads, and the row is simply empty.

```sh
epg channels --against playlist.m3u    # or a *.channels.xml, or a guide
epg channels --against playlist.m3u --check    # for CI
epg channels --against playlist.m3u --format json
```

```
  ~ BBC Two HD
      looks like bbctwo.uk (BBC Two) — set its id to confirm
  ~ Sky One +1
      a +1h shift of skyone.uk — a derived channel, not a mapping
  ✗ Some Channel Nobody Has (nope.uk)
      nothing produces this

4 wanted, 1 matched by id, 1 by name, 2 with nothing
```

`--against` takes an **M3U playlist, a `*.channels.xml`, or an XMLTV guide**,
sniffed rather than taken from the extension: all three get renamed, and `.xml`
alone does not say which of the last two a file is. What it is compared against
is the channels your configured sites can produce.

Only what is wrong is printed — a channel matched by id says nothing, which is
what keeps the output the size of the problem rather than the size of the
lineup.

**`--write` puts the answer back.** The report has always ended by telling you to
set an id by hand; this is that confirmation, given once for the whole file:

```sh
epg channels --against tvtv.us.channels.xml --write
```

It writes into whichever of the three the file is — a `*.channels.xml`'s
`xmltv_id`, a playlist's `tvg-id`, or, for a guide, it **renames** the
`<channel id>` and every `<programme channel=…>` with it. All three round-trip,
so the diff is only the ids; the guide is rewritten by streaming, never held.

**In place, unless you say otherwise.** That is what writing an answer into your
own channel list means, and these files live in version control — `git diff` is
then exactly the ids added, since every reader here round-trips byte for byte.
For the times that is not true — somebody else's guide, a playlist you did not
author, or simply wanting to look first — `-o` writes elsewhere and leaves the
original alone:

```sh
epg channels --against theirs.xml --write -o ours.xml
```

Only where there is no id already. One that is there is somebody's decision —
possibly one made against this very suggestion — and replacing it silently is
worse than leaving a channel unmapped. An ambiguous match is still refused and a
timeshift is still a [derived channel](#derived-channels) rather than a mapping,
so neither is written.

`--check` exits **1** unless every wanted channel matched **by id**. A name
match is deliberately not enough: it is a suggestion, nothing has been written
anywhere, and a channel resting on one still shows an empty grid tomorrow.
Confirm it by writing the id into your channel list. Matching, and why a `+1`
is reported as a derived channel rather than matched, is in [channel lists and
matching](./channels.md#matching).

### Allowing some of the guide to be missing

A grab that lost a few channel-days out of thousands has produced a guide; one
that lost half of them has produced a hole. Both exit **1** by default, which
leaves a nightly build either crying wolf over one flaky channel or — if you
stop looking — publishing a fortnight of gaps without a word.

`allowMissing` draws the line, as a count of channel-days or a share of the ones
the run accounted for:

```ts
export default defineConfig({
  // ...
  allowMissing: '5%',   // or allowMissing: 20
});
```

```sh
epg build --allow-missing 5%   # overrides the config field
epg build --allow-missing 20
```

Exactly the allowance passes, as "up to" reads: `--allow-missing 5%` on a run
that lost 5% exits 0. The share is of everything the run has an answer about —
fetched, taken from the cache, and kept as unchanged — so a run that fetched
almost nothing because the cache was fresh is not thereby judged to have lost
most of its guide. A day that came back **empty** is not missing: a channel with
nothing on is an answer.

**A site that answered nothing is outside this, whatever it says.** A site that
could not be read, or whose channel list never arrived, has no channel list — so
the channel-days it would have covered are not knowable, and weighing "one site"
against a guide of thousands would score a source that is entirely down as a
rounding error. The summary names those apart (`1 site answered nothing`), and
they always exit 1.

A `tv_grab_*` shim reads the same field, for the same reason: it is the config's
answer, not the command's.

### `--offset`

`--offset` shifts the window only; "now" is unchanged, so staleness and the
`grabbedAt` stamp keep using the real current time and the post-grab prune
never removes a day inside the window. Negative values work in both the
`--offset -1` and `--offset=-1` forms.

## How caching works

Each `site + channel + day` is one cache entry — one file,
`<dir>/<site>/<channel>/<day>.ndjson`, beginning with when it was grabbed and
how much it holds. A staleness check reads that much of it and no more. Beside
those, a site may keep a little of [what it remembers between
runs](./api.md#what-a-site-remembers-between-runs) — `<dir>/<site>/<key>.json`,
one file per group, holding no listings and left alone by a prune. On every
run a channel-day is refetched only when:

- it is not cached yet (e.g. day 14 after a day passed), or
- it is within `alwaysRefetchDays` from today (near-term EPG changes often), or
- it was grabbed more than `maxAgeDays` ago, or
- it holds no programmes and was grabbed more than `emptyMaxAgeDays` ago, or
- it was written in a shape this version does not read, or
- the policy says to refetch the whole window (`refetchAll`, i.e. `--refresh`).

That last one is what an entry's own `schema` number is for: it records what the
entry is, beside when it was grabbed and the version that wrote it, so an upgrade
that changes how entries are stored refetches them instead of misreading them.
Nothing migrates — a day of listings costs one request — and no old cache has to
be deleted by hand.

Everything else is served from disk. A run says how many channel-days came back
empty (`Grab done: 42 fetched (3 empty), …`), since nothing else would: no
request failed, and the entries are cached like any other. Old days are pruned automatically after a
grab (disable with `cache.prune: false`).

A refetched channel-day need not mean a download. A site with
[`conditionalGet`](./site-config.md#asking-only-when-it-is-worth-it) asks the
source whether anything has changed — with an `ETag`, a `Last-Modified`, or the
entry's own `grabbedAt` — and a `304` keeps what is cached: nothing written,
`grabbedAt` unmoved, and counted separately (`…, 3 unchanged, …`) from the
channel-days a run never asked about at all.

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
  - `backfill` — the first covering site contributes everything it has, and a lower-priority one only what falls in a hole it left; nothing is combined — see [filling the gaps](#filling-the-gaps)

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
| `dropContainers` | `true` | Drop a programme that wholly contains two or more others — a magazine block published beside its own parts. `clipOverlaps` cannot reach it, and without this the guide genuinely overlaps. |
| `clampToWindow` | `false` | Leave out programmes starting outside the guide's window. Off, because a source handing back a few hours past the last day is giving you something. |
| `fillGaps` | `false` | Put a placeholder where the schedule says nothing — see [filling the gaps](#filling-the-gaps). The one rule here that **invents**, which is why it is off. |
| `transform` | — | The last word on every programme: `(programme, { xmltvId, next, log, warn }) => programme \| null`. |

A programme with no end is what a consumer can do least with — tvheadend shows
a zero-length event, some players nothing at all — and two programmes claiming
the same minute means it has to guess which is on. Both are why `tv_sort` exists
in the Perl suite; here they are the default.

**A magazine block is the third.** Some sources publish `Breakfast` 06:00–09:00
*and* the `News` and `Weather` inside it. That is not a programme overrunning
the next one, so `clipOverlaps` leaves it alone — correctly, since a container
shares its start with the first thing it contains and pulling its `stop` back
would leave a programme of no length. What comes out is a guide with real
overlaps in it, which [`epg validate`](#validating-a-guide) reports as an error.
`dropContainers` keeps the parts and drops the block, because the parts are the
finer answer to what is on at 06:30. It takes **two** contained programmes: one
is as likely a source's rounding, which is `clipOverlaps`'s job, and dropping on
it would throw a programme away over a minute. `tv_remove_some_overlapping` is
the same rule in the Perl suite.

The last programme of a channel keeps no `stop`: there is nothing after it to
take one from. Neither rule invents anything — the end comes from the next
programme's start or not at all. `fillGaps` is the one that does invent, and is
off for that reason.

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
already run, so the gap stays — unless `fillGaps` is on, which covers it with
placeholder blocks. To drop something and have the gap **close**, use
[a site's own `transform`](./site-config.md#fixing-up-one-source), which runs
before them — or `clampToWindow` for what falls outside the window. Dropping a
source's own padding is the case to watch: through the guide's `transform` with
`fillGaps` on, you replace it with padding of a different shape rather than
closing up.

It also carries `log` and `warn`, for the thing a mapping like the one above
always turns out to need — saying which category it had no mapping for:

```ts
transform: (programme, { xmltvId, warn }) => {
  const unmapped = programme.category?.filter((c) => GENRES[c.value] === undefined);

  if (unmapped?.length) {
    warn('no genre mapping', { xmltvId, categories: unmapped.map((c) => c.value) });
  }

  return programme;
}
```

These arrive as `merge:note` and `merge:warning` rather than the `site:note` a
site's own code sends, and carry no site — the code is the config's own, so
there is nobody to attribute it to.

### Filling the gaps

A channel's day is rarely fully covered. A source stops publishing at midnight,
drops an afternoon, or has nothing at all for a channel it lists. Two things can
close that, and they are meant to be used in that order.

**Real data first.** `programmeStrategy: 'backfill'` lets a lower-priority
source contribute only what the higher-priority one is missing:

```ts
merge: { programmeStrategy: 'backfill' }
```

Where both describe a broadcast the higher one's is kept **whole** — nothing is
combined, which is the whole difference from `merge`. That is what you want from
a good-but-partial primary and a broad-but-worse fallback: the good source's
titles and descriptions, and the other one's coverage of the hours it does not
reach.

Two things it does deliberately. A programme with no `stop` is taken to run to
the next start of its own list, capped at six hours — the same reading `fillStop`
will make later, so the two agree about where a hole is; without it a list of
bare starts would look entirely empty and backfill would be `concat`. And a
candidate that only **partly** fits a hole is dropped rather than clipped:
clipping would pull back the `stop` of the programme that outranks it, and
moving a start would be a lie about when a broadcast began. Two sources on
different grids may therefore contribute nothing at the seam.

**Then a placeholder for what is left.** `fillGaps` puts synthetic programmes in
the holes:

```ts
merge: {
  fillGaps: {
    blockMs: 30 * 60_000,   // one block, the default
    minMs: 60_000,          // ignore anything shorter, the default
    maxMs: 6 * 60 * 60_000, // leave a longer gap alone as genuinely off air
    edges: true,            // the window's start and end too, the default
    title: 'No information',
  },
}
```

| field | default | what it does |
|---|---|---|
| `blockMs` | 30 minutes | How long one block runs. A three-hour hole becomes six blocks, not one three-hour programme, because a single long bar reads as a real broadcast |
| `minMs` | 1 minute | Leave a shorter gap alone. Sources publishing a nominal duration against real starts leave gaps of seconds all day; without a floor a channel collects hundreds of forty-second placeholders |
| `maxMs` | unset | Leave a longer gap alone. The judgement `fillStop`'s six-hour cap already makes, offered rather than assumed |
| `edges` | `true` | Fill from the window's start to the first programme and from the last to the window's end. A channel with nothing at all is edges and nothing else |
| `title` | `'No information'` | What a block says, or `({ xmltvId, gapStart, gapEnd, index }) => string` |
| `programme` | — | The last word on a block: return it, a different one, or nothing to leave it out. Where a `category` or a `desc` would go |

Blocks are laid **end to end and half-open**, and the last of a gap is truncated
to it rather than overrunning — so a filled guide still passes
[`epg validate`](#validating-a-guide) with no overlaps. The title carries no
`lang`: the guide cannot know the channel's language, and the wrong one is worse
than none.

**Be clear about what this is.** Everything else in this section reshapes what a
source gave you. This adds programmes no source reported, so a guide it has
touched is no longer a record of what anyone said — which is why it is off by
default. The reason to turn it on is a consumer that handles a partly-covered
day badly; measure yours before assuming it is the problem.

Two limits. A programme with no `stop` leaves the gap after it unmeasurable, so
it is skipped rather than guessed at — with `fillStop: false` that is nearly
every programme, and `fillGaps` will do little but the leading edge. And it does
nothing under `channelStrategy: 'keep-all'`, where a channel has more than one
entry and each would fill the other's silence; it says so once rather than
doing it.

`epg filter` does not fill: it subsets a guide somebody else wrote, and never
runs a merge.

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

## Derived channels

A `+1` channel carries the same schedule as its base an hour later. That is
arithmetic on days already in the cache, not a second source to grab — so
declare it and it costs nothing:

```ts
export default defineConfig({
  sites: [/* … */],
  derived: [
    { xmltvId: 'skyone.plus1.uk', from: 'skyone.uk', offset: 60 },
    { xmltvId: 'markiza.plus1.sk', from: 'markiza.sk', offset: 60, name: 'Markíza +1' },
  ],
});
```

| field | type | default | what it is |
|---|---|---|---|
| `xmltvId` | `string` | **required** | The new channel's id. Nothing else may produce it. |
| `from` | `string` | **required** | The `xmltvId` it shifts — any site's channel, or another derived channel. |
| `offset` | `number` | **required** | Minutes, and under a day. `60` is a `+1`; a negative value shifts earlier. |
| `name` | `string` | the source's name with the shift appended | Its display name. |
| `logo` | `string` | the source's | An icon of its own. |
| `lang` | `string` | the source's | The language of `name`. |
| `channelInfo` | `(element) => XmltvChannel` | — | The last word on the `<channel>` element, given the one this would have emitted. |

[`epg channels`](#which-channels-will-get-no-guide) is what usually sends you here. Shown a
playlist wanting `Sky One +1`, it refuses to map it onto `skyone.uk` — an
hour-wrong schedule is worse than none — and reports that it *looks like* a
shift of it instead. Declaring one is how that gets answered, and the report
stops asking: the default name is the one a playlist uses, so the channel then
matches by name even before its `tvg-id` is set.

`from` may name another derived channel. A chain is resolved to its root with
the offsets summed, since a shift of a shift is one shift, and it takes its name
from that root — so a `+2` reads as one.

**What moves:** the start, the stop, and the PDC/VPS starts. Not `<date>`, which
is the year the programme was made, and not `previously-shown`, which describes
a real earlier airing on a real other channel. Each time keeps the UTC offset it
was published in, so a guide written in `+0200` stays in `+0200`.

**What it costs:** no requests, but a second read. A derived channel reads its
source's cached days again, so a channel with three derivations is read four
times, and each site's `transform` runs over the same rows four times. Write
transforms that do not care how often they run.

**The hole at one end.** A `+1` channel's first hour would have to come from the
day *before* the window, which was never grabbed — so the guide's first hour of
a `+1` channel is empty, and its last hour spills past the end (kept by default,
like any spill; `clampToWindow` removes it). A negative offset mirrors both.
Grab a day more than you publish — `days: 8` with `clampToWindow: true` — for a
derived channel with no hole in it.

**Limits.** An offset must be under a day: the merge holds a day back and emits
what no later day can reach, and a bigger shift would spend the margin that
leaves for sources whose own day runs 06:00 to 06:00. A day's shift is the same
schedule again anyway. A declaration that cannot be right fails the run — a
cycle, an id a site already produces, an offset of a day or more. One whose
`from` no site produces only warns and is skipped, since a fetched channel list
that came back short does that, and `epg serve` must not stop for it.

A derived channel is listed and selectable in a generated `tv_grab_*` too, so
tvheadend can map it. Selecting it pulls its source in behind it, since there is
no shifting a channel nobody grabbed.

---

[← README](../README.md) · [Site configuration](./site-config.md) · [XMLTV parser](./xmltv.md) · [XMLTV grabber](./tv-grab.md) · [Programmatic API](./api.md)

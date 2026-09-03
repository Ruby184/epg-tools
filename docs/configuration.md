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
| `merge` | `MergeOptions` | `{ channelStrategy: 'merge-programmes', programmeStrategy: 'merge', fillStop: true, clipOverlaps: true }` | How several sites covering one channel are combined, what counts as the same broadcast (`match`), and how the programmes are [cleaned up](#cleaning-up-the-output) on the way out — see [Merge strategies](#merge-strategies). |
| `meta` | `XmltvDocumentMeta` | — | Attributes for the root `<tv>` element — see [below](#root-tv-attributes). |
| `indent` | `string \| number` | omitted — compact | Pretty-print the guide with this indentation, mirroring `JSON.stringify`: a number of spaces or a string like `'\t'`. |
| `extensions` | `boolean \| string[] \| ExtensionFilter` | `true` — all of them | Which provider extensions the guide carries — see [Provider extensions](#provider-extensions). `false` leaves every one out, which is what makes the guide valid against the DTD. |
| `serve` | `{ port?, host?, path?, compress? }` | `8080`, `127.0.0.1`, `/guide.xml`, `gzip` | Where `epg serve` listens and what it serves — see [serving the guide](#serving-the-guide). |
| `allowMissing` | `number \| string` | none — anything missing fails | How much of the guide may be missing and the run still exit **0**: a number of channel-days, or a share like `'5%'` — see [allowing some of the guide to be missing](#allowing-some-of-the-guide-to-be-missing). |
| `reporter` | `'text' \| 'json' \| 'progress'` or a factory | `'text'` | How a run reports what it is doing — see [how much it says](#how-much-it-says). `--reporter` overrides it among the names. |

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
epg validate         # read the guide and report what is wrong with it
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
| `--report <how>` | `validate` only: `text` (default) or `json` — see [validating a guide](#validating-a-guide) |
| `--strict` | `validate` only: count warnings as failures too |
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
it. That reading is metadata only: the same lookups a merge *begins* with, and
none of the payload reads, parsing or serializing that follow. It is worked out
at most once a second (`revalidateMs`), and once for however many polls arrive
together.

The one thing it cannot see is a channel that was not in the window when the
reading was taken: the entries are looked up by the channel list already in
hand, so a grab that adds a channel and refreshes nothing else writes a key
nobody asks about. The list is therefore resolved again when the fingerprint
moves, and in any case once its `sitesMaxAgeMs` (ten minutes) is up — a ceiling
on how long a new channel can stay invisible, without letting a poll drive the
request that resolving a fetched channel list can mean.

The guide streams straight into the response, so nothing is held in memory; a
consumer that hangs up mid-guide stops the merge feeding it. `compress` (`gzip`
by default) is used when the request's `Accept-Encoding` names it, and
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
with. It does not grab — it serves what is in the cache, so run `epg grab` on
whatever schedule suits and leave this listening.

`serveGuide(config, options)` is the same thing as a library, returning
`{ url, port, close, closed }` — see [the API reference](./api.md).

### Validating a guide

`epg validate` reads a guide and says what is wrong with it — the config's own
`output` by default, or a file named on the command line. A `.gz`, `.br` or
`.zst` name is decompressed on the way in, since that is what the name promised.

```sh
epg validate                       # the guide this config writes
epg validate public/epg.xml.gz     # or any other
epg validate --report json         # one document for CI to read
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

**`--report` is not `--reporter`.** They sound alike and answer different
questions: `--reporter` is how a *run* says what it is doing while it does it, a
stream of events with no end until the run has one. A report is one document,
written once, about a file that already exists — which is what a CI step wants:
an `ok` to branch on and a list to print.

| severity | what it means |
|---|---|
| `error` | the guide is wrong: a `<programme>` naming a channel nothing describes, a `<channel>` with no `<display-name>`, two channels sharing an id, a programme that stops before it starts, or a document that ends mid-element |
| `warning` | the parser found something and coped: a dropped attribute, a duplicated element, markup it skipped — and [provider extensions](#provider-extensions), which are deliberate and are what `--no-extensions` removes |

What it does **not** check is element *order*. Parsing produces a model, and a
model has no order, so `<desc>` before `<title>` is invisible here. For that,
`xmllint --valid` beside a copy of `xmltv.dtd` is the tool — and a guide written
with `--no-extensions` is what makes that check pass.

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

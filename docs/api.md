# Programmatic API

Everything the `epg` CLI does is available as a library. The package is
**ESM-only** and ships types for every entry point.

- [Running a build](#running-a-build)
- [Reporting what a run is doing](#reporting-what-a-run-is-doing)
- [Streaming a guide](#streaming-a-guide)
- [Entry points](#entry-points)
- [Export map](#export-map)

## Running a build

```ts
import { build, runGrab, runMerge, textReporter } from 'epg-tools';
import config from './epg.config.ts';

const summary = await build(config, { reporter: textReporter({ stream: process.stdout }) });
console.log(summary); // { fetched, fromCache, failed, ... }
```

| function | does |
|---|---|
| `build(source, options?)` | Grab what is stale or missing, then write the merged guide. Resolves to a `GrabSummary`. |
| `runGrab(source, options?)` | Grab only — fills the cache, writes no guide. |
| `runMerge(source, options?)` | Write the guide from the cache only. |
| `guideStream(source, options?)` | The merged guide as an async generator of XML chunks. |
| `createCacheStore(config)` | The cache a config describes: a `CacheManager` over the driver its `driver` names or builds. |

`GrabSummary` counts `fetched` (channel-days that went to the network),
`fromCache` (skipped because the cache was fresh), `empty`, `unchanged`,
`failed` and `sitesFailed` — six numbers, and nothing that grows with the size
of the guide.

`failed` is a **count** of channel-days that did not come back. `sitesFailed`
counts sites that answered nothing at all — one that could not be read, or whose
channel list never arrived. They are apart because a site has no grid to spread
it over: a site that could not be read has no channel list, so what it *would*
have covered is not knowable, and adding one to a count of channel-days would
make a dead source look like a rounding error beside a guide of thousands.

Which is the difference [`allowMissing`](./configuration.md#allowing-some-of-the-guide-to-be-missing)
turns on: a threshold forgives scattered channel-days, and never a site that
answered nothing. `fellShort(summary, allowMissing)` is that rule, exported so a
caller of `runGrab` decides an exit code exactly as the CLI and a `tv_grab_*`
shim do.

It used to be the errors themselves, which for a site that is down meant seven
thousand live `Error`s with stacks retained for the length of the run. What each
failure *was* arrives as it happens, as an `entry:failed`, `request:failed` or
`site:failed` event — see [reporting what a run is doing](#reporting-what-a-run-is-doing)
— so a caller that wants the list keeps one of its own and decides how long it
may grow.

`build`, `runGrab`, `runMerge` and `guideStream` all take either shape — a
plain `EpgConfig` or a `defineConfig` factory still waiting for its answers —
so the import above works whichever your config file is, exactly as the CLI
does it. A build resolves the factory once and hands the result to both halves,
so the grab and the merge that follows it cannot disagree. `createCacheStore`
is the exception: it takes a resolved `EpgConfig`
(`resolveConfigSource(config)` if you have the other kind).

Each of them lets go of its cache when it is done, however it ended — a driver
may be holding a database handle for the length of a run. Holding one yourself,
`close()` is the same thing, and `await using` is the tidier way to say it:

```ts
await using cache = await createCacheStore(config);
```

`RunOptions`:

| option | type | default | what it does |
|---|---|---|---|
| `now` | `Date` | the current time | The reference for staleness and the `grabbedAt` stamp — and, unless `offset` says otherwise, the first day of the window. Pass one to make a run reproducible in a test. |
| `offset` | `number` | `0` | Shift the window this many days from `now`'s day; may be negative. `now` itself is unchanged, so staleness and pruning keep using the real current time. |
| `reporter` | `(event: EpgEvent) => void` | none | Where the run's events go — see [reporting what a run is doing](#reporting-what-a-run-is-doing). Omit for silence. |
| `cache` | `CacheStore` | the one the config describes | Use this store instead. It stays the caller's — nothing here closes what it did not open — which is for a process running several builds, or a test with a store already in hand. |
| `signal` | `AbortSignal` | none | Cancel the run — see [Cancelling a run](./configuration.md#cancelling-a-run). A grab resolves with the partial summary; a merge rejects, and the guide it was writing is discarded rather than replacing the one in place. `build` skips the merge entirely if the grab was cancelled. |

## Reporting what a run is doing

A run does not print anything. It **emits events**, and what to do with them is
the caller's:

```ts
import { build, textReporter } from 'epg-tools';

await build(config, {
  reporter: textReporter({ stream: process.stdout, level: 'debug' }),
});
```

A reporter is a function of one argument, so anything can be one:

```ts
await build(config, {
  reporter: (event) => {
    if (event.type === 'entry:failed') {
      metrics.increment('epg.failed', { site: event.site });
    }
  },
});
```

Every event carries a `type`, the fields that type is about, a `level`
(`error`, `warn`, `info`, `debug`) and a `phase` (`run`, `grab`, `merge`,
`prune`). The level and phase follow from the type rather than being chosen at
the call site — `EVENT_KINDS` is the whole table, and it is the whole answer to
"what does the default verbosity show?".

| group | types |
|---|---|
| the run | `run:cancelled`, `grab:done` |
| a site | `site:started`, `site:done`, `site:failed`, `site:note`, `site:warning` |
| one channel-day | `entry:cached`, `entry:fetched`, `entry:appended`, `entry:unchanged`, `entry:failed` |
| one request | `request:started`, `request:done` (with `ms`), `request:failed` |
| a whole-document source | `stream:gaps`, `stream:ignored` |
| pacing | `pacing:held`, `pacing:slowed`, `pacing:recovered`, `pacing:rateLimit` |
| merging, tidying | `merge:channel`, `merge:done`, `prune:done` |

Two things about the shape are deliberate, and both are the difference between a
structured sink and a string one. **A failed request is one event, not one per
channel-day it covered** — `request:failed` carries `entries`, so a site that is
down says so once rather than seven thousand times, and no `entry:failed` is
emitted for those. And **`site` is a field**, never a prefix: a reporter that
shows it decides how, and a single-site grabber leaves it out.

**Filtering is a reporter's job and happens nowhere else.** A sink of your own
is told everything, which is what makes one worth writing; the ones below take a
`level` and drop what is under it.

### The ones this package ships

Each is built by a function that takes options, so naming one and configuring it
are the same act:

| built by | writes |
|---|---|
| `textReporter({ stream, errorStream?, level?, failures?, failureCap?, prefix? })` | lines of text — what a person reads and a CI log keeps |
| `jsonReporter({ stream, level?, pretty? })` | one JSON object per line, for a pipeline |
| `progressReporter({ stream, … })` | one line, rewritten in place — `textReporter`'s options, plus a cursor |

### Naming one in a config

`cache.driver` takes a name or a factory, and a reporter works the same way, so
a config file can choose without the caller writing code:

```ts
export default defineConfig({
  reporter: 'json',
  // or, configured:
  reporter: ({ stdout, level }) => textReporter({ stream: stdout, level, failures: 'inline' }),
  // …
});
```

A factory is handed `{ stdout, stderr, level, failures? }` — the streams the
command itself was given and what it was asked for, which is what keeps a
command something a test can drive. `REPORTER_NAMES` is the list of names, and
`reporterFor(nameOrFactory, runtime)` does the resolving; `--reporter` overrides
the config, as a flag does everywhere else here, but only among the names, since
a command line cannot pass a function.

`textReporter` owns the one policy `render` cannot: what to do with a failure.
`failures: 'block'` (the default) holds them and writes one block, capped at
`failureCap` (20, `0` for all), when the run finishes — which keeps a site that
is down from burying the progress it interleaved with. `failures: 'inline'`
writes each where it happens and holds nothing, for a log where interleaving is
the point. The collecting and the flushing happen whatever the `level` is: asking
for errors only must still end with the errors.

`progressReporter` is what `site:started` exists for: by the time it fires the
planner has resolved the channel list and swept the cache, so `entries` — the
channel-days that will actually be fetched — is a denominator that is real. It
measures against those and not against `requests`, because a whole-document
source makes *one* request and two thousand channel-days out of it. Underneath
it is a `textReporter`, because a warning, a failure, a site's own message and
the summary are all things to keep: the line is erased, they are written, and it
is drawn again. It draws only at `level: 'info'` and only on a stream with a
cursor to move; anywhere else — a pipe, a file, `TERM=dumb`, `--verbose` — it
*is* that text reporter, so what a script reads never depends on whether someone
was watching.

`render(event, prefix?)` is the line by itself, for a caller who wants the text
and not the policy — it answers `undefined` for a failure, which
`renderFailure(event, prefix?, cause?)` covers.

At `debug`, a failure line carries its `cause` chain. It is not there by default
because a chain per failure is noise until you are looking for one — but the run
builds them, and `errorMessage` reads `.message` alone, so "this channel-day is
unchanged, but nothing is cached for it" used to arrive without the `304` that
said so. `errorChain(error)` is the same walk, exported for a caller doing its
own rendering.

## Streaming a guide

`guideStream(config, options)` is the file-less form of `runMerge` — the same
merged guide as an async generator of XML chunks, for piping to stdout or an
HTTP response with constant memory:

```ts
import { guideStream } from 'epg-tools';
import { Readable } from 'node:stream';

await pipeline(Readable.from(guideStream(config, { offset: 1 })), process.stdout, { end: false });
```

`generateGuide` from `epg-tools/merge` is the lower-level form, taking the
pieces rather than a config:

```ts
import { Readable } from 'node:stream';
import { generateGuide } from 'epg-tools/merge';

reply.type('application/xml');
return Readable.from(generateGuide({ sites, cache, days: 14 }));
```

Serialization is **compact by default** — no whitespace between elements, which
is smaller and what a machine consumer like tvheadend wants. Pass `indent` to
pretty-print, mirroring `JSON.stringify`: a number of spaces or a string like
`'\t'`. It is accepted by `writeXmltvStream`, `writeXmltvToFile`,
`serializeChannel`, `serializeProgramme`, `serializeDocumentHeader` /
`serializeDocumentFooter`, `serializeProcessingInstruction`, `generateGuide` /
`writeGuide`, and `defineConfig`.

`extensions` travels with it, through all the same entry points: `false` writes
a guide with no [provider extensions](./xmltv.md#provider-extensions) in it and
so one that validates against the DTD, an array of names keeps those, and a
filter decides one at a time. The cache keeps everything either way, so two
documents come out of one grab — see [leaving extensions
out](./xmltv.md#leaving-extensions-out).

## Serving a guide

`serveGuide(config, options)` is `guideStream` behind an HTTP server that
answers conditionally, for a consumer that polls:

```ts
import { serveGuide } from 'epg-tools';

const server = await serveGuide(config, { port: 8080 });

console.log(`serving ${server.url}`);
await server.closed;          // resolves when it stops
```

It resolves once listening, and gives back `{ url, port, reload, close, closed }`.
`options` takes `port`, `host`, `path`, `compress`, `concurrency`,
`revalidateMs`, `sitesMaxAgeMs`, `reloadOn`, and the `signal`, `reporter`,
`now`, `offset` and `cache` a run takes — a `cache` handed in stays the
caller's, and one it opened is closed by `close()`.

The validator is the cache's, not the document's: a guide is a generator, so
hashing its bytes would mean buffering it. What is read per poll is the window's
metadata — the same lookups a merge begins with, without the payload reads and
serializing that follow — at most once per `revalidateMs`, and once for however
many polls arrive together. Those lookups are keyed by the channel list in hand,
which is re-resolved when the fingerprint moves and at least every
`sitesMaxAgeMs` (ten minutes), so that a grab which only adds a channel is not
invisible until midnight. See [serving the
guide](./configuration.md#serving-the-guide) for what that costs and saves.

`reload()` resolves the channel lists again on the next poll, whatever those
clocks say — the ceiling is a guess, and this is the caller saying they know. It
is lazy (it marks; the next request does the work) and it asserts nothing: if
resolving finds the same channels, the ETag is unchanged and pollers still get
`304`s.

`reloadOn` is where that comes from as an event — the repeatable counterpart to
`signal`, which fires once and is over:

```ts
const reloadOn = new EventTarget();

await serveGuide(config, { reloadOn });
reloadOn.dispatchEvent(new Event('reload', { cancelable: true })); // false: taken
```

The listener cancels the event, which is how a dispatcher learns somebody acted
on it. That is what lets the `epg` bin point `SIGHUP` at one target for every
command and still leave `SIGHUP` meaning what it always did for the commands
that end by themselves.

## Entry points

```ts
import { build, defineConfig, defineSiteConfig } from 'epg-tools';
import { parseXmltvFile, writeXmltvStream } from 'epg-tools/xmltv';
import { CacheManager, FsNdjsonCacheDriver, isStale } from 'epg-tools/cache';
import { grab, resolveChannels, siteHttp } from 'epg-tools/grabber';
import { generateGuide, writeGuide, mergeProgrammes } from 'epg-tools/merge';
import { serveGuide } from 'epg-tools/serve';
import { runXmltvGrabber, defineCapability } from 'epg-tools/tv-grab';
```

The root re-exports most of the subpaths, so a single import usually does. Two
reasons to reach for a subpath: `epg-tools/xmltv` pulls in **nothing else** —
no grabber, no cache, no config loading — so it is the one to use if all you
want is to read or write XMLTV; and a handful of names live only on a subpath
(marked below).

## Export map

### `epg-tools`

| group | exports |
|---|---|
| Config | `defineConfig`, `resolveConfigSource` |
| Answers | `createConfigContext`, `defaultsReader`, `envReader` |
| Errors | `GrabberError`, `errorMessage`, `errorChain` |
| Events | `LEVELS`, `EVENT_KINDS`, `atLevel` |
| Reporters | `textReporter`, `jsonReporter`, `render`, `renderFailure`, `isFailure`, `reporterFor`, `REPORTER_NAMES`, `DEFAULT_FAILURE_CAP` |
| Runners | `build`, `runGrab`, `runMerge`, `guideStream`, `createCacheStore` |
| Days | `toDayString`, `dayToDate`, `addDays`, `diffDays`, `dayRange` |
| Options parsing | `parseOptions`, `OptionError` |
| XMLTV | `escapeXml`, `serializeChannel`, `serializeProgramme`, `writeXmltvStream`, `writeXmltvToFile`, `parseXmltvStream`, `parseXmltvFile`, every [date helper](./xmltv.md#dates) and the [zone helpers](./xmltv.md#named-zones) |
| Cache | `CacheManager`, `CACHE_SCHEMA`, `CacheDriverBase`, `FsCacheDriver`, `FsNdjsonCacheDriver`, `FsXmltvCacheDriver`, `MemoryCacheDriver`, `NoCacheDriver`, `isStale`, `DEFAULT_STALENESS` |
| Grabber | `grab`, `defineSiteConfig`, `resolveChannels`, `resolveSites`, `channelElement`, `siteHttp`, `sitePacing`, `retryAfterMs` |
| Merge | `mergeProgrammes`, `mergeProgrammeLists`, `mergeInto`, `resolveMatch`, `normalizeTitle`, `titlesMatch`, `DEFAULT_MATCH`, `generateGuide`, `writeGuide`, `defaultChannelInfo` |

Plus the types for all of the above (`EpgConfig`, `SiteConfig`,
`GrabberChannel`, `XmltvProgramme`, `XmltvChannel`, …).

### `epg-tools/xmltv`

Zero dependencies, and nothing else in the package is loaded. Full detail in
[XMLTV parser, serializer and builders](./xmltv.md).

- **Parse** — `parseXmltvFile`, `parseXmltvStream`, `parseXmltvString`*, `XmltvParseStream`*
- **Serialize** — `writeXmltvStream`, `writeXmltvToFile`, `serializeChannel`, `serializeProgramme`, `serializeDocumentHeader`*, `serializeDocumentFooter`*, `serializeProcessingInstruction`*, `XmltvSerializeStream`*
- **Builders*** — `ProgrammeBuilder`, `ChannelBuilder`, `XmltvDocumentBuilder`
- **Dates** — `parseXmltvDate`, `formatXmltvDate`, `xmltvDate`, `getXmltvOffset`, `setXmltvOffset`, `getXmltvPrecision`, `setXmltvPrecision`, `XMLTV_OFFSET`, `XMLTV_PRECISION`, `XmltvDateError`
- **Zones** — `zonedXmltvDate`, `xmltvZone`, `setXmltvZone`, `xmltvZoneOffset` — see [named zones](./xmltv.md#named-zones)
- **Validate** — `validateXmltv` — see [validating a guide](./configuration.md#validating-a-guide)
- **Other** — `escapeXml`

`*` this subpath only — not re-exported from the root.

### `epg-tools/cache`

`CacheManager`, the drivers `FsNdjsonCacheDriver`, `FsXmltvCacheDriver`,
`MemoryCacheDriver` and `NoCacheDriver` with the abstract `FsCacheDriver` and
`CacheDriverBase` they build on, `CACHE_SCHEMA`, `STATE_SCHEMA`, `isStale`,
`DEFAULT_STALENESS`, and the `CacheStore` / `CacheDriver` /
`ChannelDayKey` / `CacheEntryMeta` / `StoredEntryMeta` / `StoredProgramme` /
`StateEntry` / `StoredStateMeta` / `FoundState` /
`StalenessPolicy` / `CacheDriverName` types.

A cache is two pieces. A **driver** answers for one store — a directory of
files, a database, a bucket — and holds no policy of its own. The
**`CacheManager`** in front of it is what a run talks to (it is a `CacheStore`,
which is what `grab` and `generateGuide` take), and it owns everything that must
be true of every driver alike: the meta an entry carries, stamped on the way in
and judged on the way out, and what to do with an entry that cannot answer for
itself — it goes, so the day reads as never grabbed and the next run fetches it.

```ts
const cache = new CacheManager({ driver: new FsNdjsonCacheDriver({ dir }) });
```

A driver is a small thing to write: `readMeta`, `read`, `write`, `delete`,
`prune`, `toStored` / `fromStored`, the three that keep [a site's
state](#what-a-site-remembers-between-runs) — `readState`, `writeState`,
`deleteState` — and, if it has them to offer, `readMetas` and `close`. It reads
and writes programmes in whatever form it keeps them —
`TStored`, which only it knows about — and the manager is what calls `toStored` /
`fromStored`, at the two moments a programme crosses into the store and back, so
no driver has to remember to. `read` and `readMeta` return `undefined` when there
is no entry, and `{ meta }` — possibly an undefined meta — when there is one that
says nothing readable; the manager tells those apart and only removes the second.

`readMetas(keys)` is the optional one worth knowing about. A grab asks about
every channel-day of its window before fetching anything, a channel's window at
a time, so a store that can settle fourteen days in one question says so here —
`SqliteCacheDriver` does, in one statement, and a 500-channel fortnight then
sweeps in 65ms rather than 115ms. A driver without it is asked one key at a time
by the manager, which is what `CacheStore.getMetas` promises whatever is
underneath: **one batch is one piece of work**, so an implementation must not
answer fourteen keys by starting fourteen reads at once — the caller has already
decided how many of these to have in flight, and for a cache of files that bound
is what keeps the descriptors down.

### What a site remembers between runs

A cache holds one more thing besides listings: what a site would otherwise have
to fetch again to get back to where it was — a channel list it was given once, an
`ETag` for a document it has already read, a token, a cursor. `CacheStore` keeps
it as one small blob per `(site, key)`:

```ts
await cache.setState('webtv.sk', 'channels', channels);

const held = await cache.getState('webtv.sk', 'channels');
// { data: [...], meta: { writtenAt, schema, writtenBy } }
```

`getState` answers `undefined` for a group nothing has written — and for one the
store cannot vouch for, which it removes on the way, so the group reads as never
written and whoever wanted it fetches it again. The envelope is stamped by the
manager exactly as an entry's meta is; `writtenAt` is the one field a caller may
set, so a run can stamp what it remembers with its own "now". Its `schema` is
`STATE_SCHEMA`, a smaller question than `CACHE_SCHEMA`: it describes the
*wrapper*, so what is inside a group can move on without voiding cached listings
or the group next to it.

Grouped by key rather than kept as one object per site, and the third reason is
the one that matters: a `merge` reading a channel list should not have to parse
every url the last grab revalidated; refreshing one group must not rewrite the
megabytes beside it; and two runs writing different groups cannot stand on each
other. A driver stores the bytes and never learns what is in them — which also
leaves it free to keep a group however it likes, an append-log replayed on read
included, so long as `readState` answers with what the last `writeState` was
given.

`FsCacheDriver` puts each group in `<dir>/<site>/<key>.json`, beside the
channel directories of the same site; a prune only ever looks at the day files,
so state outlives every listing a site has. `SqliteCacheDriver` keeps a row per
group. `MemoryCacheDriver` copies in and out, as it does with programmes.
`NoCacheDriver` remembers nothing, which is the honest answer rather than a gap.

Start from **`CacheDriverBase`** and the storing is already answered. It offers
two overridable pairs, because they are two questions:

| pair | default | override to |
|---|---|---|
| `toRecord` / `fromRecord` | a plain object whose dates are XMLTV strings, so neither the offset the source wrote them in nor how precise it was is lost through `JSON.stringify` | keep fewer fields, or ones of your own |
| `toStored` / `fromStored` | that record | say what the store actually holds — the ndjson driver makes it a line of JSON, the xmltv driver hands the programme through untouched, since a document already carries the offset and precision a record has to spell out |

### What an entry says about itself

Every entry records a `StoredEntryMeta`: `grabbedAt` and `programmeCount`, which
are what a staleness check reads, plus two versions. A cache outlives the code
that wrote it — it survives an upgrade, sits in an image, gets copied between
machines — so an entry says what it is rather than being read on the assumption
that whatever wrote it agreed with whatever is reading it.

| field | is | decides |
|---|---|---|
| `schema` | the stored shape, `CACHE_SCHEMA` as this version writes it | everything. A mismatch **either way** — older or newer — voids the entry, and the day is grabbed again. Nothing migrates: a day of listings costs one request, while code to carry an old entry forward costs something forever. |
| `writtenBy` | the package version that wrote it | nothing on its own. It is what `getMeta` can tell you when you are looking at a cache and wondering, and what `invalidate` judges by. |

`invalidate(meta, key) => boolean` on `CacheManager` is the one more reason an
entry can be void, for what the schema number does not describe — a release whose
*grabbing* changed rather than its storing, a site whose ids were renamed, a
cache to be emptied gradually. Return `true` and the entry goes, so the day reads
as never grabbed:

```ts
new CacheManager({
  driver: new FsNdjsonCacheDriver({ dir }),
  invalidate: (meta) => meta.writtenBy < '0.4.0',
});
```

It is asked about every entry a run looks at — thousands of times — so it should
decide from the meta it is given and nothing further. An entry the shape check
already refused never reaches it.

### Drivers that need no store

Two drivers need no store at all. **`MemoryCacheDriver`** keeps entries for the
life of the process — for a test, or a run with nowhere to write. It converts to
records like any JSON-shaped driver, not to preserve anything (nothing here is
serialized) but so that `read` hands back a copy: every other driver returns
something parsed out of a file or a row, and a driver holding your own objects
would let a `transform` edit the cache in place. **`NoCacheDriver`** keeps nothing,
so every day reads as never grabbed; it is for `epg grab`, whose summary is the
point, and not for `build`, which merges the guide *from* the cache and would
write an empty one.

A config names a driver — `'ndjson'`, `'xmltv'`, `'sqlite'` — or builds one. The
function gets the directory the config settled on and the run's signal, and
whatever else yours takes is in scope where the function is written, which is why
there is no options bag: a config file is TypeScript, and a closure carries more
than a bag could.

```ts
cache: {
  dir: '.epg-cache',
  driver: ({ dir, signal }) => new RedisCacheDriver({ url: process.env.REDIS_URL, dir, signal }),
}
```

Shipping a driver for other people to use? Export a **builder** — a function
taking your options and returning the factory — rather than the driver class, and
a config never has to know how the two halves fit together:

```ts
// redis-cache.ts
import type { CacheDriverFactory } from 'epg-tools';

export function redisCache(options: { url: string; prefix?: string }): CacheDriverFactory {
  return async ({ signal }) => {
    const client = await createClient({ url: options.url }).connect();

    return new RedisCacheDriver({ client, prefix: options.prefix ?? 'epg', signal });
  };
}

// epg.config.ts
export default defineConfig({
  sites,
  output: 'public/epg.xml',
  cache: { driver: redisCache({ url: process.env.REDIS_URL! }) },
});
```

That is also where anything asynchronous belongs — a connection to open, a schema
to make sure of — since the factory may return a promise and the run awaits it
before asking the cache for anything. Which is why a driver needs no `initialize`
of its own to go with `close`: nothing is ever handed a driver that is not ready,
because it was built by something that could wait.

A `build` asks the config for one cache and hands it to both halves, so a driver
that opens a database opens it once and `driver: 'memory'` is enough to build a
whole guide without touching disk. Two commands cannot share that, though: `epg
grab` and then `epg merge` are two processes, and the second finds nothing.

`new FsNdjsonCacheDriver({ dir, signal? })` — the format is the driver, and the
signal belongs to it rather than to each call, since a driver belongs to one
run. An entry is one file, so it is either there with its meta or not there at
all; a write stops before its rename, and a prune stops between days.

### `epg-tools/cache/sqlite`

`SqliteCacheDriver` — the whole cache in one file, which is what a directory of
files is worst at: a fortnight of 5,000 channels is 70,000 inodes to walk, back
up or copy into an image, and one `readdir` per channel to prune. Here a prune is
one statement the database plans itself. What you give up is reading a day's
listings with `cat`.

```ts
import { SqliteCacheDriver } from 'epg-tools/cache/sqlite';
```

Its own entry point because `node:sqlite` is not on every runtime this package
supports — Node 22.5 behind `--experimental-sqlite`, unflagged from Node 24 — and
nothing loads the module until something asks for it. `cache: { driver:
'sqlite' }` is the short way to ask, and puts `cache.sqlite` in the cache
directory; `new SqliteCacheDriver({ dir, file?, signal? })` is the long way, where
`file` names the database yourself (`':memory:'` included).

One row per channel-day: the meta columns, and the programmes as JSON. A rowid
table with a covering index over the meta, so the staleness sweep — the thing a
run does for every channel-day — is answered without touching the payload beside
it: 7,000 of them cost 80ms rather than 310ms, and reading 7,000 whole entries
670ms rather than 880ms. WAL, so a merge reading is not held up by a grab
writing, and `synchronous = NORMAL`, because a day lost to a power cut is a day
grabbed again.

### `epg-tools/grabber`

`grab`, `defineSiteConfig`, `defineStreamSiteConfig`, `resolveChannels`,
`resolveSites`, `siteHttp`, `sitePacing`, `retryAfterMs`, `channelElement`,
`defaultChannelInfo`, `SiteStateHandle`, `StateKey`,
`TrackedMap`, `channelsMaxAgeMs`, `DEFAULT_CHANNELS_MAX_AGE_DAYS`,
`UnchangedError`, `isUnchanged`.

A site comes in two shapes and `grab` takes either: `defineSiteConfig` for one
that fetches a request at a time and parses each channel-day out of it, and
`defineStreamSiteConfig` for one that [answers its whole window in one
pass](./site-config.md#sites-that-answer-in-one-pass). `AnySiteConfig` is the
union, which is what a list of sites holds.

`resolveChannels(site, { http?, signal?, state?, refresh?, now? })` returns a
site's channels whichever form they came in — a list or a fetched one — and
`resolveSites(sites, { signal?, concurrency?, store?, refresh?, now? })` does it
for several, which is what `build` uses to fix the list across the grab and the
merge. Given a `store`, both honour a site's
[`cacheChannels`](./site-config.md#keeping-a-fetched-list): a list still inside
its max age comes back without the source being asked. `siteHttp(config,
signal?)` builds the site's ky instance, and `sitePacing(config, { signal?, emit?
})` its queue. `channelElement(config, channel)` is what every `<channel>` in the
output goes through — the site's `channelInfo` if it has one,
`defaultChannelInfo` if not.

**`SiteStateHandle`** is how [what a site
remembers](#what-a-site-remembers-between-runs) is held for the length of a run —
`grab` opens one per site, and code driving a grab of its own can too:

```ts
const state = SiteStateHandle.open(cache, 'example.tv');
const maxAge = channelsMaxAgeMs(site);                     // what the site asked for

(await state.channels()).fresh(maxAge ?? 0, new Date());   // the list, while it lasts
(await state.bag()).set('cursor', 42);                     // the site's own Map
await state.save();                                        // the changed groups only
```

Each group is read on first ask and remembered, so asking twice — or from two
places at once — costs one read, and `save` writes only what changed. `bag(key?)`
names another group when one bag is not enough; both hand back a **`TrackedMap`**,
a `Map` that records which keys were touched so nothing untouched is rewritten.

### `epg-tools/merge`

`generateGuide`, `writeGuide`, `mergeProgrammes`, `mergeProgrammeLists`,
`mergeInto`, `resolveMatch`, `normalizeTitle`, `titlesMatch`, `DEFAULT_MATCH`,
`mergeChannels`*, `defaultChannelInfo`.

`writeGuide({ ...options, output, compress? })` writes where `output` says — a
path renamed into place, a Unix socket, or a stream — and compresses when asked
or when the name says so, `.gz` / `.br` / `.zst`. See
[Compressing the guide](./configuration.md#compressing-the-guide) for what each
costs on a real one. `generateGuide` yields the document itself, so a caller
piping it somewhere compresses it however they like.

`mergeProgrammeLists(lists, strategy, match?)` combines per-site lists in
priority order; `match` is a `ProgrammeMatch` object, or a predicate of
your own — see [what counts as the same
broadcast](./configuration.md#what-counts-as-the-same-broadcast).
`mergeInto(target, incoming, resolveMatch(match))` is the piece underneath it:
one source's list folded into a sorted accumulator, which is also how the guide
carries a day across the boundary into the next.

`generateGuide` takes two bounds of its own, both of which `build` fills in from
the config: `siteConcurrency`, how many sites resolve a fetched channel list at
once, and `readAhead` (from `localConcurrency`, default 16), how many
channel-days are read from the cache ahead of the writer. `readAhead: 1` reads
strictly one at a time.

### `epg-tools/serve`

`serveGuide` and the `GuideServer` / `ServeOptions` / `EpgServeConfig` types,
with `DEFAULT_SERVE_PORT`, `DEFAULT_SERVE_HOST`, `DEFAULT_SERVE_PATH` and
`DEFAULT_REVALIDATE_MS`. Loaded only when named, so nothing else pulls in
`node:http`.

### `epg-tools/tv-grab`

The XMLTV grabber protocol — see [Using it as an XMLTV grabber](./tv-grab.md).
Most users need only `runXmltvGrabber`; the rest is there so a capability, or a
caller doing its own prompting, can reuse the same pieces.

| group | exports |
|---|---|
| Entry point | `runXmltvGrabber` |
| Errors | `GrabberError` |
| Capabilities | `defineCapability`, `DEFAULT_CAPABILITIES`, `definedCapabilities`, `capabilityNames`, `runCapabilities`, `runAdjustTasks`, `runConfigLoadedTasks` |
| Shipped capabilities | `manualConfigCapability`, `apiConfigCapability`, `cacheCapability`, `preferredMethodCapability`, `newChannelsCapability`, `lineupsCapability`, `CHANNEL_UPDATES`, `NEW_CHANNELS_CODE` |
| Stages | `defineStages`, `DEFAULT_STAGES`, `appendStage`, `findStage`, `resolveStages`, `renderStageXml`, `renderSelectChannelsStage`, `SELECT_CHANNELS`, `END` |
| Configuring | `runConfigure`, `createPrompter`, `parseSelection` |
| Config file | `loadGrabberConfig`, `saveGrabberConfig`, `parseGrabberConfig`, `serializeGrabberConfig`, `defaultConfigFile`, `grabberConfReader` |
| Channels | `listChannelsXml`, `listChannelChoices`, `applyChannelSelection`, `resolveChannelIds` |
| Lineups | `lineupsFromSites`, `serializeLineup`, `serializeLineups` |
| Options | `parseGrabberOptions`, `usage`, `help`, `KNOWN_CAPABILITIES` |

---

[← README](../README.md) · [Configuration & CLI](./configuration.md) · [Site configuration](./site-config.md) · [XMLTV parser](./xmltv.md) · [XMLTV grabber](./tv-grab.md)

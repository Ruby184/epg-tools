# Programmatic API

Everything the `epg` CLI does is available as a library. The package is
**ESM-only** and ships types for every entry point.

- [Running a build](#running-a-build)
- [Streaming a guide](#streaming-a-guide)
- [Entry points](#entry-points)
- [Export map](#export-map)

## Running a build

```ts
import { build, runGrab, runMerge } from 'epg-tools';
import config from './epg.config.ts';

const summary = await build(config, { logger: console.log });
console.log(summary); // { fetched, fromCache, failed }
```

| function | does |
|---|---|
| `build(source, options?)` | Grab what is stale or missing, then write the merged guide. Resolves to a `GrabSummary`. |
| `runGrab(source, options?)` | Grab only — fills the cache, writes no guide. |
| `runMerge(source, options?)` | Write the guide from the cache only. |
| `guideStream(source, options?)` | The merged guide as an async generator of XML chunks. |
| `createCacheStore(config)` | The cache a config describes: a `CacheManager` over the driver its `format` names. |

`GrabSummary` counts `fetched` (channel-days that went to the network) and
`fromCache` (skipped because the cache was fresh); `failed` is the **list** of
errors, not a count, so `summary.failed.length` is what to check.

A `failed` entry names the channel-day it is about, except where the failure is
the whole site's — a site that cannot be read at all, because it is missing
`site`, `channels`, `request` or `parseDay`, is one entry with `channelId` and
`day` as `*`. That is checked before the site's first request, and it fails only
that site: the others in the same run carry on.

`build`, `runGrab`, `runMerge` and `guideStream` all take either shape — a
plain `EpgConfig` or a `defineConfig` factory still waiting for its answers —
so the import above works whichever your config file is, exactly as the CLI
does it. A build resolves the factory once and hands the result to both halves,
so the grab and the merge that follows it cannot disagree. `createCacheStore`
is the exception: it returns synchronously, so it takes a resolved `EpgConfig`
(`resolveConfigSource(config)` if you have the other kind).

`RunOptions`:

| option | type | default | what it does |
|---|---|---|---|
| `now` | `Date` | the current time | The reference for staleness and the `grabbedAt` stamp — and, unless `offset` says otherwise, the first day of the window. Pass one to make a run reproducible in a test. |
| `offset` | `number` | `0` | Shift the window this many days from `now`'s day; may be negative. `now` itself is unchanged, so staleness and pruning keep using the real current time. |
| `logger` | `(line: string) => void` | none | Progress, line by line. Omit for silence. |
| `signal` | `AbortSignal` | none | Cancel the run — see [Cancelling a run](./configuration.md#cancelling-a-run). A grab resolves with the partial summary; a merge rejects, and the guide it was writing is discarded rather than replacing the one in place. `build` skips the merge entirely if the grab was cancelled. |

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

## Entry points

```ts
import { build, defineConfig, defineSiteConfig } from 'epg-tools';
import { parseXmltvFile, writeXmltvStream } from 'epg-tools/xmltv';
import { CacheManager, FsNdjsonCacheDriver, isStale } from 'epg-tools/cache';
import { grab, resolveChannels, siteHttp } from 'epg-tools/grabber';
import { generateGuide, writeGuide, mergeProgrammes } from 'epg-tools/merge';
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
| Errors | `GrabberError` |
| Runners | `build`, `runGrab`, `runMerge`, `guideStream`, `createCacheStore` |
| Days | `toDayString`, `dayToDate`, `addDays`, `diffDays`, `dayRange` |
| Options parsing | `parseOptions`, `OptionError` |
| XMLTV | `escapeXml`, `serializeChannel`, `serializeProgramme`, `writeXmltvStream`, `writeXmltvToFile`, `parseXmltvStream`, `parseXmltvFile`, and every [date helper](./xmltv.md#dates) |
| Cache | `CacheManager`, `CacheDriverBase`, `FsCacheDriver`, `FsNdjsonCacheDriver`, `FsXmltvCacheDriver`, `isStale`, `DEFAULT_STALENESS` |
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
- **Other** — `escapeXml`

`*` this subpath only — not re-exported from the root.

### `epg-tools/cache`

`CacheManager`, the drivers `FsNdjsonCacheDriver` and `FsXmltvCacheDriver` with
the abstract `FsCacheDriver` and `CacheDriverBase` they build on, `CACHE_SCHEMA`,
`isStale`, `DEFAULT_STALENESS`, and the `CacheStore` / `CacheDriver` /
`ChannelDayKey` / `CacheEntryMeta` / `StoredEntryMeta` / `StoredProgramme` /
`StalenessPolicy` / `CacheFormat` types.

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
`prune`, `toStored` / `fromStored`, and `close` if it holds something open. It
reads and writes programmes in whatever form it keeps them — `TStored`, which
only it knows about — and the manager is what calls `toStored` / `fromStored`, at
the two moments a programme crosses into the store and back, so no driver has to
remember to. `read` and `readMeta` return `undefined` when there is no entry, and
`{ meta }` — possibly an undefined meta — when there is one that says nothing
readable; the manager tells those apart and only removes the second.

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

`new FsNdjsonCacheDriver({ dir, signal? })` — the format is the driver, and the
signal belongs to it rather than to each call, since a driver belongs to one
run. An entry is one file, so it is either there with its meta or not there at
all; a write stops before its rename, and a prune stops between days.

### `epg-tools/grabber`

`grab`, `defineSiteConfig`, `resolveChannels`, `resolveSites`, `siteHttp`,
`sitePacing`, `retryAfterMs`, `channelElement`, `defaultChannelInfo`.

`resolveChannels(site, { http?, signal? })` returns a site's channels whichever
form they came in — a list or a fetched one — and `resolveSites(sites, {
signal?, concurrency? })` does it for several, which is what `build` uses to
fix the list across the grab and the merge. `siteHttp(config, signal?)` builds
the site's ky instance, and `sitePacing(config, { signal?, log? })` its queue.
`channelElement(config, channel)` is what every `<channel>` in the output goes
through — the site's `channelInfo` if it has one, `defaultChannelInfo` if not.

### `epg-tools/merge`

`generateGuide`, `writeGuide`, `mergeProgrammes`, `mergeProgrammeLists`,
`mergeInto`, `resolveMatch`, `normalizeTitle`, `titlesMatch`, `DEFAULT_MATCH`,
`mergeChannels`*, `defaultChannelInfo`.

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

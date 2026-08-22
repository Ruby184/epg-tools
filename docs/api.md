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
| `createCacheStore(config)` | The cache store a config describes — the class its `format` names. |

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
`serializeDocumentFooter`, `generateGuide` / `writeGuide`, and `defineConfig`.

## Entry points

```ts
import { build, defineConfig, defineSiteConfig } from 'epg-tools';
import { parseXmltvFile, writeXmltvStream } from 'epg-tools/xmltv';
import { FsNdjsonCacheStore, isStale } from 'epg-tools/cache';
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
| Cache | `FsCacheStore`, `FsNdjsonCacheStore`, `FsXmltvCacheStore`, `isStale`, `DEFAULT_STALENESS` |
| Grabber | `grab`, `defineSiteConfig`, `resolveChannels`, `resolveSites`, `channelElement`, `siteHttp`, `sitePacing`, `retryAfterMs` |
| Merge | `mergeProgrammes`, `mergeProgrammeLists`, `mergeInto`, `resolveMatch`, `normalizeTitle`, `titlesMatch`, `DEFAULT_MATCH`, `generateGuide`, `writeGuide`, `defaultChannelInfo` |

Plus the types for all of the above (`EpgConfig`, `SiteConfig`,
`GrabberChannel`, `XmltvProgramme`, `XmltvChannel`, …).

### `epg-tools/xmltv`

Zero dependencies, and nothing else in the package is loaded. Full detail in
[XMLTV parser, serializer and builders](./xmltv.md).

- **Parse** — `parseXmltvFile`, `parseXmltvStream`, `parseXmltvString`*, `XmltvParseStream`*
- **Serialize** — `writeXmltvStream`, `writeXmltvToFile`, `serializeChannel`, `serializeProgramme`, `serializeDocumentHeader`*, `serializeDocumentFooter`*, `XmltvSerializeStream`*
- **Builders*** — `ProgrammeBuilder`, `ChannelBuilder`, `XmltvDocumentBuilder`
- **Dates** — `parseXmltvDate`, `formatXmltvDate`, `xmltvDate`, `getXmltvOffset`, `setXmltvOffset`, `getXmltvPrecision`, `setXmltvPrecision`, `XMLTV_OFFSET`, `XMLTV_PRECISION`, `XmltvDateError`
- **Other** — `escapeXml`

`*` this subpath only — not re-exported from the root.

### `epg-tools/cache`

`FsNdjsonCacheStore`, `FsXmltvCacheStore`, the abstract `FsCacheStore` they
share, `isStale`, `DEFAULT_STALENESS`, and the `CacheStore` / `ChannelDayKey` /
`CacheEntryMeta` / `StalenessPolicy` / `CacheFormat` types. Implement
`CacheStore` yourself to keep entries somewhere other than the filesystem, or
extend `FsCacheStore` to keep them on disk as something else — it asks a subclass
only what one entry *is*: an extension, a string to write, and how to read one
back.

`new FsNdjsonCacheStore({ dir, signal? })` — the format is the class, and the
signal belongs to the store rather than to each call, since a store belongs to
one run. That is what keeps `CacheStore` a five-method interface anyone can
implement. A write stops before its rename, so an entry is either there in full
or not there at all, and a prune stops between days.

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

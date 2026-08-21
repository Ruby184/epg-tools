# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing has been released to npm yet — `0.1.0` below describes the surface as
it stands. Until the first tag, changes are folded into that entry rather than
listed as changes against a published version.

## [0.1.0]

Initial release.

### XMLTV (`epg-tools/xmltv`)

- Dependency-free streaming parser — `parseXmltvFile`, `parseXmltvStream` and
  the whole-document `parseXmltvString` — that holds one element at a time
  whatever the guide's size, and parses straight into the typed model in a
  single pass with no intermediate DOM.
- Complete `xmltv.dtd` coverage, round-tripped and validated against the
  official DTD in the test suite. Non-DTD attributes and child elements are
  preserved rather than dropped, so provider extensions survive a parse and a
  re-serialize.
- Malformed input produces `warning` events with a code, message and
  `line`/`col` instead of throwing: a bad programme costs one programme, not
  the guide. `tolerateMissingId`, `rootScanLimit` and `timezones` tune what is
  tolerated.
- Streaming serializer — `writeXmltvStream`, `writeXmltvToFile`, and the
  per-element `serializeChannel` / `serializeProgramme` /
  `serializeDocumentHeader` / `serializeDocumentFooter`. Compact by default,
  `indent` to pretty-print.
- `XmltvParseStream` and `XmltvSerializeStream` Node `Transform`s for
  `stream.pipeline()`, symmetric so a parse → serialize pipeline round-trips.
- Fluent builders: `ProgrammeBuilder`, `ChannelBuilder` and
  `XmltvDocumentBuilder` (`build`/`toXml`/`toStream`/`toEvents`).
- Date helpers that preserve an XMLTV datetime's source offset and precision
  across a parse/format round-trip: `parseXmltvDate`, `formatXmltvDate`,
  `xmltvDate`, and the offset/precision accessors.

### Grabber (`epg-tools/grabber`)

- Multiple site configs fetched in parallel, each with its own ky instance,
  request queue, `days`, `staleness` and `batching` — nothing shared between
  sites, so differing credentials, hosts and rate limits coexist in one
  process.
- `channels` as a written-out list or a function fetching one with the site's
  own HTTP client, with arbitrary per-channel `data` typed through to
  `channelInfo` and `parseDay`.
- One `request` per site, with `batching` deciding how much of the channel ×
  day grid a call covers (`none`, `channels`, `days`, `both`, with per-axis
  size caps). `parseDay` stays one call per channel-day whatever the mode.
- `parseDay` receives a `ProgrammeBuilder` already bound to the channel-day,
  and may return builders, plain objects, or a mix. `channelInfo` likewise
  receives the default `<channel>` as a builder to add to.
- Request pacing with `concurrency` and a sliding-window `rateLimit`, plus
  `backoff`: a `429`/`503` pauses the whole site's queue for as long as
  `Retry-After` asks, keeping its queued tasks, and `adapt` halves concurrency
  and restores it a step at a time.
- `localConcurrency` bounds cache work and parsing across every site,
  separately from per-site request pacing.
- Runs are abortable: a `signal` drops queued work, aborts what is in flight,
  and resolves with a partial `GrabSummary` rather than rejecting.

### Cache (`epg-tools/cache`)

- Filesystem day cache keyed by `site + channel + day`, in `ndjson` or `xmltv`
  format, readable in either whatever is configured for writes.
- Staleness policy — `alwaysRefetchDays` and `maxAgeDays` — settable globally
  and per site, with automatic pruning of old days after a successful grab.

### Merge (`epg-tools/merge`)

- `channelStrategy` (`merge-programmes`, `first-wins`, `keep-all`) and
  `programmeStrategy` (`merge`, `concat`), with site order as priority.
  Merging unions language-tagged fields by `(lang, value)`, so the same channel
  from a Slovak and an English source becomes one programme carrying both.
- `generateGuide` / `writeGuide` stream the merged guide with constant memory.

### CLI and configuration

- `epg build`, `grab`, `merge`, `prune` and `init-grabber`, over an
  `epg.config.ts` / `.js` / `.mjs` loaded from the working directory or
  `--config`.
- Output to a file (written to a temp file and renamed, so no reader sees half
  a guide) or to a Unix socket, which is what tvheadend's External XMLTV module
  takes.
- `--offset` shifts the guide window without shifting "now", so staleness, the
  `grabbedAt` stamp and pruning keep using the real current time.
- `defineConfig` accepts a factory, so a config can ask for values it cannot
  hardcode; answers are resolved from caller-supplied readers, then the
  environment, then a field's default.

### XMLTV grabber protocol (`epg-tools/tv-grab`)

- `runXmltvGrabber` turns a config into a `tv_grab_*` executable, and
  `epg init-grabber` writes the shim.
- Capabilities advertised: `baseline`, `manualconfig`, `apiconfig`, `cache`,
  `preferredmethod` and `newchannels`, with `lineups` available opt-in. Each
  shipped capability is built with the same public `defineCapability` API a
  third party would use.
- `--configure` and `--configure-api` are two renderings of one stage model
  described with `defineStages`, so the questions are declared once.
- `newchannels` reports channels that appeared upstream without silently
  widening the grab; `--channel-updates` chooses between `notify`, `add`,
  `ignore` and `signal` (exit 2).
- `lineups` describes reception platforms per `xmltv-lineups.xsd`, built by
  hand or derived from the sites with `lineupsFromSites`.

[Unreleased]: https://github.com/Ruby184/epg-tools/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Ruby184/epg-tools/releases/tag/v0.1.0

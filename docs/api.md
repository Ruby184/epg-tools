# Programmatic API

Everything the `epg` CLI does is available as a library. The package is
**ESM-only** and ships types for every entry point.

- [Running a build](#running-a-build)
- [Reporting what a run is doing](#reporting-what-a-run-is-doing)
- [Streaming a guide](#streaming-a-guide)
- [Serving a guide](#serving-a-guide)
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
| `createCacheStore(config, signal?)` | The cache a config describes: a `CacheManager` over the driver its `driver` names or builds — built with `signal`, where the driver takes one. |

`GrabSummary` counts `fetched` (channel-days that went to the network),
`fromCache` (skipped because the cache was fresh), `empty`, `unchanged`,
`failed` and `sitesFailed` — six numbers, and nothing that grows with the size
of the guide.

`failed` is a **count** of channel-days that did not come back. `sitesFailed`
counts sites that answered nothing at all — one that could not be read, or whose
channel list never arrived. A list can also fail before the grab begins:
`build` settles every list first, and so does `runGrab` whenever it has a
selection (`channels`) or a `cover` that narrows. Either counts a list that
failed there the same way, and grabs the other sites — and `build` merges them.
The two counts are apart because a site has no grid to spread it over: a site
that could not be read has no channel list, so what it *would* have covered is
not knowable, and adding one to a count of channel-days would make a dead
source look like a rounding error beside a guide of thousands.

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
| `timeZone` | `string` | the config's | Whose calendar says which day `now` falls on, over the config's own — see [which day is today](./configuration.md#which-day-is-today). A config settles its `timeZone` as it is loaded, to the process's zone where it says none. `grab()` and `generateGuide()` take the same option. |
| `reporter` | `(event: EpgEvent) => void` | none | Where the run's events go — see [reporting what a run is doing](#reporting-what-a-run-is-doing). Omit for silence. |
| `cache` | `CacheStore` | the one the config describes | Use this store instead. It stays the caller's — nothing here closes what it did not open — which is for a process running several builds, or a test with a store already in hand. |
| `signal` | `AbortSignal` | none | Cancel the run — see [Cancelling a run](./configuration.md#cancelling-a-run). A grab resolves with the partial summary; a merge rejects, and the guide it was writing is discarded rather than replacing the one in place. `build` skips the merge entirely if the grab was cancelled. |
| `configModule` | `string \| URL` | none | The module the config came from — a path or a URL whose default export is it. Needed by a config with [`threads`](./configuration.md#sites-in-threads-of-their-own), whose sites' workers import it to find their site; without it such a run fails before any site starts. The `epg` command fills it in. A module of its own, never the program calling `build`: every worker would run that program again. |

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
`serve`, `prune` — `PHASES`). The level and phase follow from the type rather
than being chosen at the call site — `EVENT_KINDS` is the whole table, and it is
the whole answer to "what does the default verbosity show?".

A reporter may also say which kinds it does anything with, as a `wants`
property, so a run need not make an event nobody will read. What it makes that
often is made only where a reporter wants it: the `entry:*` of each channel-day
but a failure, `request:started` and `request:done`, a site's `site:note`,
`pacing:rateLimit`, and `merge:unmatched`, one per near miss and thousands of
them where two sources run on two grids. Measured at `info`, for a site asking
once per channel-day: 7% of a grab's time, and 4% in a thread. A reporter
without `wants` wants every kind, as the one above does. The ones this package
ships want what their level shows — plus their failures, and what the live line
counts — `emitterReporter` what its emitter has listeners for, and
`combineReporters` what any of its reporters wants. It is asked of each kind
once, the first time a run asks — after the run's first wait, so what listens
from as the run is started is asked about — and the run holds to that set — a site in a thread
included, which neither makes nor sends what the set leaves out. It is never
trusted to filter: a reporter is still handed whatever is made.

```ts
const reporter = Object.assign((event: EpgEvent) => metrics.increment(event.type), {
  wants: (type: EpgEvent['type']) => type !== 'merge:unmatched',
});
```

| group | types |
|---|---|
| the run | `run:cancelled`, `grab:done` (with every request of the run, by label — which a request a parse did not wait for can take past what its sites' `site:done` add up to) |
| a site | `site:started` (with `dayZone` for a site on [another calendar](./configuration.md#which-day-is-today), whose days `days` then counts), `site:done` (its counts plus what it cost: `requests`, `ms`, `requestMs`, `requestsBy`, and `msBy`, where its `ms` went), `site:failed`, `site:note`, `site:warning` (the last two carrying whatever [fields the site attached](./site-config.md#saying-something)) |
| one channel-day | `entry:cached`, `entry:fetched`, `entry:appended`, `entry:unchanged`, `entry:failed` |
| one request | `request:started`, `request:done` (with `ms`), `request:failed` |
| a whole-document source | `stream:gaps`, `stream:ignored` |
| pacing | `pacing:held` (with `retryAfterMs`, where the source said how long, and `lengthened`, where it made a running hold longer), `pacing:slowed`, `pacing:recovered`, `pacing:rateLimit` |
| merging, tidying | `merge:channel`, `merge:unmatched` (each programme that nearly merged, at `debug`), `merge:summary` (what the sources made of each other), `merge:done`, `merge:note`, `merge:warning`, `prune:done` |
| [serving](./configuration.md#serving-the-guide) | `serve:started` (with the `url`), `serve:response` (`method`, `path`, `status`, `ms`), `serve:reloaded`, `serve:disconnected`, `serve:failed`, `serve:grabFailed` (a scheduled grab that threw outright, rather than one of its sites failing), `serve:stopped` |

### What a run cost, and what the merge made of it

Two of these are worth knowing about before you need them, because they answer
questions that are otherwise answered by hand.

**Before reading any of it, look at `loopMaxMs` on `grab:done`.** It is the
longest the event loop went unserved. A `parseDay` is the site's own code on
the main thread, and one that does a big piece of work in a single synchronous
call stops everything else until it returns, including the reads that finish
*other* sites' requests. Measured here, a parse holding the thread like that
beside a network-bound site inflated that site's request times 15× on the mean
and 115× at the worst. A run whose worst figure is seconds is a run whose
request times are describing its own parsing, and the text reporter says so
under the summary rather than leaving every source looking slow at once.

It reports a *stall*, not how busy the thread was. A whole-document source parses
as the document arrives and yields between chunks, so it keeps `loopMaxMs` in the
tens of milliseconds however long it runs. Measured here, an 82 MiB guide kept
the worst stall at 41ms while the thread was busy 93% of the time. Its cost shows
as every other site slowing while it runs, not as a large `loopMaxMs`.

`site:done` says what the site **cost**, beside what it fetched. `requests` is
how many times the source was asked — every slot the site's queue gave out, a
`ctx.paced` fetch inside a parse included, which is why it is not the same as
counting `request:done` events. A channel list is one of them only when it was
fetched: one written out in the config, or still fresh in the cache, asks the
source nothing and counts as nothing. `ms` is how long the site took; `requestMs` is
how long its requests spent waiting on the source. A site whose `ms` is close
to its `requestMs` is waiting on the source. One whose `ms` is far above it is
waiting on something of its own: its `rateLimit`, or the parsing and writing
that follow each response, which share [`localConcurrency`](./configuration.md#how-caching-works)
with every other site. That is the measurement to take before tuning either.

`msBy` takes it. It is `ms` again, by what the site was doing — at each moment
the first of these that held, so the parts never overlap and add up to `ms`:

```json
"msBy": { "source": 939, "held": 0, "rateLimit": 0, "working": 1204, "queued": 168100, "other": 169 }
```

`held` is the time the source had the site's requests held after a `429` or
`503`, with any of them outstanding — waiting its turn, or out: under a hold,
that is one ky retries once the source's `Retry-After` is up, or one sent
before it that the hold holds up as much — so a site asking one request at a
time is seen to be held, not waiting on the source. `source` is the time at
least one of its requests was out to the source otherwise — once however many
were, so it is `requestMs` only for a site that sends one at a time — and a
streaming site's pass reading its document, its body arriving and split as it
does, where nothing else of the site's holds.
`rateLimit` is the time its own `rateLimit` held the next one back. `working` is its own work on this machine under way — a `parseDay`,
a write to the cache, a check of what is cached — and `queued`, that work
waiting for a `localConcurrency` slot with none of it under way, which other
sites' work holds. `other` is the rest: its own code between them, reading what
it remembered, its turn's beginning and end. The site above took 170 seconds
over two requests answered in under one, and spent 168 of them waiting for a
slot. A site in a thread measures its own in memory the run's thread reads, so
one whose thread dies has said where its time went until then — its waits for a
slot on the run's thread, writing its cache, among `queued`. A cancel drops
what was waiting, so a cancelled site's last moments are `other`.

It is measured in every run, for a few microseconds a channel-day: measured on
7,000, a few percent of a grab whose requests and parses take no time at all,
and nothing worth the name beside a source that takes any.

`requestsBy` says the same by what each request was for, with what failed them
— so "5291 requests" says that 3,242 of them were detail calls answered `404`:

```json
"requestsBy": {
  "request": { "requests": 49, "requestMs": 12034, "waitedMs": 2100, "failed": {} },
  "detail": { "requests": 5242, "requestMs": 573118, "waitedMs": 44021, "failed": { "404": 3242, "timeout": 3 } }
}
```

`requestMs` is the label's share of the site's `requestMs`, the time spent
waiting on the source — not of `ms`, which is the site's wall clock.
`waitedMs` is how long its requests sat in the site's queue before each was
sent: for the source to stop holding them, for the site's `rateLimit`, or for
one of its `concurrency` slots. Both are each request's own time added up, so
four in flight together for a second each are four seconds. A parse's `paced`
calls go ahead of the planned requests, so where both wait it is the planned
ones whose `waitedMs` grows — and a planned request is asked for only once the
response before it has been parsed and written, so that wait is in `msBy`,
not here.

A label is the site's to name: [`requestLabel`](./site-config.md#reference)
for its own requests — a request site's planned ones, or, since a stream has
none, the fetches of a pass that give no label — and
[`paced(task, { label })`](./site-config.md#a-parse-that-needs-another-request)
for the rest. A label is a word with a letter in it, in any script, or words
joined by `.`, `_`, `/` or `-` — `detail`, `v2/episodes` — so it reads as one
name on the text line, not as a status, and is never `channels`. A site with a
`requestLabel` that is not one is refused, and asks its source for nothing but
its channel list, where the run settles every list before it grabs: a `build`,
whose guide still writes what the site has cached, or a grab with a selection
or a `cover` to apply. A `paced` call with one throws where it is called, past any `.catch`
meant for the request, and is said once as a warning of the site's, past a
`try` around the `await` too. A label names a kind of request, not one request:
a site whose requests come under more than 64 labels is warned once, and every
one is still counted.

Without one, a request site's planned requests are `request`, a parse's `paced`
calls are `paced`, and a stream's fetches are `stream`. A channel list that was
fetched is `channels`, the calls of Schedules Direct's lineup among it, and
Schedules Direct names the rest of its own: `md5`, `schedules` and `programs`.
They come in the order each was first sent.

A request is counted as its turn comes, so one a cancel dropped before it is
not, and one already under way when the cancel came is. A failure is counted
where the request threw it, so a `404` the site goes on to catch is counted all
the same: by its status, `timeout`, `network` where nothing answered, or
`error` for anything else the request threw — a Schedules Direct refusal
answered at `200` among them. A request the cancel itself stopped is not
counted as failed — one that threw the cancel's reason, or an `AbortError`,
read down the error's `cause` chain — though what a source answered before or
as the cancel came still is; and a `304` that said a channel-day is unchanged
is an answer. A request a parse sent and did not wait for counts in its site's
`site:done` as far as it had got by then, and in `grab:done` as far as it has
by the end of the run.

`grab:done` carries every request a site's queue sent, a list settled before
the grab included — save the list of a site whose settings no queue can be made
from, which is fetched without one, counted nowhere, and the site then refused.
A site in a thread counts its requests in memory its thread shares with the
run's, read once the run is done with every site, as a site on the run's own
thread is counted until then. One whose thread dies has lost none of what it
counted, and its `site:failed` comes with a `site:done` saying what it had
done — once, and only once everything the thread sent has been heard: a site
that had said it failed is told its thread went too as a warning, and one
that had said its `site:done` is said no more. Heard, that is, when its port
says it has closed, which it does at once however a thread goes; should one
never say so, the site is said five seconds after from what its memory holds,
less any label its thread had not named.

The text reporter lists them on a site's line where it had more than one kind
— and, for a site of one kind, only what failed it: `10647 requests (12 × 503)`:

```
[skylink.sk] 144 fetched, 0 from cache, 0 failed — 5291 requests (request 49, detail 5242: 3242 × 404 and 3 × timeout) in 11m37s, 585s waiting
```

`merge:summary` says what the sources made of each other, once the last
programme is out:

```
Merge: 4821 programmes combined, 37 nearly, 112 containers dropped
  sport.sk: 7m apart — "Správy" / "Správy TV"
```

`combined` is programmes one source joined to another's already there — not to
its own, held over from the day before and said again. `nearMiss` is
programmes that joined nothing while another source's, within half an hour, was
left unjoined too — the quiet failure
that matters, because a source published on a different grid merges with
nothing and the guide then carries every programme twice. A gap larger than
`merge.match.startToleranceMs` means they failed on time; smaller means they
failed on titles. Counted in full, with the first few reported whole, since on
a guide of thousands the count is the alarm and the examples only have to say
whether it is one channel or all of them. `containers` and `clipped` are what
`dropContainers` and `clipOverlaps` took away.

Each of those near misses is a `merge:unmatched` of its own, at `debug`: the
programme that joined nothing, the unmatched one of another source's nearest
it — from a source before it in the merge, or one held over from the day before
whatever its place — each as `{ site, title, start }` — the start as the guide writes it, to find
them there by — `shiftMs`, how much later the one starts than the other, below
nought where it starts earlier, and `why`. `title` means they started
near enough and their titles differ, which `merge.match.normalizeTitle` decides;
`start`, that the titles agree and the starts are too far apart, which
`startToleranceMs` decides; `both`, both; `runs`, that the titles agree and the
starts are near enough but further apart than the shorter of the two lasts —
two programmes in a row, or one within the other, as a segment is within its
show — which no tolerance changes. Under a `match` of the
config's own, `matcher` is any pair it said no to, its reasons its own — none
of the shipped rules is asked on its behalf — and `start`, for one with a
`windowMs`, a pair that starts beyond it, which it is never asked about. Only another source's programme is a near
miss — never a source's own, held from the day before. `epg merge --explain
unmatched` and `epg build --explain unmatched` list them all on stderr once the
guide is written, grouped, with what would join them — see
[what a run said, explained](./configuration.md#what-a-run-said-explained);
for each as JSON, `--reporter json --log-level debug` has them as events.

Two things about the shape are deliberate, and both are the difference between a
structured sink and a string one. **A failed request is one event, not one per
channel-day it covered** — `request:failed` carries `entries`, so a site that is
down says so once rather than seven thousand times, and no `entry:failed` is
emitted for those. And **`site` is a field**, never a prefix: a reporter that
shows it decides how, and a single-site grabber leaves it out.

**Filtering is a reporter's job and happens nowhere else.** A sink of your own
is told everything, which is what makes one worth writing; the ones below take a
`level` and drop what is under it.

**A reporter that throws fails the grab, once it is done.** What it threw does
not stop a site part way through saying what it did, nor the run: every site is
counted and said, `grab:done` or `run:cancelled` included, and then the grab —
and the `build` around it, before its merge — rejects with a `ReporterError`.
That is an `AggregateError` whose `errors` are what was thrown, each kind once
— a name and a message make a kind — and whose `thrown` says how often each
was, and at which events: a broken reporter throws at every event, and a run
says tens of thousands. Ten kinds are kept, and any past them counted in
`untracked`. A merge goes the same way — `runMerge`, or a `build` whose
reporter throws only at its merge, writes the whole guide, then rejects, and
`guideStream` hands over the whole of it, then throws — and a run that fails
on its own as well rejects with a `RunFailedError`, so neither is lost: an
`AggregateError` of both, with the run's own failure as its `error` and the
`ReporterError` as its `reporter`. A reporter written `async`, though a reporter is synchronous, has what it
rejects with kept as a throw is, while the run lasts: nothing waits on a
reporter, so one that rejects after the run has answered is let go of. Nothing is said once the run has
answered, though a request a parse did not wait for may still be going.
Reporters joined by `combineReporters` are each told every event, whatever
another throws. A sink that cannot keep up is a bug in the sink, and is said
rather than swallowed.

### The ones this package ships

Each is built by a function that takes options, so naming one and configuring it
are the same act:

| built by | writes |
|---|---|
| `textReporter({ stream, errorStream?, level?, failures?, failureCap?, prefix? })` | lines of text — what a person reads and a CI log keeps |
| `jsonReporter({ stream, level?, pretty? })` | one JSON object per line, for a pipeline |
| `progressReporter({ stream, … })` | one line, rewritten in place — `textReporter`'s options, plus a cursor |
| `loggerReporter({ logger, level?, prefix? })` | the same lines, to a logger you already have |

`loggerReporter` is for a process that logs for itself — a server under a
supervisor, where two log streams is one too many. The `logger` needs `info`,
`warn` and `error` taking a message, which pino, bunyan, winston and `console`
all have; `debug` is used where there is one. Failures go to `error` whole
rather than being held back for a block at the end, since a logger has its own
idea of how to group things.

```ts
serveGuide(config, { reporter: loggerReporter({ logger: pino() }) });
```

### An emitter, and several sinks at once

For a long-lived process where several things care about different events,
`emitterReporter` re-emits each one on an `EventEmitter` under its own type.
Typing the emitter with `EpgEventMap` makes each listener's argument the event
it asked for:

```ts
import { EventEmitter } from 'node:events';

const events = new EventEmitter<EpgEventMap>();

events.on('serve:started', () => process.send?.('ready'));   // pm2 wait_ready
events.on('serve:reloaded', () => void reloadMyOwnThings());
events.on('site:done', (event) => metrics.timing(event.site, event.ms));
```

Each concern subscribes to the one it is about, instead of a `switch` in a
reporter growing a case per concern — and a run makes no event for a kind
nothing has subscribed to, where making it costs anything, since an emitter
says through its `listenerCount` which kinds have listeners — once a run first
asks, so a listener added as `grab(…)` is called is heard, and one added part
way through a run hears from the next. An emitter that
hears more than its listeners do — an `emit` of its own that passes every event
on, or a listener for any kind — says what it hears instead:
`emitterReporter(bridge, { wants: () => true })` — which a config takes as its
`events` as well. That is also where a supervisor's
readiness ping belongs: this package sends none, because a library writing to
an IPC channel nobody asked it to is a surprise rather than a feature.

`combineReporters(...)` gives every event to several reporters in the order
written, skipping any that are `undefined`:

```ts
serveGuide(config, {
  reporter: combineReporters(loggerReporter({ logger }), emitterReporter(events)),
});
```

**From a config file, use `events` rather than `reporter`.** The two answer
different questions: `reporter` is how a run talks to whoever started it, which
an operator can overrule with `--reporter`; `events` is what the *program* does
with what happens, which nobody passing `--reporter json` meant to switch off.
Both run, and `events` is honoured by every entry point that reads a config —
`build`, `runGrab`, `runMerge` and `createGuideHandler` as much as the command.

```ts
export default defineConfig({ sites, output, events });   // the emitter itself
```

`events` may be a reporter of your own as well, which is how a config gives an
emitter that hears more than its listeners do — an `emit` of its own that
passes every event on — and so says so:

```ts
export default defineConfig({
  sites,
  output,
  events: emitterReporter(bridge, { wants: () => true }),
});
```

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
the point (`FAILURE_MODES` is the pair). The collecting and the flushing happen
whatever the `level` is: asking for errors only must still end with the errors.

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

`emitter(options)` is the other end: it turns the `reporter` a caller passed
into the `Emit` the internals take — the function, and `hears`, the set of kinds
its `wants` said yes to, asked once, the first time the run asks — and answers a silent one
when nobody is listening. Only needed to drive `grab` or `generateGuide`
directly and have their events reach the same reporter `build` would have given
them, or to hand `sitePacing` an `emit`.

## Streaming a guide

`guideStream(config, options)` is the file-less form of `runMerge` — the same
merged guide as an async generator of XML chunks, for piping to stdout or an
HTTP response with constant memory:

```ts
import { guideStream } from 'epg-tools';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

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

`profile` is the third, through the same entry points: a bundle of the knobs
that shape the DTD's own elements for a particular consumer — which
`<episode-num>` systems go out and in what order, what a `<category>` is
called, how many `<icon>`s a programme needs, which optional elements are left
out. `'tvheadend'` and `'jellyfin'` ship; anything else is yours. See
[output profiles](./configuration.md#output-profiles).

The two compose rather than overlap: `extensions` decides whether non-DTD data
leaves the document at all, a profile decides how the DTD data is shaped. So
`extensions: false` removes a profile's `eit` code, because that code is a
non-DTD attribute — which is what keeps "no extensions" meaning "a document
that validates".

Reading the systems back is available on its own, without a profile:
`parseXmltvNsEpisodeNum`, `parseOnscreenEpisodeNum` and
`parseDdProgidEpisodeNum`, with a `format*` counterpart for each, plus
`DVB_GENRES` and `genreOf` for the genre vocabulary. Each parser **fails
closed** — a value it cannot read with certainty yields nothing rather than a
guess.

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
`options` takes `port`, `host`, `path`, `health`, `compress`, `cors`,
`concurrency`, `keepAliveMs`, `revalidateMs`, `sitesMaxAgeMs`, `reloadOn`,
`grab` (a [schedule](./configuration.md#grabbing-on-a-schedule) to grab on
while serving), `server` (a server of your own to listen with — see below),
`shutdown`, and the `signal`, `reporter`, `now`, `offset`, `cache` and
`configModule` a run takes — a `cache` handed in stays the caller's, and one it
opened is closed by `close()`. Each overrides the config's `serve` field of the
same name, where there is one.

The validator is the cache's, not the document's: a guide is a generator, so
hashing its bytes would mean buffering it. What is read per poll is the window's
metadata — no payloads, no parsing, no serializing — at most once per
`revalidateMs`, once for however many polls arrive together, and in bounded
batches rather than as one enormous question.

What that saves depends on the driver by more than one would guess: over 3,500
channel-days a `304` costs 230ms on the default file cache against 32ms on
`sqlite`, where the sweep is a single query. See [serving the
guide](./configuration.md#serving-the-guide). Those lookups are keyed by the channel list in hand,
which is re-resolved when the fingerprint moves and at least every
`sitesMaxAgeMs` (ten minutes), so that a grab which only adds a channel is not
invisible until midnight. A site whose list fails then keeps the one it resolved
last. See [serving the guide](./configuration.md#serving-the-guide) for what
that costs and saves.

### On a server of your own

`createGuideHandler(config, options)` is that answer without the listening, for
an app that already has a port of its own:

```ts
import { createGuideHandler, grabEvery } from 'epg-tools/serve';

const handler = await createGuideHandler(config, { grab: grabEvery('4h') });

app.get(handler.guidePath, handler.node('guide'));              // express, koa, http
fast.get('/epg.xml', handler.fastify('guide'));                 // fastify, hooks and all
hono.get('/epg.xml', (c) => handler.fetch('guide')(c.req.raw)); // or fetch-style

await handler.close();                                          // yours to close
```

It gives back `{ answer, node, fastify, fetch, guidePath, healthPath, config, reload, close }`
and takes everything `serveGuide` does except `port`, `host`, `keepAliveMs` and
`server`, which are about the listening. `shutdown`, which both take, is a hook
run while stopping, after the scheduled grab has been called off and before the
cache is let go of, which is where ending the requests still in flight belongs.
`serveGuide` is this plus a socket: it calls yours first and then closes the
socket in the same place.

`node(route?)`, `fastify(route?)` and `fetch(route?)` build a handler for one
answer — `'guide'` or `'health'` — wherever it is mounted; a builder rather
than a method because a framework calls what it is given with whatever
arguments it likes, and express's third is `next`. The fastify one writes
through the reply rather than around it, so that its `onSend` and `onResponse`
hooks still see the guide; `reply.hijack()` over `node()` runs none of them. With no route they route by path instead, answering
`guidePath`, `healthPath` and then 404, which is what makes
`createServer(handler.node())` a whole server.

Underneath both is `answer(request)`, which has no transport in it at all:

```ts
const { status, headers, body } = await handler.answer({
  method: 'GET',
  url: '/guide.xml',            // or a whole url; only its path is read
  headers: { 'if-none-match': tag },
  route: 'guide',
  signal,                       // the consumer going away stops the merge
  encrypted: true,              // for `serve.baseUrl`, which no header can say
});
```

`body` is absent for a `304`, a `204` and every `HEAD`; a string for the small
answers; an async iterable of bytes for the guide, already compressed if
`content-encoding` says so; and **an object for the health check**, which is
data rather than a document. Whoever sends it turns it into bytes — which is
how fastify gets to serialise it itself, and how an app that reports its own
status reads it:

```ts
const { body: health } = await handler.answer({ headers: {}, route: 'health' });

reply.send({ ...mine, epg: health });   // { ok, grabbedAt, ageSeconds, window, counts, shape }
```

Asking for `health` by name says so in the type, so that body needs no
narrowing. Abandoning the guide's iterable is the supported way to stop: it
ends the merge and gives back the concurrency slot. `answer` never rejects; a
failure is a `500` with the reason already reported.

To keep the command instead of writing a program, `serve.server` hands
`epg serve` a server of yours, returning the `http.Server` it is listening on
or `{ server, close }` where stopping is more than closing a socket — see [on a
server of your own](./configuration.md#on-a-server-of-your-own).

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
import { parseM3uFile, writeM3uToFile } from 'epg-tools/m3u';
import { parseChannelsXml, matchChannels } from 'epg-tools/channels';
import { CacheManager, FsNdjsonCacheDriver, isStale } from 'epg-tools/cache';
import { grab, resolveChannels, siteHttp } from 'epg-tools/grabber';
import { generateGuide, writeGuide, mergeProgrammes } from 'epg-tools/merge';
import { serveGuide } from 'epg-tools/serve';
import { runXmltvGrabber, defineCapability } from 'epg-tools/tv-grab';
```

The root re-exports most of the subpaths, so a single import usually does. Two
reasons to reach for a subpath: `epg-tools/xmltv`, `epg-tools/m3u` and
`epg-tools/channels` pull in **no dependencies and none of the machinery** — no
grabber, no cache, no config loading — so they are the ones to use if all you
want is to read or write those formats; and a handful of names live only on a
subpath — marked `*` below. `epg-tools/tv-grab` and `epg-tools/cache/sqlite`
are not re-exported at all.

## Export map

### `epg-tools`

| group | exports |
|---|---|
| Config | `defineConfig`, `resolveConfigSource` |
| Answers | `createConfigContext`, `defaultsReader`, `envReader` |
| Errors | `GrabberError`, `ReporterError`, `RunFailedError`, `errorMessage`, `errorChain` |
| Events | `LEVELS`, `PHASES`, `EVENT_KINDS`, `atLevel`, `emitter` |
| Reporters | `textReporter`, `jsonReporter`, `progressReporter`, `loggerReporter`, `emitterReporter`, `combineReporters`, `render`, `renderFailure`, `isFailure`, `reporterFor`, `REPORTER_NAMES`, `FAILURE_MODES`, `DEFAULT_FAILURE_CAP` |
| Runners | `build`, `runGrab`, `runMerge`, `guideStream`, `createCacheStore` |
| Allowance | `fellShort`, `resolveAllowance` — whether a summary is short more than `allowMissing` forgives |
| Serve | `serveGuide`, `createGuideHandler`, `grabEvery` — the `DEFAULT_*` values and `outputFingerprint` are on [`epg-tools/serve`](#epg-toolsserve) only |
| Days | `toDayString`, `dayToDate`, `addDays`, `diffDays`, `dayRange` |
| Options parsing | `parseOptions`, `OptionError` |
| XMLTV | `escapeXml`, `escapeXmlText`, `escapeXmlAttribute`, `serializeChannel`, `serializeProgramme`, `writeXmltvStream`, `writeXmltvToFile`, `parseXmltvStream`, `parseXmltvFile`, `validateXmltv`, every [date helper](./xmltv.md#dates) and the [zone helpers](./xmltv.md#named-zones) |
| Episode numbers, genres | `parseXmltvNsEpisodeNum`, `formatXmltvNsEpisodeNum`, `parseOnscreenEpisodeNum`, `formatOnscreenEpisodeNum`, `parseDdProgidEpisodeNum`, `formatDdProgidEpisodeNum`, `parseTitleNumbering`, `stripTitleSeason`, `DVB_GENRES`, `genreKey`, `genreOf` |
| Output profiles | `OUTPUT_PROFILE_NAMES`, `OUTPUT_PROFILES`, `resolveProfile` |
| M3U | `parseM3uStream`, `parseM3uFile`, `parseM3uString`, `serializeM3uEntry`, `serializeM3uHeader`, `writeM3uStream`, `writeM3uToFile`, `M3uParseStream`, `M3uSerializeStream` |
| Channels | `parseChannelsXml`, `serializeChannelsXml`, `serializeChannelsXmlEntry`, `matchChannels`, `timeshiftOf`, `timeshiftName` |
| Cache | `CacheManager`, `CODECS`, `toRecord`, `fromRecord`, `FsCacheDriver`, `FsNdjsonCacheDriver`, `FsXmltvCacheDriver`, `isStale`, `DEFAULT_STALENESS`, `CACHE_DRIVER_NAMES` |
| Grabber | `grab`, `defineSiteConfig`, `defineStreamSiteConfig`, `defineXmltvSite`, `defineM3uSite`, `defineXtreamSite`, `defineSchedulesDirectSite`, `schedulesDirectAccount`, `defineCommandSite`, `defineTvGrabCommandSite`, `resolveChannels`, `resolveSites`, `channelsFromM3u`, `channelsFromChannelsXml`, `guideUrlsFromM3u`, `xtreamChannelExtras`, `xtreamProgrammeExtras`, `schedulesDirectChannelExtras`, `schedulesDirectProgrammeExtras`, `SCHEDULES_DIRECT_CHANNEL_ID`, `channelElement`, `siteHttp`, `kyWith`, `sitePacing`, `retryAfterMs`, `isUnchanged`, `UnchangedError` |
| Site state | `SiteStateHandle`, `StateKey`, `TrackedMap`, `channelsMaxAgeMs`, `DEFAULT_CHANNELS_MAX_AGE_DAYS` — see [what a site remembers](#what-a-site-remembers-between-runs) |
| Selection | `channelSelection`, `unmatched` — what `channels` means once `derived` is taken into account, and what it asked for that nothing produced |
| Merge | `mergeProgrammes`, `mergeProgrammeLists`, `mergeInto`, `backfillInto`, `resolveMatch`, `normalizeTitle`, `titlesMatch`, `DEFAULT_MATCH`, `resolveUnion`, `ResolvedUnion`, `DEFAULT_UNION`, `generateGuide`, `writeGuide`, `defaultChannelInfo` |

Plus the types for all of the above (`EpgConfig`, `SiteConfig`,
`GrabberChannel`, `XmltvProgramme`, `XmltvChannel`, `GuideServer`, …), and
`ProgrammeBuilder`, `ChannelBuilder`, `ProgrammeOptions` and `NumberedOptions`
as types — the builders themselves are values on `epg-tools/xmltv` only.

### `epg-tools/xmltv`

Zero dependencies, and nothing else in the package is loaded but the error
class its serializer throws, whose module imports nothing. Full detail in
[XMLTV parser, serializer and builders](./xmltv.md).

- **Parse** — `parseXmltvFile`, `parseXmltvStream`, `parseXmltvString`*, `XmltvParseStream`*
- **Serialize** — `writeXmltvStream`, `writeXmltvToFile`, `serializeChannel`, `serializeProgramme`, `serializeDocumentHeader`*, `serializeDocumentFooter`*, `serializeProcessingInstruction`*, `XmltvSerializeStream`*
- **Builders*** — `ProgrammeBuilder`, `ChannelBuilder`, `XmltvDocumentBuilder`
- **Dates** — `parseXmltvDate`, `formatXmltvDate`, `xmltvDate`, `getXmltvOffset`, `setXmltvOffset`, `getXmltvPrecision`, `setXmltvPrecision`, `XMLTV_OFFSET`, `XMLTV_PRECISION`, `XmltvDateError`
- **Zones** — `zonedXmltvDate`, `xmltvZone`, `setXmltvZone`, `xmltvZoneOffset` — see [named zones](./xmltv.md#named-zones)
- **Episode numbers** — `parseXmltvNsEpisodeNum`, `formatXmltvNsEpisodeNum`, `parseOnscreenEpisodeNum`, `formatOnscreenEpisodeNum`, `parseDdProgidEpisodeNum`, `formatDdProgidEpisodeNum` — see [episode numbers](./xmltv.md#episode-numbers)
- **Numbering in titles** — `parseTitleNumbering`, `stripTitleSeason` — see [numbering in titles](./xmltv.md#numbering-in-titles)
- **Genres** — `DVB_GENRES`, `genreOf`, and `genreKey`, the folding `genreOf` matches by — see [genres](./xmltv.md#genres)
- **Output profiles** — `OUTPUT_PROFILES`, `OUTPUT_PROFILE_NAMES`, `resolveProfile` — see [output profiles](./configuration.md#output-profiles)
- **Validate** — `validateXmltv` — see [validating a guide](./configuration.md#validating-a-guide)
- **Other** — `escapeXml` and the two named forms it takes its rule from, `escapeXmlText` and `escapeXmlAttribute` — text escapes `&`, `<` and `>`, an attribute those and `"`; `escapeXml(value, quotes)` says which quotes would end the value where it is going

`*` this subpath only — not re-exported from the root. For the builders that
means the classes: since 0.7.0 `ProgrammeBuilder`, `ChannelBuilder` and
`ProgrammeOptions` are re-exported *as types* from the root and from
`epg-tools/grabber`, so a helper a site splits out of its `parseDay` can say
what it takes — and `NumberedOptions` with them, for a `numbered` shared
between sites.

### `epg-tools/m3u`

Zero dependencies, and nothing else in the package is loaded. Full detail in
[M3U playlists](./m3u.md).

- **Parse** — `parseM3uFile`, `parseM3uStream`, `parseM3uString`, `M3uParseStream`
- **Serialize** — `writeM3uStream`, `writeM3uToFile`, `serializeM3uEntry`, `serializeM3uHeader`, `M3uSerializeStream`
- **Scanner*** — `M3uScanner`, `M3uIptvReader`, `M3uTag`, `M3uUri` — the lexical layer under the parser, for [a dialect that is not IPTV](./m3u.md#reading-it-as-something-other-than-iptv)

`*` this subpath only — not re-exported from the root. The bridge to a site's
channel list, `channelsFromM3u`, lives on `epg-tools/grabber` instead — this
subpath imports nothing from the rest of the package.

### `epg-tools/channels`

Zero dependencies. It loads one file from the rest of the package — `escape.ts`,
which the XMLTV module owns and which imports nothing itself — rather than
keeping a second copy of the entity rules. Full detail in
[Channel lists and matching](./channels.md).

- **Parse** — `parseChannelsXml`
- **Serialize** — `serializeChannelsXml`, `serializeChannelsXmlEntry`
- **Match** — `matchChannels`, `timeshiftOf`, `timeshiftName`

Everything here is re-exported from the root. The bridge to a site's channel
list, `channelsFromChannelsXml`, lives on `epg-tools/grabber` — same rule as the
M3U one above.

### `epg-tools/cache`

`CacheManager`, the drivers `FsNdjsonCacheDriver`, `FsXmltvCacheDriver`,
`MemoryCacheDriver`* and `NoCacheDriver`* with the abstract `FsCacheDriver` the
file ones build on, the codecs a driver names in `CODECS` and the `toRecord` /
`fromRecord` pair they build on, `CorruptEntryError`, `CACHE_SCHEMA`*, `STATE_SCHEMA`*, `isStale`,
`DEFAULT_STALENESS`, `CACHE_DRIVER_NAMES`, and the `CacheStore` / `CacheDriver` /
`CacheManagerOptions` / `FsCacheDriverOptions` / `CacheCodec` / `CodecName` /
`ChannelDayKey` / `CachedKey` / `CacheListOptions` / `Inspected` / `Unusable` / `CacheEntryMeta` / `StoredEntryMeta` / `StoredProgramme` /
`FoundMeta` / `FoundEntry` / `StateEntry` / `StoredStateMeta` / `FoundState` /
`StalenessPolicy` / `CacheDriverName` types.

`*` this subpath only — not re-exported from the root.

A cache is two pieces. A **driver** answers for one store — a directory of
files, a database, a bucket — and holds no policy of its own. The
**`CacheManager`** in front of it is what a run talks to (it is a `CacheStore`,
which is what `grab` and `generateGuide` take), and it owns everything that must
be true of every driver alike: the meta an entry carries, stamped on the way in
and judged on the way out, and what to do with an entry that cannot answer for
itself, or whose programmes do not read back as what it says it holds — it
goes, so the day reads as never grabbed and the next run fetches it.

```ts
const cache = new CacheManager({ driver: new FsNdjsonCacheDriver({ dir }) });
```

It also answers what [`epg cache`](./configuration.md#looking-inside-the-cache)
asks, and changes nothing doing so. `list(options?)` is the driver's own.
`inspectMetas(keys)`, `inspect(key)` and `inspectState(site, key)` judge an
entry or a group exactly as `getMetas`, `read` and `getState` do — the config's
`invalidate` included — and one a run would remove stays where it is. What
comes back says which by its `status`, and a key with nothing under it is
`undefined`:

| `status` | is | beside it |
|---|---|---|
| `'readable'` | what a run would use | what was read: `meta`, and `programmes` or `data` |
| `'unreadable'` | something that says nothing about itself this version can read | `meta`, whatever was there, or `undefined` |
| `'incompatible'` | written in a shape this version does not read, older or newer | `meta`, what it says about itself — its `schema` the shape it was written in |
| `'invalidated'` | an entry `invalidate` voids | `meta`, what it says about itself |
| `'corrupt'` | an entry whose meta reads and whose programmes do not: its codec throws `CorruptEntryError` on them — as those of `CODECS` do for more or fewer than the meta says it holds | `meta`, and `error`, what the codec threw |

```ts
const looked = await cache.inspect({ site: 'example.tv', channelId: 'one', day: '2026-07-17' });
// { status: 'readable', meta, programmes }, or { status: 'incompatible', meta: { schema: 0, … } }, …
```

What the driver throws — a file this user may not read — is thrown, as it is to
a run: there is no entry to judge. `epg cache` says so of that one and goes on
to the rest.

#### A driver of your own

A driver is a small thing to write: `codec`, `readMeta`, `read`, `write`,
`delete`, `prune`, the three that keep [a site's
state](#what-a-site-remembers-between-runs) — `readState`, `writeState`,
`deleteState` — `list`, and, if it has them to offer, `readMetas` and `close`. It keeps
an entry as **bytes** beside its meta and never sees a programme: `codec` says
what the bytes are, and the manager encodes on the way in and decodes on the
way out, so no driver has to remember to. `read` and `readMeta` return
`undefined` when there is no entry, and `{ meta }` — possibly an undefined meta —
when there is one that says nothing readable; the manager tells those apart and
only removes the second.

`list(options?)` names everything the store holds, as an async iterable:
`{ kind: 'entry', key }` for a channel-day and `{ kind: 'state', site, key }`
for a group of a site's state. `{ site, channelId, kind }` narrow it — to one
site, to one channel's entries, to entries or to groups — so a store kept by
site and channel need not look at the rest; one that cannot narrow by something
may answer with more, and `CacheManager.list` leaves out what was not asked
for. Keys as they were written, not as the store had to escape them, and only keys:
what is in them is what `read` and `readState` are for, so a store that keeps an
entry's meta inside the entry need not open every one to answer. In whatever
order suits the store. It is what [`epg cache`](./configuration.md#looking-inside-the-cache)
looks inside a store with, and it is required — a store that holds nothing
yields nothing, as `NoCacheDriver` does.

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

The package keeps four for a site: `channels`, a list it fetched; `validators`,
what each url last answered with; `state`, the site's own bag; and
`remembered`, what a context's
[`remember`](./site-config.md#a-programmes-details-asked-once) kept, each
value with when it is forgotten. `StateKey` names them.

`FsCacheDriver` puts each group in `<dir>/<site>/<key>.json`, beside the
channel directories of the same site; a prune only ever looks at the day files,
so state outlives every listing a site has. `SqliteCacheDriver` keeps a row per
group. `MemoryCacheDriver` copies in and out, as it does with programmes.
`NoCacheDriver` remembers nothing, which is the honest answer rather than a gap.

What an entry's bytes are is the driver's **`codec`**, and naming one of
`CODECS` is the usual answer:

| codec | the bytes | named by |
|---|---|---|
| `'ndjson'` | one record of JSON per line | `FsNdjsonCacheDriver`, after its meta line |
| `'json'` | the records' array, as JSON | `SqliteCacheDriver`, `MemoryCacheDriver`, `NoCacheDriver` |
| `'xmltv'` | `<programme>` elements, indented | `FsXmltvCacheDriver`, inside its document |

A record is a programme as a plain object whose dates are XMLTV strings, so
neither the offset the source wrote them in nor how precise it was is lost
through `JSON.stringify`. A name is also what a site in a [thread of its
own](./configuration.md#sites-in-threads-of-their-own) can be handed: the
thread encodes its channel-day with the same codec and sends the bytes over,
and the main thread only stamps and saves them.

A driver that keeps something none of these make — fewer fields, a format of
its own — brings a **`CacheCodec`** instead, an object with `encode(programmes)`
and `decode(body, meta)`; `toRecord` and `fromRecord` are there to build one on. It
runs on the main thread only, since a thread cannot be handed code: a site in a
thread sends its programmes, and the manager encodes them there.

A codec says an entry is damaged — bytes that are not what it wrote: a line
cut short, an edit, a disk that filled — by throwing **`CorruptEntryError`**
from `decode`. A run then removes the entry, says so (see `warn` below), and
the next run grabs the day again. Anything else `decode` throws is taken for
the codec's own failing — a bug, a format changed without a schema to say so —
and thrown out of `read` as it is, the entry kept: a removal, for every entry at
once, would empty the cache and write an empty guide over the last good one.

`decode(body, meta)` is handed what the entry says about itself beside its
bytes, which is how a codec tells a cut that still reads — an ndjson entry cut
between lines, an xmltv document that ends early — from a whole one: by
`meta.programmeCount`.

```ts
import { gunzipSync, gzipSync } from 'node:zlib';
import { CODECS, CorruptEntryError, type CacheCodec } from 'epg-tools/cache';

const gzipped: CacheCodec = {
  encode: (programmes) => gzipSync(CODECS.json.encode(programmes)),
  decode(body, meta) {
    let json: Uint8Array;

    try {
      json = gunzipSync(body);
    } catch (error) {
      // Bytes that are not gzip are an entry damaged, not a codec.
      throw new CorruptEntryError('An entry of the gzipped codec is not gzip', { cause: error });
    }

    // Which says so itself of records it cannot read, or fewer than `meta` says.
    return CODECS.json.decode(json, meta);
  },
};
```

The codecs of `CODECS` throw it for what their parser cannot read — JSON that
is not JSON, a date that is no date, a document that is not XMLTV — with the
parser's error as its `cause`, and for a programme count other than the meta's:
they give back exactly what they were given. Anything else they throw is a
fault of this package's, and thrown as it is. Each takes the meta now, and
throws where before the `json` one answered `[]` and the other two threw the
parser's error itself. A codec of a driver's own may give back other than it
was given — one that leaves out, or folds together — and holds an entry to its
count or not, as it knows it should.

`instanceof CorruptEntryError` knows one by its name as well, so a driver
whose package brings a copy of `epg-tools` of its own throws one the manager
knows.

What `write` is handed may be a view into a larger buffer — a codec allocates
for the worst case rather than measuring first — so a driver that holds on to
the bytes, rather than writing them out, keeps a copy of the view:
`new Uint8Array(body)`.

Before 0.7.0 a driver said what it keeps by extending `CacheDriverBase` and
overriding `toStored` / `fromStored`, with `toRecord` / `fromRecord` beneath
them, and its `read` and `write` passed whatever those made. All four are gone,
and `toRecord` / `fromRecord` are plain functions now: a driver keeps bytes, and
its codec says what they are.

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

`warn(message, key)` on `CacheManager` is where it says it removed an entry
whose codec said it was damaged — a line cut short, an edit — so the day is
missing from anything built from the cache until the next run grabs it again.
Only that: an entry removed for a schema this version does not read, or by
`invalidate`, is what an upgrade or a config asked for. A run passes it on as a
`site:warning` of the site whose day it was, whether a grab came across it or a
merge.

### Drivers that need no store

Two drivers need no store at all. **`MemoryCacheDriver`** keeps entries for the
life of the process — for a test, or a run with nowhere to write. It keeps the
`json` codec's bytes as sqlite does, not because anything here outlives the
process but so that `read` hands back a copy: every other driver returns
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
`file` names the database yourself (`':memory:'` included). Those options are
the `SqliteCacheDriverOptions` type, exported beside it.

One row per channel-day: the meta columns, and the programmes as the `json`
codec's bytes, a BLOB — bound as bytes, which is 0.55ms for 1.45 MiB where
binding the same JSON as text was 4.4, since SQLite has nothing to convert. A
rowid table with a covering index over the meta, so the staleness sweep — the
thing a run does for every channel-day — is answered without touching the
payload beside it: 7,000 of them cost 80ms rather than 310ms, and reading 7,000
whole entries 670ms rather than 880ms. WAL, so a merge reading is not held up by a grab
writing, and `synchronous = NORMAL`, because a day lost to a power cut is a day
grabbed again.

The programmes became bytes in 0.7.0, and a column's type is not something a
row can be read past, so the first run of 0.7.0 empties a database an older
version made — its listings and what its sites remember — and the run fills it
again.

Nothing is made or replaced until something is written. A database another
version made reads as empty — as does one not there yet — and the first write
replaces its tables, or makes the file and its directory. So a look — `epg
cache show`, `stats`, `state` — changes nothing, pointed at a directory with no
database in it or at a cache another version wrote. A place the file could
never be made — a read-only mount, a directory without permission, a path
through a file — is refused when the driver is made, though, for a look as for
a run: a run would otherwise fetch everything before finding out, and the driver
cannot tell which it is serving.

### `epg-tools/grabber`

`grab`, `defineSiteConfig`, `defineStreamSiteConfig`, `defineXmltvSite`,
`defineM3uSite`, `defineXtreamSite`, `defineCommandSite`,
`defineTvGrabCommandSite`, `runCommand`*, `splitXmltvDocument`*,
`streamBytes`*, `documentBytes`*, `dayOf`*, `asGrabberChannel`*,
`xmltvChannelInfo`*, `defineSchedulesDirectSite`, `schedulesDirectAccount`,
`SCHEDULES_DIRECT_CHANNEL_ID`, `resolveChannels`, `resolveSites`,
`coverageOf`*, `covered`*, `channelsFromM3u`, `channelsFromChannelsXml`,
`guideUrlsFromM3u`, `xtreamChannelExtras`, `xtreamProgrammeExtras`,
`schedulesDirectChannelExtras`, `schedulesDirectProgrammeExtras`, `siteHttp`,
`kyWith`, `sitePacing`, `retryAfterMs`, `channelElement`, `defaultChannelInfo`,
`SiteStateHandle`, `StateKey`, `TrackedMap`, `channelsMaxAgeMs`,
`DEFAULT_CHANNELS_MAX_AGE_DAYS`, `UnchangedError`, `isUnchanged`,
`ReporterError`, `RunFailedError`, `fellShort`, `resolveAllowance`, and
`ProgrammeBuilder` / `ChannelBuilder` / `ProgrammeOptions` / `NumberedOptions`
/ `ReporterThrow` as types.

`*` this subpath only — not re-exported from the root.

A site comes in two shapes and `grab` takes either: `defineSiteConfig` for one
that fetches a request at a time and parses each channel-day out of it, and
`defineStreamSiteConfig` for one that [answers its whole window in one
pass](./site-config.md#sites-that-answer-in-one-pass). `AnySiteConfig` is the
union, which is what a list of sites holds.

`resolveChannels(site, { http?, signal?, state?, refresh?, now?, says?,
select?, paced? })` returns a site's channels whichever form they came in — a
list or a fetched one — and `resolveSites(sites, { signal?, concurrency?,
store?, refresh?, now?, emit?, select?, failed? })` does it for several, which
is what `build` uses to fix the list across the grab and the merge. `select`
keeps only the channels whose `xmltvId` it holds, and is applied after the
cache, so what a site stores is still its whole list. `paced(fetch)` is how a
fetch of the list is sent: through the site's request queue, so its
`rateLimit`, `concurrency` and hold on a `429` apply to the list as they do to
the days after it. Only a fetch goes through it: a list written out in the
config, or still fresh in the cache, sends nothing. Without it the site's
`channels` is simply called.

One site's list failing rejects the whole call unless `failed(site, error)`
says what to do with that site instead: answer a site to use in its place, or
`undefined` to leave it out. `build`, `runGrab`, `serve` and the merge all pass
one, so one source down costs that source and nothing else; a cancelled run
rejects either way. Settling the lists and then grabbing, as `build` does — and
`runGrab` too, whenever it has a selection (`channels`) or a `cover` that
narrows — hand what failed to `grab` as `failedSites: [{ site, error }]`: each
is reported and counted as a list that failed in the grab's own hands —
`site:failed`, `site:done`, one more in `sitesFailed` — and asked nothing. A
list those two settle is fetched through the site's own queue, and the grab
carries on with the same queue, client and state, so `rateLimit`, the hold on a
`429` and whatever `channels` put in `state` apply as they do in a plain grab.
A site running in a worker thread starts a queue of its own for the grab.

A site's own `log` and `warn` go to `says` (or, for several sites, to `emit` as
the events they are) and are **dropped without one** — which is what a caller
writing a channel list to stdout wants, and a surprise to anyone else. Given
somewhere to keep it — a `state` handle, or for several sites a `store` — both
honour a site's [`cacheChannels`](./site-config.md#keeping-a-fetched-list): a
list still inside its max age comes back without the source being asked, and a
site's `channels` function is handed that handle's bag as its `state` — an
empty one of its own where there is none. When fetching the list again fails
because the source did not answer — a network error, a timeout, or a `408`,
`425`, `429` or `5xx` — the list stored last is used whatever its age, with a
warning, and is not stored again. An error the site throws about an answer it
did get — a lineup the account no longer has, a service saying it is offline —
fails the site instead, since a list from before it said so would hide it.

`siteHttp(config, signal?)` builds the site's ky instance — from its `ky`
options, or by extending a ky instance it brought — and `kyWith(ky, compose)`
is how an adapter built on another adds options of its own to either form, and
`sitePacing(config, { signal?, emit? })` its queue. `channelElement(config,
channel)` is what every `<channel>` in the output goes through — the site's
`channelInfo` if it has one, `defaultChannelInfo` if not.

**`channelsFromM3u(source, options?)`** reads an M3U playlist as a channel list,
taking a path or what [`epg-tools/m3u`](./m3u.md) produces. It returns the
`channels` function itself, so the playlist is read when the list is resolved
rather than when the config loads:

```ts
channels: channelsFromM3u('./channels.m3u'),
```

`tvg-id` becomes both `xmltvId` and `siteId`, and an entry without one is
skipped — which is 15% of iptv-org's playlist, so pass `onSkipped` or an `id` of
your own. See [a playlist as a site's channel
list](./m3u.md#a-playlist-as-a-sites-channel-list).

**`channelsFromChannelsXml(source, options?)`** does the same for a
[`*.channels.xml`](./channels.md), taking a path or the entries
`parseChannelsXml` returned, and likewise returning the `channels` function:

```ts
channels: channelsFromChannelsXml('./tvtv.us.channels.xml'),
```

`site_id` and `xmltv_id` are already the split `GrabberChannel` models. An entry
with no `xmltv_id` is skipped — it names something the source has but nothing a
guide could refer to. See [a channel list as a site's
channels](./channels.md#a-channel-list-as-a-sites-channels).

**`defineM3uSite(options)`** goes one further and makes the playlist a whole
source: its entries are the channels and its `x-tvg-url` header says where their
guide is, so one url needs no config at all.

```ts
sites: [defineM3uSite({ site: 'iptv-org', url: 'https://iptv-org.github.io/iptv/index.m3u' })],
```

It reads the playlist once for both passes and hands the guide to
`defineXmltvSite`, whose options it also takes. `guideUrlsFromM3u(header)`
is the header lookup on its own — `x-tvg-url`, then `url-tvg`, split on commas.
See [a playlist as a whole source](./m3u.md#a-playlist-as-a-whole-source).

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
`mergeInto`, `backfillInto`, `resolveMatch`, `normalizeTitle`, `titlesMatch`,
`resolveUnion`, `ResolvedUnion`, `DEFAULT_UNION`,
`DEFAULT_MATCH`, `DEFAULT_FILL_STOP_MS`*, `mergeChannels`*,
`defaultChannelInfo`, `channelSelection`, `unmatched`.

`*` this subpath only — not re-exported from the root.

`writeGuide({ ...options, output, compress? })` writes where `output` says — a
path renamed into place, a Unix socket, or a stream — and compresses when asked
or when the name says so, `.gz` / `.br` / `.zst`. See
[Compressing the guide](./configuration.md#compressing-the-guide) for what each
costs on a real one. `generateGuide` yields the document itself, so a caller
piping it somewhere compresses it however they like.

`mergeProgrammeLists(lists, strategy, match?, fillStopMs?, union?)` combines
per-site lists in priority order; `match` is a `ProgrammeMatch` object, a predicate of
your own, or `{ windowMs, matches }` — a predicate with the reach it needs. A
bare predicate is taken to reach any distance (`windowMs: Infinity`), so it is
asked about every pair; giving it a window is what keeps a merge linear. See
[what counts as the same
broadcast](./configuration.md#what-counts-as-the-same-broadcast). `fillStopMs`
is for the `backfill` strategy: how long a programme with no `stop` is taken to
cover, `DEFAULT_FILL_STOP_MS` (six hours) unless given. `union` is
`merge.union`, applied to each programme of the result — see [texts that say
the same thing](./configuration.md#texts-that-say-the-same-thing); the pieces
below it leave every text in, and
`resolveUnion(union, resolveMatch(match).normalizeTitle).apply(programme)` is
what applies it to one programme, its titles compared as the match compares
them. A loaded config carries its `merge.union` already settled, as a
`ResolvedUnion` — whose own fields are the union it was settled from, so a
copy of it is that union — which `resolveUnion` takes as it is for the same
match and settles again for another.
`resolveMatch(match)` settles a match into what a merge asks of it:
`windowMs`, how far apart two programmes can be and still be one broadcast;
`normalizeTitle`; and `apart(a, b)`, what keeps two programmes from being one —
a `NearMissWhy`, the `why` of `merge:unmatched` — or nothing, where they are
one. One answer to both questions, so the two cannot disagree; it was
`matches(a, b)`, a yes or no, before near misses said why.
`mergeInto(target, incoming, resolveMatch(match))` is the piece underneath
`mergeProgrammeLists`:
one source's list folded into a sorted accumulator, which is also how the guide
carries a day across the boundary into the next.

`generateGuide` takes two bounds of its own, both of which `build` fills in from
the config: `siteConcurrency`, how many sites resolve a fetched channel list at
once, and `readAhead` (from `localConcurrency`, default 16), how many
channel-days are read from the cache ahead of the writer. `readAhead: 1` reads
strictly one at a time.

`derived` adds channels that are other channels shifted — a `+1` — by reading
the source's cached days again rather than grabbing anything, so it belongs to
the guide rather than to `merge`. See [derived
channels](./configuration.md#derived-channels).

### `epg-tools/serve`

`serveGuide`, `createGuideHandler`, `grabEvery`, `outputFingerprint`*, the
`GuideServer` / `ServeOptions` / `EpgServeConfig` / `GuideListening` /
`GuideHandler` / `GuideHandlerOptions` / `GuideRequest` / `GuideRoute` /
`GuideAnswer` / `GuideHealth` / `Replying` / `ReplyingRequest` / `NextGrab` /
`GrabEveryOptions` / `GrabScheduleContext` / `GuideCached` types, with
`DEFAULT_SERVE_PORT`*, `DEFAULT_SERVE_HOST`*, `DEFAULT_SERVE_PATH`*,
`DEFAULT_HEALTH_PATH`*, `DEFAULT_REVALIDATE_MS`*, `DEFAULT_KEEP_ALIVE_MS`* and
`DEFAULT_SITES_MAX_AGE_MS`*.

`*` this subpath only — not re-exported from the root.

A `NextGrab` is the schedule `grab` takes: a function of `({ from, runs,
cached })` answering when the next grab is due, which `grabEvery` builds for an
interval — see [grabbing on a
schedule](./configuration.md#grabbing-on-a-schedule).

The server is loaded by this entry point and by the root, which re-exports
`serveGuide`, `createGuideHandler` and `grabEvery` — so importing `epg-tools`
loads `node:http` whether or not anything is served. The other subpaths leave
the server out. `epg-tools/xmltv`, `m3u`, `channels`, `cache` and
`cache/sqlite` load no `node:http` at all; `grabber`, `merge` and `tv-grab`
still reach it through Node's own `fetch`, which ky is built on.

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

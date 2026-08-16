# epg-tools

[![npm](https://img.shields.io/npm/v/epg-tools.svg)](https://www.npmjs.com/package/epg-tools)
[![CI](https://github.com/Ruby184/epg-tools/actions/workflows/ci.yml/badge.svg)](https://github.com/Ruby184/epg-tools/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/epg-tools.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/epg-tools.svg)](./LICENSE)

Memory-efficient EPG toolkit for building [XMLTV](https://github.com/XMLTV/xmltv) guides:

- **Grabber** — define multiple site configs, fetched in parallel with [p-queue](https://github.com/sindresorhus/p-queue) and [ky](https://github.com/sindresorhus/ky)
- **Day cache** — every `site + channel + day` is cached on disk; building a 14-day guide only fetches the days that are missing or stale
- **Streaming XMLTV** — a dependency-free, XMLTV-specialized streaming parser (tokenizer technique inspired by [txml](https://github.com/TobiasNickel/tXml), fused directly with the typed model) plus a streaming serializer, so merging many sources never loads a whole guide into memory — and parsing is faster than any whole-document XMLTV parser we measured (2.3× `@iptv/xmltv`, 11× `fast-xml-parser`, 13× `epg-parser`; see [Benchmarks](#benchmarks))
- **Complete DTD coverage** — every element and attribute of the official [xmltv.dtd](https://github.com/XMLTV/xmltv/blob/master/xmltv.dtd) round-trips (`video`, `audio`, PDC/VPS starts, showview/videoplus, clumpidx, `url system=`, credit persons with inline `image`/`url`, …); output is validated against the official DTD in the test suite
- **Provider extensions preserved** — non-DTD attributes and elements round-trip instead of being dropped, so consumers like [tvheadend's XPath-based grabber](https://github.com/tvheadend/tvheadend/blob/master/docs/class/epggrabber_modules.md#xmltv-xpath-examples-and-notes) can extract them: `uniqueID` on `<programme>`, `eit` codes on `<category>`, `<crid><series>…</series></crid>`, `<live/>`, `<lcn>`. Every modeled element (`icon`, `url`, `rating`, `image`, credit persons, `video`, the `<tv>` root, …) carries an optional `extraAttributes` map, and `programme.extra`/`channel.extra` hold unknown child elements; your `parseDay`/`channelInfo` can emit them the same way
- **Warnings, not crashes** — malformed feeds never abort the stream: a programme with a missing/invalid `start` is skipped, a `<channel>` without its required `id` (or a `<programme>` without its required `channel`) is skipped, bad attribute values are dropped, a duplicated attribute or single-occurrence element keeps its first value (the repeat is ignored), truncated input is detected — each reported as a `{ type: 'warning' }` parse event with a code, message and `line`/`col` (costs ~2% throughput). One bad programme in a 20 MB feed costs you one programme, not the guide. Pass `{ tolerateMissingId: true }` to keep id-less channels/programmes (attribute left `""`) instead — e.g. a single-channel feed that omits the reference everywhere, leaving the merge layer to attach them to the one known channel — and `{ rootScanLimit: bytes }` to tune how much head is buffered while looking for the root `<tv>` before bailing (default 1 MiB)
- **Merge strategies** — combine multiple sources per channel, including merging multi-language attributes of the same programme

Requires Node.js >= 20 (Node >= 23.6 to load `epg.config.ts` directly via native type stripping).

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

Events are `meta`, `channel`, `programme` and `warning` — a malformed guide never throws mid-stream, it just reports what it skipped and keeps going.

Small guide and you'd rather have it all at once? `parseXmltvString` is the synchronous whole-document form:

```ts
import { parseXmltvString } from 'epg-tools/xmltv';

const { meta, channels, programmes, warnings } = parseXmltvString(xml);
```

Writing back out mirrors it — `writeXmltvStream` (async generator of string chunks), `writeXmltvToFile`, or the `XmltvParseStream` / `XmltvSerializeStream` Node `Transform`s if you'd rather drop into `stream.pipeline()`. See [Programmatic API](#programmatic-api) for the full export list and [Benchmarks](#benchmarks) for how it measures up against `@iptv/xmltv`, `epg-parser` and `fast-xml-parser`.

## Quick start

Create `epg.config.ts`:

```ts
import { defineConfig, defineSiteConfig } from 'epg-tools';

const example = defineSiteConfig({
  site: 'example.tv',
  channels: [
    { xmltvId: 'one.example.tv', siteId: '101', name: 'Example One', logo: 'https://example.tv/one.png' },
  ],
  concurrency: 2,
  delayMs: 250,
  ky: {
    prefix: 'https://api.example.tv',
    headers: { 'x-api-key': process.env.EXAMPLE_KEY! },
    retry: 2,
  },
  async fetchDay({ channel, date, http }) {
    return http.post('epg', {
      json: { channel_id: channel.siteId, date: date.toISOString() },
    }).json<{ items: { start: string; end: string; title: string; desc?: string }[] }>();
  },
  parseDay({ data, channel }) {
    return data.items.map((item) => ({
      channel: channel.xmltvId, // normalized automatically anyway
      start: new Date(item.start),
      stop: new Date(item.end),
      title: [{ value: item.title, lang: 'sk' }],
      ...(item.desc ? { desc: [{ value: item.desc, lang: 'sk' }] } : {}),
    }));
  },
});

export default defineConfig({
  sites: [example], // order = priority when several sites cover the same channel
  days: 14,
  output: 'public/epg.xml',
  // indent: 2,     // pretty-print the guide; omit for compact output (default)
  cache: {
    dir: '.epg-cache',
    format: 'ndjson', // or 'xmltv'
    staleness: {
      alwaysRefetchDays: 1, // always refetch today
      maxAgeDays: 7,        // bust anything grabbed more than 7 days ago
    },
  },
  merge: {
    channelStrategy: 'merge-programmes',
    programmeStrategy: 'merge',
  },
});
```

Then:

```sh
epg build            # grab stale/missing days, then write the merged guide
epg grab             # grab only
epg merge            # write the guide from cache only
epg prune            # drop cached days older than today
epg build -d 14 -o public/epg.xml
epg build --offset 1 # start the window tomorrow instead of today
epg build -o /home/hts/.hts/tvheadend/epggrab/xmltv.sock  # write into a socket
```

Any output — `config.output`, `-o`, or the grabber's `--output` — may be a Unix
socket instead of a file. If the path is already a socket it is connected to
and streamed into, and closing it is what tells the reader the document is
complete; that is exactly what tvheadend's **External XMLTV** module expects,
so a cron job can push a guide straight into a running tvheadend without a
grabber being registered at all. A path that is *not* a socket is written to a
temp file and renamed into place, so a reader never sees half a guide.

`--offset` shifts the window only; "now" is unchanged, so staleness and the
`grabbedAt` stamp keep using the real current time and the post-grab prune
never removes a day inside the window. Negative values work in both the
`--offset -1` and `--offset=-1` forms.

## Using it as an XMLTV grabber

Consumers like tvheadend and `tv_find_grabbers` expect an executable named
`tv_grab_<country>[_<source>]` that speaks the
[XMLTV grabber protocol](https://wiki.xmltv.org/index.php/XmltvCapabilities).
`runXmltvGrabber` turns an `epg.config.ts` into one:

```js
#!/usr/bin/env node
// tv_grab_sk_example — chmod +x, then put it on your PATH
import { runXmltvGrabber } from 'epg-tools/tv-grab';

process.exitCode = await runXmltvGrabber(
  // A function, so --capabilities/--description/--version answer without
  // loading the config. It receives the grabber's configuration file, so
  // credentials can reach your site configs.
  (conf) => import('./epg.config.ts').then((m) => m.default),
  { description: 'Slovakia (tv_grab_sk_example)', version: '0.1.0' },
);
```

```sh
tv_grab_sk_example --configure                     # write the channel selection
tv_grab_sk_example --days 7 --offset 1 --quiet     # XMLTV on stdout
```

Capabilities advertised: `baseline`, `manualconfig`, `apiconfig`, `cache`,
`preferredmethod`, and `newchannels` — the last a *proposed* capability,
described on the XMLTV wiki but not implemented by `XMLTV::Options`. `lineups`
is available too, but opt-in: it needs data no grabber has by default (see
[Channel lineups](#channel-lineups)).

**Installing it in tvheadend.** It finds grabbers by running `tv_find_grabbers`
or scanning `PATH` for `tv_grab_*`, then asks each for its `--description` — so
put the file on `PATH` and restart the EPG grabber scan. It then runs the
grabber **with no arguments** and reads stdout, so `--days` comes from your
`epg.config.ts`; anything else goes in the module's *Extra arguments* field.
Configuring it is your job — tvheadend has no support for that — and it runs as
its own user, so configure as that user or the grabber will look in the wrong
`$HOME`:

```sh
sudo -u hts tv_grab_sk_example --configure   # → /home/hts/.xmltv/tv_grab_sk_example.conf
```

| option | meaning |
|---|---|
| `--capabilities`, `--description`, `--version` / `-v` | answered without touching the config or the network |
| `--help` / `-h` | usage; exits **1**, matching the reference grabbers |
| `--configure` | ask the questions and write the config file |
| `--configure-api [--stage NAME]` | print one configuration stage as XML, for a caller doing its own prompting |
| `--list-channels` | an XMLTV document of `<channel>` elements — every channel the grabber can deliver, whatever the config selects |
| `--config-file FILE` | defaults to `$HOME/.xmltv/<grabber name>.conf` |
| `--days N` | defaults to the config's `days` |
| `--offset N` | days from today; may be negative |
| `--output FILE` | defaults to stdout; a path that is a Unix **socket** is connected to and streamed into |
| `--quiet` | stderr carries errors only |
| `--debug` | per-channel-day progress on stderr |
| `--cache [DIR]` | override the cache directory; bare `--cache` means "as configured" |
| `--no-cache` | grab into a scratch directory and discard it — every day refetched, nothing left on disk |
| `--preferredmethod` | prints `allatonce`: ask once for a wide window rather than looping over `--offset` |
| `--channel-updates add\|ignore\|notify\|signal` | what to do about channels that appeared upstream; defaults to `notify` |
| `--list-lineups` | `lineups` only: the lineups this grabber can deliver, as `xmltv-lineups.xsd` — answered with no configuration at all |
| `--get-lineup` | `lineups` only: the lineup the configuration selected |

The XMLTV document is the only thing on stdout; progress and errors go to
stderr. Exit codes are 0 on success, 1 for a bad command line, a missing
configuration, or partial data (a channel-day that failed to grab). New
channels are reported but do not change the exit code unless you ask for it
with `--channel-updates signal`, which uses 2 (see below).

### Capabilities of your own

Every advertised capability this package ships is built with the same public
API a third party uses — `manualconfig`, `apiconfig`, `cache`,
`preferredmethod` and `newchannels` are all `defineCapability` calls. Only the
always-on information options and `baseline` live in the core, because
`baseline` is not a plug-in: it is the grab that capabilities plug into.

Cut down, this is how the shipped `lineups` capability is put together:

```ts
import {
  defineCapability, DEFAULT_CAPABILITIES, GrabberError, runXmltvGrabber,
} from 'epg-tools/tv-grab';

const myLineups = defineCapability({
  name: 'my-lineups',
  options: { 'list-lineups': { type: 'boolean' }, 'get-lineup': { type: 'boolean' } },
  // Which options make up each invocation. The text comes from the specs.
  usage: { modes: [['list-lineups', 'output'], ['get-lineup', 'config-file', 'output']] },
  async run(ctx) {
    if (ctx.values['list-lineups']) {
      await ctx.emit(myLineupsXml());   // no config needed, so answer now
      return 0;                         // a number ends the run with that code
    }

    if (ctx.values['get-lineup']) {
      // This one needs the config, so wait for it rather than claim the run.
      ctx.onConfigLoaded(async (conf) => {
        if (conf === undefined) {
          throw new GrabberError('You need to configure the grabber first.');
        }

        await ctx.emit(myLineupXml(conf.lineup?.[0]));
        return 0;
      });
    }
  },                                    // returning nothing: carry on
});

await runXmltvGrabber(source, {
  description: '…', version: '0.1.0',
  capabilities: [...DEFAULT_CAPABILITIES, myLineups],
});
```

One hook. Every capability's `run` is called at the same point — before the
configuration file is read, since `--capabilities` and `--preferredmethod` must
answer without one — and it either claims the run by returning an exit code, or
hooks itself into a later point and returns nothing. The XMLTV dispatch order
is load bearing, so those later points are what a capability subscribes to:

| register in `run` | runs | used by |
|---|---|---|
| `ctx.onConfigLoaded(conf => …)` | once the config file is read, while a missing one is still allowed | `apiconfig` |
| `ctx.onAdjust((config, { conf, selection }) => config)` | with a config in hand, to shape the grab rather than replace it | `cache`, `newchannels` |
| `ctx.onFinish(() => …)` | once the guide has been written | `cache`, for `--no-cache` |
| `ctx.addStage(stage)` | not a callback: a question of your own, asked last while configuring | `lineups` |

A deferred task claims the run the same way `run` does — by returning an exit
code. Because these are registrations rather than slots, one capability can
serve an option that needs no configuration *and* one that requires it, as
the lineups sketch above does; and because a task decides for itself what a missing
config means, it can print the message the reference prints for that option
rather than a generic one.

`onConfigLoaded` is also the only way to *read* the configuration, and
`ctx.replaceConfig(conf)` the only way to change it — there is no load and no
save. The file is read once, before any task runs, and written once, on the way
out, and only if what the run ends up holding differs from what was read. So a
capability never learns where the file lives or when to write it, an equal
replacement leaves it untouched, and two capabilities changing the
configuration in one run produce one write rather than clobbering each other.
That is how `--configure` stores its answers and how `--channel-updates add`
adds a channel.

`ctx.onAdjust` also gets `selection`, to add or remove channels before the
grab, and pairs with `ctx.setExitCode()` for an advisory exit code that a real
failure still outranks.

`ctx.addStage(stage)` is the odd one out, because a question to ask is data
rather than a callback: both renderings of the stage model pick it up, so
`--configure` and `--configure-api` get it at once. It goes last — whatever
finished before now leads to it — and its own `next` says how configuration
ends, either `select-channels` to go on and choose channels or `end` when its
answer has already settled them. It is checked exactly as the grabber's own
`stages` are, so a stage that could never finish is a `TypeError` naming the
capability's mistake rather than a `--configure` that hangs.

For anything short of failure there is `ctx.warn(line)` — one line on stderr,
terminated for you, and always available, unlike the `ctx.log?.()` progress
callback that `--quiet` removes. A warning is a signal rather than progress, so
`--quiet` keeps it: that is how `newchannels` reports a channel that is no
longer offered.

To fail, throw a `GrabberError`: its message becomes the one line on stderr
that the protocol expects and its code becomes the exit code, defaulting to 1.
It is caught wherever it is thrown — `run`, any registered task, or the config
resolver — so an error path is one expression rather than a write, a newline,
and a code threaded back by hand. Anything else you throw is a bug and keeps
its stack trace. It is exported from the package root as well as from
`/tv-grab`, because `epg build` hits the same wall — a configuration that
cannot say what a site's password is fails identically whichever command asked
— and prints it the same way, one line without a stack.

A capability's options only exist when it is advertised, and a name or option
that collides with something built in is a startup error.

`--help` is assembled the same way. A capability does not write usage text: it
lists which of its options — and which of the framework's, like `config-file`
or `output` — make up each invocation, and the synopsis is derived from the
specs. Whether an option takes a value, what that value is called
(`placeholder: 'FILE'`), what it does (`description`), and whether there is a
`--no-` form are all declared once on the option itself, so they cannot drift
out of step with the text, and the grabber name is filled in rather than
hardcoded:

| in `usage` | prints |
|---|---|
| `info: ['preferredmethod']` | `tv_grab_x --preferredmethod`, with the other information forms |
| `grab: ['cache']` | `[--cache [DIR] \| --no-cache]` on the plain grab form |
| `modes: [['configure', 'config-file']]` | `tv_grab_x --configure [--config-file FILE]` |

Naming an option nobody declared is a startup error too, rather than a
synopsis advertising a flag that does not exist.

`--help` then prints what each option does, grouped by the capability that
declares it — so the list doubles as an answer to "what do I get if I advertise
that?". An unknown option prints the synopsis alone: the caller mistyped one
flag and does not need every other one explained.

### When the channel list changes

A channel added upstream is not grabbed just because it exists — that would
quietly widen what you asked for. It is *reported*, because the configuration
file records declined channels as `channel!<xmltvId>`: a channel in neither
list is one you have never been asked about, which is what makes "new"
distinguishable from "no thanks".

```sh
tv_grab_sk_example --quiet            # exit 0
# New channel(s) available: five.example.tv — run --configure to include them

tv_grab_sk_example --channel-updates add     # grab them and record them
tv_grab_sk_example --channel-updates signal  # the same message, but exit 2
tv_grab_sk_example --channel-updates ignore  # say nothing
```

`notify` is the default, and its message is printed even under `--quiet` since
it *is* the signal — but the run still **exits 0**, because a complete guide is
a successful run. `newchannels` is a proposed capability that nothing else
implements, so to every existing consumer a non-zero exit means only "this
grabber failed"; a pipeline that had worked for months would break on the day a
provider added a channel, with nothing having changed locally.

`--channel-updates signal` opts into exit 2 for a caller that would rather
detect this than scrape stderr. It is 2 because 1 already means partial data
and the two must be distinguishable: here 0 is fine, 1 failed, 2 is fine but
worth knowing. A real grab failure outranks it and still exits 1.

A configured channel that stops being offered is reported but **never removed
automatically** — a site whose channel list is fetched can come back short
after a transient failure, and deleting your selection on that basis would be
unrecoverable. Remove it yourself, or reconfigure.

The configuration file is the standard line-oriented XMLTV format, so it stays
hand-editable as `manualconfig` promises — `channel=<xmltvId>` per selected
channel, `channel!<xmltvId>` for a deselected one, `#` comments ignored.

### Asking for more than channels

`--configure` and `--configure-api` are two renderings of one model, exactly as
in XMLTV — `XMLTV::Configure` prompts by *interpreting* the same stage document
that `--configure-api` prints. Describe the questions once with `stages` and
both work; the answers reach the config through the context `defineConfig`
hands its factory:

```ts
// epg.config.ts — one file, driven by `epg build` and by the grabber
export const stages = [{
  name: 'start',              // the first stage is always `start`
  next: 'select-channels',    // …and the last leads here, or to `end`
  fields: [
    { type: 'string', id: 'username', title: 'Username', description: 'Your account name.' },
    { type: 'secretstring', id: 'password', title: 'Password', description: 'Not echoed.' },
  ],
}];

export default defineConfig(
  (ctx) => ({
    sites: [example({ username: ctx.require('username'), password: ctx.require('password') })],
    days: 7,
    output: 'guide.xml',      // ignored by the grabber, which streams to stdout
  }),
  { stages, env: 'TV_GRAB_SK_EXAMPLE_' },
);
```

```js
// tv_grab_sk_example — the stages came with the config, so they cannot drift
import config from './epg.config.ts';
process.exitCode = await runXmltvGrabber(config, { description: '…', version: '0.1.0' });
```

An answer is looked for in each **source** in turn: what the caller supplied,
then the environment (`username` → `TV_GRAB_SK_EXAMPLE_USERNAME`), then the
field's own `default`. The grabber supplies a source over the configuration file
it loaded, so `--configure` answers win there; `epg build` supplies none, so the
environment answers and the same file builds a guide with no `.conf` in sight.
Nothing in `epg.config.ts` knows which one replied.

That order is the config's to state, not this package's:

```ts
defineConfig(factory, { readers: (supplied) => [envReader('TV_GRAB_SK_EXAMPLE_'), ...supplied] })
```

now puts the environment first, for a deployment where it is the truth and a
stale `.conf` is a hazard. A reader is just a named lookup — `{ name, read(id),
describe?(id) }` — so a secrets file or a vault export is one too, and anything
genuinely asynchronous can be `await`ed inside the factory, which may be async.

`ctx.require()` fails with one line naming every place the value could have
come from — *"No value for "password": run --configure to be asked for it, or
set TV_GRAB_SK_EXAMPLE_PASSWORD"* — rather than letting `undefined` reach a
site. `ctx.get()` returns `undefined` instead, and `ctx.all()` returns every
value for a question answered more than once. An empty answer is not an answer:
`username=` in the file, or an environment variable a shell expanded to
nothing, falls through to the next source.

Field types are `string`, `secretstring` (hidden while typing), `selectone` and
`selectmany`, plus `default` and — for `string` — `constant`, which is recorded
without asking. Channel selection is appended automatically as the final stage,
so `stages` is only needed when there is something *else* to ask.

`selectmany` — channel selection included — numbers its options and takes the
whole answer at once, since a source can carry hundreds of channels:

```
  1) bbc1.example.tv — BBC One
  2) bbc2.example.tv — BBC Two
  3) itv1.example.tv — ITV1
Select [1-3, ranges like 2-7, all, none] 1-2,5 8
```

`all` and `none` (or an empty line) answer everything at once. Deselected
options are written to the config file as `channel!<xmltvId>`, so a later
reconfigure can still see what was turned down.

The channels on offer are resolved from the answers *just given*, as the
reference does it — so a site that needs the login to fetch its channel list
gets it during the very run that asks for the password.

Machine-driven, the same walk is `--configure-api --stage start`, then
`--stage <the nextstage it named>`, until a stage's `<nextstage>` is
`select-channels`; that last one is generated from `--list-channels`. Each stage
is an `xmltvconfiguration` document. As in the reference, any stage other than
`start` requires a configuration file to already exist, since a stage may depend
on earlier answers.

A stage may also name `end`, which finishes configuration *without* offering
channels — for a stage whose own answer has already settled them. That is what
`lineups` uses, and it is the same `end` the reference's channel-selection stage
ends with.

Two deliberate differences from `XMLTV::Options`: `--days` falls back to your
config's value rather than the reference's hardcoded 5, and `--cache` names the
day-cache **directory** rather than an HTTP cache file.

### Channel lineups

A lineup is a *reception platform* — a DVB multiplex, a set-top box package, an
IPTV bouquet, or just a list — that a consumer can offer instead of a wall of
channel checkboxes. It is opt-in because it needs data your sites do not carry:
pass the lineups to `lineupsCapability` and add it to `capabilities`.

```js
import {
  runXmltvGrabber, DEFAULT_CAPABILITIES, lineupsCapability, lineupsFromSites,
} from 'epg-tools/tv-grab';

process.exitCode = await runXmltvGrabber(config, {
  description: 'Slovakia (tv_grab_sk_example)',
  version: '0.1.0',
  // A fixed array, or a function of your EpgConfig — which lineupsFromSites is.
  capabilities: [...DEFAULT_CAPABILITIES, lineupsCapability(lineupsFromSites)],
});
```

```sh
tv_grab_sk_example --list-lineups     # what is on offer — needs no config file
tv_grab_sk_example --get-lineup       # the one that was configured
```

`lineupsFromSites` builds one `List` lineup per site, which fits a grabber whose
sites genuinely *are* separate platforms; it fills each entry's `<preset>` from
the optional `preset` on a `GrabberChannel`. Anything else is written out by
hand as `LineupConfig[]`, since a lineup is normally fed by several sites:

```js
lineupsCapability([{
  id: 'dvbt-west',
  type: 'DTV',                                     // DTV | STB | IPTV | Analog | List
  displayName: [{ value: 'DVB-T West', lang: 'en' }],
  availability: [{ value: 'SK', area: 'country' }],
  entries: [{
    preset: '1',
    station: { xmltvId: 'one.example.tv', name: 'One', type: 'TV' },
    // At most one kind of delivery per entry — the schema is an xs:choice.
    dvb: [{ originalNetworkId: 8442, transportId: 2049, serviceId: 4351, lcn: '1' }],
  }],
}])
```

A station's `xmltvId` becomes its `rfc2838` attribute, which is the join with
the guide: it is the same id as `<channel id>`, so a consumer can match an entry
to the programmes for it. The output follows `xmltv-lineups.xsd`, whose element
order is fixed — the serializer emits it, so you do not have to know it.

> **Configuring a lineup replaces per-channel selection.** With the capability
> on, `--configure` asks which lineup and then *stops*: the lineup names the
> channels, so they are not offered separately, and the config file holds
> `lineup=<id>` instead of `channel=` lines. This is the reference's own
> behaviour. Declaring exactly one lineup selects it without asking. A
> configuration written before you added lineups keeps naming its channels one
> by one and goes on working.

Because such a configuration records no channel decisions, `newchannels` stays
quiet under it — the lineup decides what is in, so "run `--configure` to include
them" would be advice that does not include them.

## Per-site HTTP settings, and proxies

Everything that shapes a request belongs to the site, not the run: each site
gets its **own** `ky` instance built from its `ky` options, its own request
queue (`concurrency`, `delayMs`), and its own `days`, `staleness` and
`batchSize`. Nothing is shared, so sites with different rate limits,
credentials or hosts coexist in one process — you do not need a process per
site to keep their settings apart, and since the config is TypeScript, per-site
environment variables are just code:

```ts
ky: { prefix: 'https://api.a.example.tv', headers: { 'x-api-key': process.env.A_KEY! } },
```

A proxy for one site is the same idea: ky passes options it does not recognize
down to `fetch`, and Node's `fetch` honours a `dispatcher`.

```ts
import { ProxyAgent } from 'undici';

const behindProxy = defineSiteConfig({
  site: 'a.example.tv',
  ky: {
    prefix: 'https://api.a.example.tv',
    dispatcher: new ProxyAgent('http://user:pass@proxy.local:3128'),
  },
  // …
});
```

Only that site is tunnelled; the others go out directly. Three things to know:

- **Pin `undici` to the major Node bundles** — `node -p process.versions.undici`.
  A mismatched major fails every request with
  `InvalidArgumentError: invalid onRequestStart method`, because the dispatcher
  handler API differs between the standalone package and the copy inside Node.
- **Keep the global `fetch`.** Pairing ky with undici's *own* `fetch` export
  does not work: ky hands it a global `Request`, which it rejects with
  `Failed to parse URL from [object Request]`.
- `dispatcher` typechecks wherever `RequestInit` comes from Node's types
  (`lib` without `DOM`, as in this package). With the DOM lib in scope, DOM's
  `RequestInit` shadows it and has no `dispatcher`; then pass it through a
  custom fetch instead:
  `ky: { fetch: (input, init) => fetch(input, { ...init, dispatcher } as RequestInit) }`.

Node 24 also understands `NODE_USE_ENV_PROXY=1` with `HTTP_PROXY`/`HTTPS_PROXY`
/`NO_PROXY`, but that applies to the whole process — every site or none.

## How caching works

Each `site + channel + day` is one cache entry (`<dir>/<site>/<channel>/<day>.ndjson` + a small meta sidecar recording when it was grabbed). On every run a channel-day is refetched only when:

- it is not cached yet (e.g. day 14 after a day passed), or
- it is within `alwaysRefetchDays` from today (near-term EPG changes often), or
- it was grabbed more than `maxAgeDays` ago.

Everything else is served from disk. Old days are pruned automatically after a grab (disable with `cache.prune: false`).

## Batching many channels per request

Some sources return many channels' schedules in one call (`?channels=a,b,c&date=…`). Instead of `fetchDay` (one channel-day per request), give a site a `fetchDayBatch` — the grabber groups the day's **stale** channels (only those actually needing a refetch) into one request, then runs your existing `parseDay` per channel over the shared response:

```ts
const example = defineSiteConfig({
  site: 'example.tv',
  channels: [/* … */],
  batchSize: 50, // optional cap per request; omit to put all stale channels in one
  async fetchDayBatch({ channels, date, http }) {
    return http.get('epg', {
      searchParams: { ids: channels.map((c) => c.siteId).join(','), date: date.toISOString() },
    }).json<{ items: { channelId: string; programmes: RawProgramme[] }[] }>();
  },
  parseDay({ data, channel }) {
    const item = data.items.find((i) => i.channelId === channel.siteId);
    return item ? item.programmes.map(/* … */) : [];
  },
});
```

Because caching stays per channel-day, a run only ever batch-fetches the channel-days that are missing or stale — no fetching everything each time. A site provides `fetchDay` **or** `fetchDayBatch` (the latter wins if both are set); `concurrency`/`delayMs` then throttle whole batches. A failed batch request fails every channel-day it covered; a single channel's `parseDay` error only drops that channel.

## Merge strategies

When several sites cover the same `xmltvId` (site order in `sites` = priority):

- `channelStrategy`
  - `merge-programmes` (default) — one `<channel>` with metadata merged from all covering sites (display names unioned by `(lang, value)`, icons by `src`, priority site first), programmes combined from all covering sites
  - `first-wins` — one `<channel>`, programmes only from the first covering site
  - `keep-all` — no deduplication
- `programmeStrategy` (for `merge-programmes`)
  - `merge` (default) — programmes with the same start time become one element; language-tagged fields (`title`, `desc`, `category`, …) are unioned by `(lang, value)` — grab the same channel from a Slovak and an English source and get both languages in one programme
  - `concat` — keep all programmes sorted by start

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

## Programmatic API

```ts
import { build, runGrab, runMerge } from 'epg-tools';
import config from './epg.config.ts';

const summary = await build(config, { logger: console.log });
console.log(summary); // { fetched, fromCache, failed }
```

`build`, `runGrab`, `runMerge` and `guideStream` all take either shape — a
plain `EpgConfig` or a `defineConfig` factory still waiting for its answers —
so the import above works whichever your config file is, exactly as the CLI
does it. A build resolves the factory once and hands the result to both halves,
so the grab and the merge that follows it cannot disagree. `createCacheStore`
is the exception: it returns synchronously, so it takes a resolved `EpgConfig`
(`resolveConfigSource(config)` if you have the other kind).

`guideStream(config, options)` is the file-less form of `runMerge` — the same
merged guide as an async generator of XML chunks, for piping to stdout or an
HTTP response with constant memory:

```ts
import { guideStream } from 'epg-tools';
import { Readable } from 'node:stream';

await pipeline(Readable.from(guideStream(config, { offset: 1 })), process.stdout, { end: false });
```

Lower-level pieces are exposed as subpath exports:

```ts
import { parseXmltvFile, writeXmltvStream } from 'epg-tools/xmltv';
import { FsCacheStore, isStale } from 'epg-tools/cache';
import { grab, defineSiteConfig } from 'epg-tools/grabber';
import { generateGuide, writeGuide, mergeProgrammes } from 'epg-tools/merge';
```

`generateGuide` is an async generator of XML chunks — pipe it anywhere (file, HTTP response) with constant memory:

```ts
import { Readable } from 'node:stream';

reply.type('application/xml');
return Readable.from(generateGuide({ sites, cache, days: 14 }));
```

Serialization is **compact by default** (no whitespace between elements — smaller output, and what a machine consumer like tvheadend wants). Pass `indent` to pretty-print, mirroring `JSON.stringify`: a number of spaces or a string like `'\t'`. It is accepted by `writeXmltvStream`, `writeXmltvToFile`, `serializeChannel`, `serializeProgramme`, `serializeDocumentHeader`/`serializeDocumentFooter` (which, with the element serializers, let you assemble a document by hand), `generateGuide`/`writeGuide`, and `defineConfig`:

```ts
writeXmltvStream(input, { indent: 2 });     // two-space pretty-print
serializeProgramme(programme);              // compact (default)
```

Both directions also come as Node `Transform` classes for `stream.pipeline()` — `XmltvParseStream` (bytes → parse-event objects) and `XmltvSerializeStream` (tagged `{ type, value }` events → XML bytes). They are symmetric: the events `XmltvParseStream` emits are exactly what `XmltvSerializeStream` consumes, so a `parse → serialize` pipeline round-trips.

```ts
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { XmltvParseStream, XmltvSerializeStream } from 'epg-tools/xmltv';

// Parse a file into events ({ type: 'meta' | 'channel' | 'programme' | 'warning', value }):
await pipeline(createReadStream('guide.xml'), new XmltvParseStream(), async (events) => {
  for await (const event of events) { /* … */ }
});

// Serialize a tagged event stream to a file (a `meta` event sets the <tv> attributes,
// then channels, then programmes):
await pipeline(source, new XmltvSerializeStream({ meta }), createWriteStream('guide.xml'));
```

`XmltvParseStream`'s object-mode output carries `warning` events inline with the data; `XmltvSerializeStream` produces XML text, so any `warning` event it receives is re-surfaced as a `'warning'` event on the stream (`stream.on('warning', w => …)`) rather than lost. A `meta` event supplies the base `<tv>` attributes; the constructor `meta` option overrides them field-by-field (handy for relabelling a passed-through guide). Misuse errors the stream: a `meta` event after the first channel/programme, or an unrecognized event type. The `highWaterMark` option (default 16 KiB) tunes chunking: `writeXmltvStream` accumulates that many characters before yielding, while `XmltvSerializeStream` pushes each element and lets its readable buffer (`highWaterMark`) coalesce them.

For a small guide where streaming ergonomics aren't worth it, `parseXmltvString` gives the same synchronous call-it-and-get-a-result shape as other XMLTV parsers (e.g. `@iptv/xmltv`'s `parseXmltv`) — one object with everything collected, including `warnings` (non-fatal parse problems, above), which most other parsers don't expose at all:

```ts
import { parseXmltvString } from 'epg-tools/xmltv';

const { meta, channels, programmes, warnings } = parseXmltvString(xml);
```

## License

MIT

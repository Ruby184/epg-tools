# Site configuration

A **site** is one source of programme data: where to fetch from, how much of
the channel × day grid a single request covers, and how to turn a response
into programmes. A config lists as many as you like, in priority order.

```ts
import { defineSiteConfig } from 'epg-tools';
```

Use `defineSiteConfig` rather than a bare object literal — it infers the
batching mode (which types `request`'s context and decides which size caps are
accepted) and the type of a channel's `data` from what `channels` returns.

While writing one, `epg try <site> <channel>` puts a single channel-day through
the whole path and shows the request that went out, the payload that came back
and the programmes it parsed to — see [trying one
channel-day](./configuration.md#trying-one-channel-day). It writes nothing, so
it cannot leave a half-built site's output in the cache.

- [Reference](#reference)
- [Channels](#channels)
  - [A channel list that has to be fetched](#a-channel-list-that-has-to-be-fetched)
- [Requests and parsing](#requests-and-parsing)
  - [Building programmes](#building-programmes)
  - [The `<channel>` element](#the-channel-element)
  - [Saying something](#saying-something)
- [Batching](#batching-how-much-one-request-covers)
- [HTTP settings and proxies](#http-settings-and-proxies)
- [Rate limits and backoff](#rate-limits-and-backoff)

## Reference

| field | type | default | what it is |
|---|---|---|---|
| `site` | `string` | **required** | Unique site identifier, e.g. `webtv.sk`. Used as the cache namespace. |
| `channels` | `GrabberChannel[]` or `(ctx) => GrabberChannel[] \| Promise<…>` | **required** | The channels to grab, written out or [fetched](#a-channel-list-that-has-to-be-fetched). |
| `cacheChannels` | `boolean \| { maxAgeDays? }` | off | Keep a **fetched** channel list in the cache, so the next command reads it instead of asking the source — see [keeping a fetched list](#keeping-a-fetched-list). `true` means a day. |
| `conditionalGet` | `boolean` | off | Ask the source whether anything has changed, and keep what is cached when it says no — see [asking only when it is worth it](#asking-only-when-it-is-worth-it). No code changes in the site. |
| `request` | `(ctx) => Promise<TRaw>` | **required**\* | Fetch one request's raw data. The context's shape comes from `batching`. |
| `parseDay` | `(ctx) => ParsedProgramme[] \| Promise<…>` | **required**\* | Turn part of a response into one channel-day's programmes. Called once per channel-day. May return builders, plain objects, or a mix. |
| `stream` | `(ctx) => AsyncIterable<StreamedChannelDay>` | — | \*Instead of `request` and `parseDay`: answer the whole window in one pass, yielding each channel-day as it is complete — see [sites that answer in one pass](#sites-that-answer-in-one-pass). |
| `channelInfo` | `(channel, element) => XmltvChannel \| ChannelBuilder` | `defaultChannelInfo` — id, display name and logo | Build the `<channel>` element for a channel. |
| `transform` | `(programme, ctx) => XmltvProgramme \| null` | — | A last say over each of this site's programmes as the cache is **read** — see [fixing up one source](#fixing-up-one-source). |
| `days` | `number` | the config's `days`, then `7` | Override how many days this site grabs. |
| `concurrency` | `number` | `1` | How many requests this site may have in flight at once. |
| `rateLimit` | `{ requests, perMs, strict? }` | unset — no pacing | How often this site may be asked. `strict` defaults to `true` (sliding window). |
| `backoff` | `false \| SiteBackoff` | on: `{ statuses: [429, 503], fallbackMs: 5000, maxMs: 60000, adapt: true }` | What to do when the source says slow down. |
| `batching` | `BatchMode` or `{ mode, channelsPerRequest?, daysPerRequest? }` | `'none'` | How much of the channel × day grid one `request` covers. |
| `ky` | ky `Options` | — | Base options for this site's own ky instance: `prefix`, `headers`, `hooks`, `retry`, `timeout`, `dispatcher`, … |
| `staleness` | `Partial<StalenessPolicy>` | the config's policy | Per-site override of when a cached day is refetched — including `emptyMaxAgeDays`, worth raising for a source with genuinely empty channels in it. |

### `GrabberChannel`

| field | type | what it is |
|---|---|---|
| `xmltvId` | `string` | **Required.** The channel id used in the generated XMLTV output. |
| `siteId` | `string` | **Required.** The channel id the source site understands. |
| `name` | `string` | Display name, used by the default `channelInfo`. |
| `lang` | `string` | The language this channel broadcasts in. Used as the **default `lang` for every text element** the scoped [`programme` builder](#building-programmes) creates, so a site says it once here instead of on every title and description. |
| `logo` | `string` | Icon URL, used by the default `channelInfo`. |
| `preset` | `string` | The number this channel appears on. Written as a lineup entry's `<preset>` by the [`lineups` capability](./tv-grab.md#channel-lineups); ignored by the guide. |
| `data` | `TData` | Anything else the site knows about this channel, kept as it came and handed back to `channelInfo` and `parseDay`. Its type is inferred from what `channels` returns. |

## Channels

The simple form is a list:

```ts
const example = defineSiteConfig({
  site: 'example.tv',
  channels: [
    { xmltvId: 'one.example.tv', siteId: '101', name: 'Example One', lang: 'sk',
      logo: 'https://example.tv/one.png' },
  ],
  // …
});
```

### A channel list that has to be fetched

`channels` also takes a function, called with the site's own HTTP client — so
a site whose channels come from the source sets up nothing of its own: no
repeated prefix, no second copy of the credentials. Whatever else the source
said about a channel goes in `data`, and comes back in `channelInfo` and
`parseDay` with its type intact:

```ts
const example = defineSiteConfig({
  site: 'example.tv',
  ky: { prefix: 'https://api.example.tv', headers: { 'x-api-key': process.env.EXAMPLE_KEY! } },
  async channels({ http }) {
    const { items } = await http.get('channels').json<{
      items: { id: string; titles: { text: string; lang: string }[]; logo: string; number: number }[];
    }>();

    return items.map((item) => ({
      xmltvId: `${item.id}.example.tv`,
      siteId: item.id,
      data: { names: item.titles, logo: item.logo, lcn: item.number },
    }));
  },
  // …
});
```

`data` is per channel and so optional; read it as `data?.x` unless you know
every channel in your list carries one. The grabber never looks inside it.

The function is called only when channels are actually wanted, so
`--capabilities`, `--description` and `--version` still answer without touching
the network, and `--configure` resolves the list *after* asking for the
password — which is what lets the account decide what is on offer. Fetching
the list is a request to the same source as the rest, so it goes through the
site's own queue: a `rateLimit` spaces the first day fetched after it instead
of the two landing together.

A build resolves it **once** and hands the same list to both halves, for the
reason it resolves a `defineConfig` factory once — the merge reads what the
grab wrote, and a list that changed in between would leave the guide describing
channels nothing went for. `runGrab` and `runMerge` on their own resolve for
themselves, as does `--list-channels`; [`resolveChannels` and
`resolveSites`](./api.md#epg-toolsgrabber) are exported for code of your own
that wants a site's channels without caring which form they came in.

### Keeping a fetched list

One process resolving once is not the same as one *machine* resolving once:
`epg grab` and then `epg merge` are two commands and each asks. `cacheChannels`
puts the list in the cache instead, [beside the
listings](./api.md#what-a-site-remembers-between-runs):

```ts
const example = defineSiteConfig({
  site: 'example.tv',
  cacheChannels: true,             // a day; { maxAgeDays: 7 } for longer
  async channels({ http }) { /* … */ },
  // …
});
```

Worth turning on when fetching the list is not free — a paginated API, a list of
thousands, a request that has to be paid for some other way — and worth leaving
off when it is, since a channel added to the source then turns up on the next run
rather than a day later. It applies to the function form only; a list written out
in the config is already there.

Two things to know. The list goes through JSON, so a channel's `data` must
survive that: a `Date` or a `Map` in there comes back a string or `{}`, and every
run but the one that fetched it sees the round-tripped form. And `--refresh`
fetches the list whatever is cached, because asking the source is what that flag
means.

## Requests and parsing

`request` fetches, `parseDay` interprets. They are separate because one
request can cover many channel-days: `parseDay` runs **once per channel-day**,
each call handed the same shared response.

What a `parseDay` call is given:

| field | type | what it is |
| --- | --- | --- |
| `payload` | `TRaw` | Whatever `request` returned, whole and unchanged. Every channel-day of that request sees this same value, so pick out the part belonging to `channel` and `day`. |
| `channel` | `GrabberChannel<TData>` | The channel being parsed, as the site declared it — its `siteId`, `lang` and `data` included. |
| `day` | `string` | The day being parsed, as `YYYY-MM-DD`. |
| `date` | `Date` | The same day as UTC midnight. |
| `programme` | `(start, title, options?) => ProgrammeBuilder` | A [builder bound to this channel-day](#building-programmes). |
| `http` | `KyInstance` | The site's client — the very instance `request` was handed. See [a parse that needs another request](#a-parse-that-needs-another-request). |
| `paced` | `<T>(task) => Promise<T>` | Run a request through the site's queue, so its `concurrency`, `rateLimit` and backoff apply to it. |
| `state` | `Map<string, unknown>` | What this site [remembers between runs](#remembering-something-between-runs). |
| `signal` | `AbortSignal \| undefined` | Already applied to `http`; here for work that does not go through it. |

```ts
const example = defineSiteConfig({
  site: 'example.tv',
  channels: [/* … */],
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
```

Afterwards each `programme.channel` is normalized to the channel's `xmltvId`
and the list is sorted by `start`.

`new Date(…)` there is right only because that source gives instants. When it
gives a wall clock instead — `2026-07-17 20:00`, meaning eight in the evening
where the broadcaster is — reach for
[`zonedXmltvDate`](./xmltv.md#named-zones), which reads it in the zone you name
rather than in whatever `TZ` the run happens to have:

```ts
programme(zonedXmltvDate(item.start, 'Europe/Bratislava'), item.title);
```

A failed `request` fails every channel-day it covered; one channel-day's
`parseDay` error only drops that channel-day.

### Remembering something between runs

`request` and `parseDay` are both handed `state`, an ordinary `Map` the site can
put things in — read from the cache at the start of the site's run, written back
at the end if anything changed:

```ts
async request({ channel, day, http, state }) {
  let token = state.get('token') as string | undefined;

  if (token === undefined) {
    token = (await http.post('session').json<{ token: string }>()).token;
    state.set('token', token);          // synchronous; saved once, for next time
  }

  return http.get(`epg/${channel.siteId}/${day}`, {
    headers: { authorization: `Bearer ${token}` },
  }).json();
}
```

For what a site would otherwise fetch again to get back to where it was: a
token, a cursor, a page count, an id it has already dealt with. Four things are
worth knowing.

- It is **one `Map` per site for the whole run**, not one per channel-day. A
  value written by one request is there for every later request and for every
  `parseDay`, and two of this site's pipelines running at once share it.
- Whatever goes in must survive `JSON.stringify` — it is a cache file.
- A store that remembers nothing (`NoCacheDriver`, a read-only filesystem) hands
  over an empty `Map` at the start of every run. Nothing breaks; nothing carries
  over.
- Two `epg grab` processes over the same site do not queue behind each other, so
  the last one to finish is the one whose state is kept. It is a cache, not a
  database.

Nothing else in the package reads it, and it is stored [beside the
listings](./api.md#what-a-site-remembers-between-runs) — `state.json` in the
site's cache directory.

### A parse that needs another request

Plenty of sources put the schedule in one response and the description of each
programme behind its own, so `parseDay` gets the same `http` the request had,
and `paced` to send a request through the site's queue:

```ts
async parseDay({ payload, programme, http, paced }) {
  return Promise.all(payload.items.map(async (item) => {
    const detail = await paced(({ signal }) =>
      http.get(`detail/${item.id}`, { signal }).json<Detail>());

    return programme(new Date(item.start), item.title)
      .stop(new Date(item.end))
      .desc(detail.synopsis);
  }));
}
```

`paced` is what makes such a request as polite as the grab around it: the
site's `concurrency` counts it, its `rateLimit` spaces it, and a `429` it meets
holds the site like any other. It queues **ahead** of the planned requests, so
a channel-day already in hand is finished rather than joined by another. What
it takes is the request rather than its result, because the queue has to own
the making of it — which is also why the wait is out here rather than inside
the client: a request that sat out a rate-limit window inside `ky` would have
that wait counted against its `timeout` and be aborted for taking the turn it
was told to wait for.

A request straight through `http` works too and still aborts with the run — it
is simply not queued, so nothing paces it. Requests a `request` makes itself
share the one slot it is already holding, which is the other reason a
per-programme fan-out belongs here rather than there.

How many responses a site holds while parsing them is its `concurrency`: one
per unit, so a site set to fetch two at a time never has a third in memory.

### Fixing up one source

`transform` is for what is wrong with a *particular source* rather than with the
guide: a category vocabulary of its own, a title with the channel name stuck on
the front, the filler it pads an unpublished schedule with.

```ts
transform(programme, { channel, day }) {
  if (programme.title[0]?.value === 'Program dňa') return null;   // drop the filler

  return {
    ...programme,
    category: programme.category?.map((c) => ({ ...c, value: GENRES[c.value] ?? c.value })),
  };
}
```

`parseDay` could do the same, and should when the fix is really about reading
the response. The difference is *when*: `transform` runs as the cache is **read**,
so changing it takes effect on the next `epg merge` rather than after a
refetch — and it applies to everything already cached. It also runs before this
site's programmes meet another site's, so what it returns is what gets merged,
and before `fillStop` and `clipOverlaps`, so a gap it leaves behind is
[closed up](./configuration.md#cleaning-up-the-output) rather than left open.

Return the programme, a different one, or `null`/`undefined` to leave it out.
Build a new object rather than changing the one handed in: it may be a cache
store's own, and a memory-backed store hands out the same object every read.

### Building programmes

`parseDay` hands you `programme`, the [XMLTV builder](./xmltv.md#builders) with
the parts a parse should not have to repeat already filled in — the channel is
the one being parsed, and every text element defaults to its `lang`:

```ts
channels: [{ xmltvId: 'one.example.tv', siteId: '101', lang: 'sk' }],
parseDay({ payload, programme }) {
  return payload.items.map((item) => programme(new Date(item.start), item.title)
    .stop(new Date(item.end))
    .desc(item.summary)             // lang: 'sk', because the channel said so
    .category(item.genre)
    .episode(item.episode, item.season)
    .video({ quality: 'HDTV' })
    .rating(item.rating, { system: 'SK' }));
}
```

Hand the builders back as they are, or a plain `XmltvProgramme` object, or any
mix of the two — `parseDay` takes all three, and calls `.build()` for you.
`programme.channel` is normalized to the channel's `xmltvId` either way, so a
plain object need not repeat it.

The channel's `lang` is only a *default*: pass a language to any text method
(`.desc(value, 'en')`) and that element carries it instead, for a programme
that is not in the channel's usual language.

`programme(start, title, options?)` takes the two required fields positionally
and the rest of `ProgrammeBuilderBase` in `options`. `start` is a `DateInput`:
a `Date`, unix **seconds**, or an XMLTV datetime string. A bare ISO timestamp
out of a JSON API is none of those and **throws `XmltvDateError`** — it goes in
as `new Date(item.start)`, exactly as it would in a plain object.

The whole builder is available, so the provider extensions the parser preserves
can be written back out the same way: `.extra()` for non-DTD child elements,
`.extraAttributes()` for attributes, and the trailing `extraAttributes`
argument on every element method.

### The `<channel>` element

`channelInfo` builds the `<channel>` element for one channel. Left out, the
default emits id, display name and logo.

Its second argument, `element`, is that default **as a builder** — the id, a
display name (the channel's `name`, or its id) and its `logo` as an icon, with
text elements defaulting to the channel's `lang`. So describing a channel more
fully is a matter of adding to it rather than restating it:

```ts
// Display names in every language the source had, and the channel number as
// an extension tvheadend can pick up.
channelInfo({ data }, element) {
  return element()
    .displayName(data.callSign)
    .url(data.page)
    .extra({ name: 'lcn', value: String(data.lcn) });
}
```

Pass a display name to `element(name)` to use it instead of the default one;
further `.displayName()` calls **add** to it rather than replacing it, which is
how a channel carries a second language or a call sign. Hand back the builder
or a plain `XmltvChannel`, whichever suits — `element` is a second parameter
rather than part of a context object, so a one-argument `channelInfo(channel)`
that builds the object itself goes on working untouched.

Everything that emits a `<channel>` goes through this — the merge and the
grabber's `--list-channels` — so a channel is described identically wherever it
turns up.

### Saying something

Every context — `channels`, `request`, `parseDay`, `stream` — carries `log` and
`warn`. They take one line each and the site's name is added for you, so say
what happened rather than who it happened to:

```ts
const example = defineSiteConfig({
  site: 'example.tv',
  async request({ channel, day, http, log }) {
    log(`asking for ${channel.siteId}`);

    return http.get(`epg/${channel.siteId}/${day}`).json();
  },
  parseDay({ payload, programme, warn }) {
    return payload.items.flatMap((item) => {
      if (item.start === undefined) {
        warn(`skipped an item with no start time`);

        return [];
      }

      return programme(new Date(item.start), item.title);
    });
  },
});
```

The difference between them is what survives a run asked to be quiet:

| | shown at | for |
|---|---|---|
| `log` | the run's default verbosity | progress — what is being asked for, what came back |
| `warn` | always, down to errors only | a signal — the source has changed shape, something was skipped |

Neither is `console.log`, and that is the point: there is no `console` call
anywhere in this package, because a `tv_grab_*` writes its guide to stdout and
one stray line in the middle of it is a broken document. Both of these go
wherever the run's own messages go, which the caller chose — a
[reporter](./api.md#reporting-what-a-run-is-doing), a file, `--quiet`, or
nothing at all.

## Batching: how much one request covers

A site has one `request`, and `batching` says how much of the channel × day
grid a single call to it covers. There is always exactly one `parseDay` per
channel-day, handed the shared response, so only `request` changes shape:

| `batching` | one request covers | the context carries |
| --- | --- | --- |
| omitted / `'none'` | one channel, one day | `channel`, `day`, `date` |
| `'channels'` | one day, many channels | `channels`, `day`, `date` |
| `'days'` | one channel, many days | `channel`, `days`, `dates`, `from`, `to` |
| `'both'` | many channels, many days | `channels`, `days`, `dates`, `from`, `to` |

Every mode also gets `channelDays` — the channel-days the request is *for*,
each with its `channel`, `day` and `date`, which is what a source taking an
explicit list of pairs wants:

```ts
async request({ channelDays, http }) {
  return http.post('epg', {
    json: { queries: channelDays.map(({ channel, day }) => ({ id: channel.siteId, day })) },
  }).json<Raw>();
},
```

Sources that return many channels' schedules in one call
(`?channels=a,b,c&date=…`) want `'channels'`:

```ts
const example = defineSiteConfig({
  site: 'example.tv',
  channels: [/* … */],
  batching: { mode: 'channels', channelsPerRequest: 50 }, // cap optional; omit for one request
  async request({ channels, date, http }) {
    return http.get('epg', {
      searchParams: { ids: channels.map((c) => c.siteId).join(','), date: date.toISOString() },
    }).json<{ items: { channelId: string; programmes: RawProgramme[] }[] }>();
  },
  parseDay({ payload, channel }) {
    const item = payload.items.find((i) => i.channelId === channel.siteId);
    return item ? item.programmes.map(/* … */) : [];
  },
});
```

Sources that serve a date *range* for one channel (`?id=a&from=…&to=…`) want
`'days'` — `from`/`to` are the first and last day of the request, and `days`
names every day it is expected to yield:

```ts
const example = defineSiteConfig({
  site: 'example.tv',
  channels: [/* … */],
  batching: { mode: 'days', daysPerRequest: 7 }, // cap optional; omit for the whole window
  async request({ channel, from, to, http }) {
    return http.get('epg', {
      searchParams: { id: channel.siteId, from: from.toISOString(), to: to.toISOString() },
    }).json<{ items: { day: string; programmes: RawProgramme[] }[] }>();
  },
  parseDay({ payload, day }) {
    const item = payload.items.find((i) => i.day === day);
    return item ? item.programmes.map(/* … */) : [];
  },
});
```

`'both'` combines the two, taking both caps, for an API that serves a set of
channels over a range of days in one call. It is also the one mode where
`channelDays` is narrower than `channels × days`: a rectangle can catch a
channel-day that was already fresh, so `channels` and `days` are what the
request *covers* while `channelDays` is what it is *for*.

The bare string form (`batching: 'days'`) is the same thing with no caps. Each
mode accepts only the caps it can use — `daysPerRequest` under `'channels'` is
a type error rather than a number that is silently ignored — and the context is
typed from the mode, so a `'days'` site destructuring `day` does not compile.

Caching stays per channel-day whatever the mode, so a run only ever asks for
the channel-days that are missing or stale: fresh ones are dropped before the
grid is cut into requests, which is why a `'days'` request's `days` can have
gaps in it (`from`/`to` still span them). `concurrency` and `rateLimit`
throttle whole requests. Batching both axes at once is the one case where a
request can span a channel-day that was already fresh — narrow the query with
`channelDays`, or answer the whole rectangle and let the extra be ignored: a
fresh channel-day is neither parsed nor rewritten either way.

## Asking only when it is worth it

A stale channel-day is not a missing one: it is usually there and merely old
enough to ask about again. `conditionalGet` asks *whether* rather than *for*,
and the site writes no code for it:

```ts
const example = defineSiteConfig({
  site: 'example.tv',
  conditionalGet: true,
  async request({ channel, day, http }) {
    return http.get(`epg/${channel.siteId}/${day}`).json(); // unchanged
  },
  // …
});
```

Two hooks go into the site's own client. One sends `If-None-Match` or
`If-Modified-Since`; the other turns a `304` into an `UnchangedError`, which
reaches out of `request` — or `stream` — without either of them mentioning it,
and tells the run to keep every channel-day that request was for. They are
counted in `unchanged` rather than `fetched`, nothing is written, and `grabbedAt`
is left where it was, so the next run asks the same cheap question:

```
Grab done: 0 fetched, 0 from cache, 3 unchanged, 0 failed
```

What it asks with, in order: an `ETag` the source gave last time, then a
`Last-Modified`, then — with neither stored — the **`grabbedAt` of the entries
themselves**, which is a fair thing to ask "has it changed since?" with and needs
nothing remembered at all. Whatever a source answers with is kept in the cache
[beside the listings](./api.md#what-a-site-remembers-between-runs) and is dropped
when the channel-days it covered leave the window.

**A validator is never sent where a 304 could not be honoured**, and each of
those is a way one could do damage:

| the run refuses when | because a 304 would otherwise |
|---|---|
| a channel-day this request covers has nothing cached | leave a hole in the guide, silently |
| one is past `maxAgeDays` | let a source with a lying `Last-Modified` freeze the guide for good rather than for a week |
| the run is `--refresh` | be the opposite of what the flag asks for |

The first of those has a consequence worth knowing in advance: **a window that
has rolled onto a new day asks outright.** Run daily and the last day of the
window is one nothing is cached for, so the request covering it cannot honour a
304 — which for a [whole-document source](#a-published-guide-as-a-source) means
the document is downloaded. What `conditionalGet` saves is every *other* run:
the second and third grab of the same day, a `build` after a `grab`, a retry
after a failure. Run it every few hours, as a guide that changes once a day
deserves, and all but one of those runs costs a `304`.

**Off by default, and worth understanding before turning it on.** It makes any
304 from any request inside `request` mean "nothing changed for these
channel-days" — true of a source whose channel-day comes from one request, wrong
for one that pages through several. Send `context: { revalidate: false }` with a
request that should never be asked conditionally:

```ts
async request({ channel, day, http }) {
  const index = await http.get(`epg/${channel.siteId}/${day}`).json<Index>();
  const pages = await Promise.all(
    index.pages.map((page) =>
      // A 304 here would say nothing about the channel-day as a whole.
      http.get(page, { context: { revalidate: false } }).json<Page>()),
  );

  return { index, pages };
}
```

A request made from inside `parseDay` is never revalidated at all: a 304 on a
detail page cannot mean "keep this channel-day" when the channel-day itself was
just refetched.

A site doing its own revalidating can `throw new UnchangedError()` and get the
same treatment — which is also how a [streaming site](#sites-that-answer-in-one-pass)
says a whole document is unchanged.

## A published guide as a source

Someone else's `xmltv.xml.gz` is a source with no site config to write — the
format is the one this package already parses, and the only questions are where
it is and which of its channels you want:

```ts
import { defineConfig, defineXmltvSite } from 'epg-tools';

export default defineConfig({
  sites: [defineXmltvSite({ site: 'published.example', url: 'https://example.test/guide.xml.gz' })],
  output: 'guide.xml',
});
```

That is the whole of it. The document is **streamed** through the parser and
**split** by channel-day, so its entries merge with any other site's and the
guide is never held whole: 43 MiB of XML — 1,000 channels over a week, 7,000
channel-days — grabs under a **40 MiB heap**, where parsing the same document to
split it afterwards needs **192 MiB**. The first number stays put as a guide
grows; the second follows it. Its **channels come from its own head**: the DTD puts every
`<channel>` before the first `<programme>`, so the list is read and the download
stopped there, and each channel's element is kept and written back out whole —
every display name, icon and url, not just the three fields a default `<channel>`
holds. On later runs it [asks whether anything has
changed](#asking-only-when-it-is-worth-it), so an unchanged guide is a `304`
rather than a download.

| option | default | what it is |
|---|---|---|
| `url` | **required** | Where the document is. |
| `channels` | every channel the document declares | The channels to take, mapping `siteId` (its `<channel id>`) to the id you want out. A list narrows *and* renames. |
| `dayZone` | `'source'` | Which day a programme belongs to: the day it falls on in the offset the document wrote it with (`source`), the day of its UTC instant (`utc`), or the day in a named zone (`Europe/Bratislava`). |
| `compression` | sniffed | `'gzip'`, `'brotli'`, `'zstd'`, or `false` for none. |
| `parse` | — | `XmltvParseOptions`: `timezones` for a document using named zones, `tolerateMissingId`. |
| `order` | `'grouped'` | Whether the document groups each channel's programmes together — see below. |

Everything a site config takes is taken here too: `days`, `staleness`,
`concurrency`, `rateLimit`, `backoff`, `ky`, `transform`, `channelInfo`, and both
`cacheChannels` and `conditionalGet`, which are **on by default** here because a
published guide is one file that changes at most daily.

**Compression is sniffed, not asked about.** `Content-Encoding` says what the
origin claimed rather than what the bytes are: `fetch` decodes gzip, `br` and
`zstd` before this ever sees them and leaves the header on, and does *not* decode
a coding it does not know — so its presence and its absence are equally
uninformative. A `.gz` name is no better, since servers serve `.gz` files as
`Content-Encoding: gzip` and hand over plain XML. A magic number is a fact.
Brotli has none, so a brotli document is the one that must be named — by
`compression: 'brotli'`, a `.br` url, or an `application/x-brotli` type — and
anything else unreadable is an error rather than a guess.

**If a document is not grouped by channel**, which the DTD allows and some
publishers do, it is noticed at the first channel that comes round again: the
rest is held to the end and nothing is lost, with a line in the log saying so.
`order: 'any'` starts held, for a source known to be ordered by time — no
warning, no second write, and the whole document in memory while it parses.

## Sites that answer in one pass

Some sources publish the lot in one document — a `xmltv.xml.gz`, a dump behind
one endpoint. Batching says how much of the grid one request covers, and for
these the answer is "all of it", which `request` cannot express: `parseDay` is
only called once the request has returned, so the whole window would have to be
in memory before the first entry could be written.

Such a site defines `stream` **instead of** `request` and `parseDay`, and says
what it found as it goes:

```ts
const published = defineStreamSiteConfig({
  site: 'published.example',
  channels: [/* … */],
  async *stream({ channelDays, http, log }) {
    const byChannel = new Map(channelDays.map(({ channel, day }) => [`${channel.siteId}|${day}`, channel]));
    const response = await http.get('guide.xml');

    for await (const { channel, day, programmes } of splitByChannelDay(response, log)) {
      const known = byChannel.get(`${channel}|${day}`);

      if (known) {
        yield { channel: known, day, programmes };
      }
    }
  },
});
```

It is called **once per run**, with every stale channel-day of the site in
`channelDays` — the same context a `'both'`-batched request gets, which includes
the [`log` and `warn`](#saying-something) a pass through a document has plenty of
use for: a warning from the parser, a channel the list did not mention. Nothing
waits for the pass to finish before the first
channel-day it yields is written, and the writing holds the split back rather
than the other way round, so memory stays flat however large the document is.

What the grab does with each channel-day:

| the channel-day is | what happens |
|---|---|
| one it **asked** for | written, counted and logged, exactly as a parsed one is |
| one it did **not** ask for — already fresh, or a channel nobody asked about | ignored, and counted in one line at the end |
| yielded **again** | added to what the earlier emission wrote, so a document that is not grouped by channel costs a second write rather than the programmes it already reported |
| yielded as `{ channel, day, unchanged: true }` | left exactly as it is — see [asking only when it is worth it](#asking-only-when-it-is-worth-it). Counted in `unchanged`; a channel-day with nothing cached cannot be kept and is reported as a failure |
| **never** yielded, after a clean end | written **empty** — the source went through its whole answer and had nothing to say, which is what `parseDay` returning `[]` means too |

That last row is the one to design around: **a stream that cannot finish must
throw.** Ending quietly is read as "that was the whole answer", so a download cut
off half way would cache "nothing on" for every channel-day it never reached.
Throwing fails exactly those and writes nothing — which, for anything built on
Node streams, means being careful that a broken pipe surfaces as a rejection
rather than as an end of iteration.

Everything else about a site is the same: `channels`, `cacheChannels`,
`concurrency`, `rateLimit`, `backoff`, `ky`, `staleness`, `transform`,
`channelInfo` and `state` all mean what they mean anywhere else, and caching
stays per channel-day, so a run still only asks about what is missing or stale.
A site cannot do both — `stream` is what makes it this shape.

## HTTP settings and proxies

Everything that shapes a request belongs to the site, not the run: each site
gets its **own** `ky` instance built from its `ky` options, its own request
queue (`concurrency`, `rateLimit`), and its own `days`, `staleness` and
`batching`. Nothing is shared, so sites with different rate limits,
credentials or hosts coexist in one process — you do not need a process per
site to keep their settings apart, and since the config is TypeScript, per-site
environment variables are just code:

```ts
ky: { prefix: 'https://api.a.example.tv', headers: { 'x-api-key': process.env.A_KEY! } },
```

That instance is what `request` receives as `http`, and the run's abort signal
is baked into it — anything asked for through it is abortable whether or not a
site remembered to pass the signal on.

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

## Rate limits and backoff

`concurrency` says how many requests a site may have in flight — and, with
that, how many responses it holds while parsing them; `rateLimit` says how
often it may send them, in the terms the source itself states:

```ts
rateLimit: { requests: 20, perMs: 60_000 },   // 20 a minute
rateLimit: { requests: 1, perMs: 250 },       // or plain spacing: one a quarter second
```

The window **slides** (`strict: false` for the cheaper fixed one). That matters
more than it sounds: a fixed window lets the full allowance go out at the end of
one window and again at the start of the next — up to twice the rate over the
interval the source is actually counting, which is how a config that looks
compliant still earns a `429`. At one request per window the two are the same
thing, so it costs nothing to leave on.

And when one arrives anyway, the whole site stops:

```ts
backoff: { statuses: [429, 503], fallbackMs: 5_000, maxMs: 60_000, adapt: true },  // the defaults
```

A `429` is news about the site, not about the one request that got it — every
other request queued behind it is just as unwelcome. So the site's request queue
is **paused** for as long as `Retry-After` asks (delta-seconds or an HTTP date,
capped by `maxMs`, `fallbackMs` when the header says nothing), and then resumes
**with its tasks intact**: nothing is dropped, nothing is refetched, the channel
days waiting their turn simply wait a little longer. Requests already in flight
are left alone, and `ky`'s own per-request retry then does its usual job on top.

`adapt` also halves the site's `concurrency` on a slow-down and gives it back
one clean response at a time, ten in a row per step — a retreat that is quicker
than the recovery. At the default concurrency of 1 there is nothing to halve, so
it only does anything for a site configured to run several requests at once.

A cancelled run reaches all of this: what is in flight aborts through the client
it went out on, what is queued is dropped, and a rate-limit hold is abandoned
rather than waited out. A site's own code is the one part that has to help — the
`signal` on both contexts is there to be passed to whatever it waits on.

All of it applies to **every** request a site makes through the queue, not just
the planned ones: the fetch of a channel list that has to be fetched, and a
follow-up request a parse makes with
[`paced`](#a-parse-that-needs-another-request). A queue task is one request and
nothing more — parsing and writing hold no slot — which is what lets a parse
ask for one while the response it is parsing has already let its own go.
Pass `backoff: false` to leave the whole business to `ky`.

Both are per site, like everything else here: one source's rate limit never
paces another's, and one source's `429` never stops another's queue.

---

[← README](../README.md) · [Configuration & CLI](./configuration.md) · [XMLTV parser](./xmltv.md) · [XMLTV grabber](./tv-grab.md) · [Programmatic API](./api.md)

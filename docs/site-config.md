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

- [Reference](#reference)
- [Channels](#channels)
  - [A channel list that has to be fetched](#a-channel-list-that-has-to-be-fetched)
- [Requests and parsing](#requests-and-parsing)
  - [Building programmes](#building-programmes)
  - [The `<channel>` element](#the-channel-element)
- [Batching](#batching-how-much-one-request-covers)
- [HTTP settings and proxies](#http-settings-and-proxies)
- [Rate limits and backoff](#rate-limits-and-backoff)

## Reference

| field | type | default | what it is |
|---|---|---|---|
| `site` | `string` | **required** | Unique site identifier, e.g. `webtv.sk`. Used as the cache namespace. |
| `channels` | `GrabberChannel[]` or `(ctx) => GrabberChannel[] \| Promise<…>` | **required** | The channels to grab, written out or [fetched](#a-channel-list-that-has-to-be-fetched). |
| `request` | `(ctx) => Promise<TRaw>` | **required** | Fetch one request's raw data. The context's shape comes from `batching`. |
| `parseDay` | `(ctx) => ParsedProgramme[] \| Promise<…>` | **required** | Turn part of a response into one channel-day's programmes. Called once per channel-day. May return builders, plain objects, or a mix. |
| `channelInfo` | `(channel, element) => XmltvChannel \| ChannelBuilder` | `defaultChannelInfo` — id, display name and logo | Build the `<channel>` element for a channel. |
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

A failed `request` fails every channel-day it covered; one channel-day's
`parseDay` error only drops that channel-day.

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

`concurrency` says how many requests a site may have in flight; `rateLimit`
says how often it may send them, in the terms the source itself states:

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
Pass `backoff: false` to leave the whole business to `ky`.

Both are per site, like everything else here: one source's rate limit never
paces another's, and one source's `429` never stops another's queue.

---

[← README](../README.md) · [Configuration & CLI](./configuration.md) · [XMLTV parser](./xmltv.md) · [XMLTV grabber](./tv-grab.md) · [Programmatic API](./api.md)

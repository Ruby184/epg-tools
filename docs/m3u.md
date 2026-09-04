# M3U playlists

`epg-tools/m3u` reads and writes the M3U playlists the IPTV world uses to
exchange channel lists. It is a standalone entry point with no dependencies —
importing it loads nothing else in the package — and it streams, which nothing
else in the ecosystem does.

```ts
import { parseM3uFile, parseM3uString, writeM3uToFile } from 'epg-tools/m3u';
```

- [Why this exists](#why-this-exists)
- [Parsing](#parsing)
- [The model](#the-model)
- [Where the display name begins](#where-the-display-name-begins)
  - [Conventions kept but not interpreted](#conventions-kept-but-not-interpreted)
- [Warnings](#warnings)
- [Serializing](#serializing)
- [Reading a playlist you did not write](#reading-a-playlist-you-did-not-write)
- [Node streams](#node-streams)
- [Reading it as something other than IPTV](#reading-it-as-something-other-than-iptv)
- [A playlist as a site's channel list](#a-playlist-as-a-sites-channel-list)
- [A playlist as a whole source](#a-playlist-as-a-whole-source)
- [Benchmarks](#benchmarks)

## Why this exists

Every other M3U parser takes the whole playlist as a string. A public IPTV index
is megabytes of it — [iptv-org's `index.m3u`][iptv-org] is 2.7 MB and 12,946
entries — and holding the document *and* the model at once is the difference
between **0.9 MiB** of peak heap and 55–82 MiB, [measured](#benchmarks) on a
20 MB one.

Half of this format is specified and half is convention, which is most of what
the design is about. The container is [RFC 8216][rfc8216] (HLS): `#EXTM3U` first,
`#EXTINF:<duration>,<title>` where "the remainder of the line following the
comma" is the title, blank lines ignored, every other `#` line a comment. The
IPTV layer on top — `tvg-id`, `group-title`, a user agent, a Kodi property — is
convention, and it breaks the RFC in two specific ways: the RFC puts *nothing*
between the duration and the comma, and requires attribute names to be uppercase.
The closest thing to a normative document for that layer is the
[Kodi IPTV Simple Client README][kodi].

So a parser cannot be written to the specification alone, only to its shape —
and the shape is read here **losslessly**: attributes as they were spelled, in
the order they were written, unrecognized directives kept whole. Parse a
playlist, write it back, and you get the same bytes.

## Parsing

Four entry points, all over the same scanner, differing only in how bytes
arrive:

| | |
|---|---|
| `parseM3uStream(source, options?)` | async generator of events over any iterable of string/byte chunks |
| `parseM3uFile(path, options?)` | the same, reading a file (512 KiB buffer) |
| `parseM3uString(text, options?)` | the whole playlist at once, synchronously → `M3uPlaylist` |
| `M3uParseStream` | a Node `Transform` for `stream.pipeline()` |

The streaming forms yield tagged events and never hold more than one entry:

```ts
for await (const event of parseM3uFile('index.m3u')) {
  if (event.type === 'entry') {
    console.log(event.value.name, event.value.url);
  } else if (event.type === 'warning') {
    console.warn(`line ${event.value.line}: ${event.value.message}`);
  }
}
```

`parseM3uString` is the call-it-and-get-a-result form, and is the *faster* of
the two on a playlist that fits in memory — it does no chunk copying:

```ts
const { header, entries, warnings } = parseM3uString(text);
```

Options:

| option | default | |
|---|---|---|
| `keepUnknownDirectives` | `true` | keep `#` lines the format does not define, rather than dropping them |
| `maxLineLength` | 1 MiB | the longest line to hold — see [reading a playlist you did not write](#reading-a-playlist-you-did-not-write) |
| `charset` | `'utf-8'` | what the bytes are encoded in (streaming entry points only) |

RFC 8216 says an unrecognized `#` line "SHOULD be ignored", which is right for a
player and wrong for anything that will write the playlist back out — ignoring is
what loses a `#KODIPROP` nobody has heard of. Turn it off for a reader that only
plays.

## The model

```ts
interface M3uEntry {
  url: string;
  name: string;
  duration: number;
  attributes: Map<string, string>;
  directives?: M3uDirective[];
}
```

Nothing here is a named field, deliberately. The alternative — camel-casing a
known subset (`tvgId`, `groupTitle`, …) and bagging the rest — loses the original
spelling, and iptv-org's playlist already carries two attributes that no
documented subset contains: `http-user-agent` (on 665 entries) and
`http-referrer` (on 244). A flat record in source order is the honest model for a
layer with no specification; what the conventional names *mean* is knowledge for
whoever reads the model.

Two things worth knowing about that layer:

- **`group-title` is a semi-colon separated list**, not one group. Same for
  `#EXTGRP`. This is the thing most readers of this format get wrong.
- **A directive splits on its first colon and no further.**
  `#EXTVLCOPT:http-user-agent=Mozilla/5.0 …` has an `=`, spaces and more colons
  inside its value, and every one of them belongs to the value.
- **A directive may sit on either side of its `#EXTINF`.** Kodi and tvheadend
  both accumulate into a pending channel and commit it on the url line, so
  neither can even notice which side it was on — and Kodi has an issue titled
  *"#EXTGRP before #EXTINF breaks the parsing of playlist"*, which says how
  common the leading form is. A directive read before an `#EXTINF` is given to
  the entry that follows it, in document order. Only one the playlist ended
  before any entry could claim is dropped, as `orphan-directive`.

  Note this normalizes line *order* on the way out: the serializer writes
  directives after the `#EXTINF`, so such a playlist round-trips identically in
  model but not byte for byte.

An entry has exactly **one** url, which is what RFC 8216 gives an `#EXTINF` and
what Kodi, tvheadend and `iptv-playlist-parser` all read. A second bare url line
is reported as `orphan-url` rather than attached as a backup stream — see
[Conventions kept but not interpreted](#conventions-kept-but-not-interpreted).

## Where the display name begins

This is the whole difficulty of the format, and implementations do not agree.

A display name may contain a comma, and so may an attribute value —
`http-user-agent="… (KHTML, like Gecko) …"` does, on **628 of iptv-org's 12,946
entries (4.9%)**. The rule used here falls straight out of RFC 8216 §4.2 and is
decidable rather than a heuristic: a quoted string cannot contain a double quote,
so **the name begins after the first comma that is not inside quotes**.

Counting quotes from the left is what makes it decidable, and it is what the
alternatives lack:

| implementation | rule | breaks on |
|---|---|---|
| **`epg-tools/m3u`** | first comma outside quotes | an unescaped `"` *inside* a quoted value, which nothing can parse |
| [tvheadend][tvh-src] | walks the attribute list token by token and stops at the comma that ends it | — (and it accepts `'` quotes too) |
| [`iptv-playlist-parser`][legacy] 0.15.2 | quote-aware | — |
| [Kodi `pvr.iptvsimple`][kodi-src] | last comma, unless one sits just after the line's last quote | a comma in the name of an entry with no quoted attributes; a `"` in the name |
| [`@iptv/playlist`][iptv-playlist] 1.2.1 | first comma | the 4.9% case — see below |
| [`m3u-parser-generator`][generator] 5.0.2 | first comma | the 4.9% case, the same way |

The consequences are not theoretical. Run against the real `index.m3u`:

- `@iptv/playlist` 1.2.1 returns 12,911 of the 12,946 entries, and of those,
  **781 have `name: undefined` and the remainder of the `#EXTINF` line sitting in
  `url`** where the stream address should be.
- `m3u-parser-generator` 5.0.2 returns all 12,946, but **628 of them have the
  rest of the attribute string inside `name`** — exactly the entries that carry a
  comma in a quoted value.
- Kodi's rule handles the 4.9% case but reads `#EXTINF:-1,One HD, the good one`
  as the name `the good one`.

None of this makes those projects careless — the format has no escape mechanism
and no authority, and VLC's own parser for it is named `parseEXTINFIptvDiots`.
It does mean the difference is worth stating beside a speed number.

### Conventions kept but not interpreted

Reading the other implementations turns up conventions this module deliberately
passes through untouched rather than modelling:

- **HTTP headers appended to the url**, as `http://host/path|User-Agent=…&Referer=…`
  — which tvheadend splits out and Kodi understands. The whole line is kept
  verbatim in `url`, so it round-trips exactly; splitting it is the consumer's
  job, since only the consumer knows whether it is talking to a server that
  wants them.
- **Single-quoted attribute values.** tvheadend accepts `key='value'` as well as
  `key="value"`. Not read here: RFC 8216 has no such form, **zero of iptv-org's
  12,946 entries use it**, and teaching the quote-counting rule about `'` would
  put every apostrophe in a channel name on the wrong side of a boundary. A
  single-quoted value reads back as an unquoted one, ending at the first space.
- **Backup streams.** There is no accepted way to give a channel a fallback url.
  The two proposals in circulation — [pipe-separated urls and an `#EXTBACKUP`
  tag][dispatcharr] — are open feature requests, and note that the first
  collides with the header convention above. A second bare url line is not one
  of them: Kodi, tvheadend and `iptv-playlist-parser` all take the first url and
  move on, iptv-org's playlist never does it, and the only parser that collects
  them (`@iptv/playlist`, into a `urls` array its README does not mention) stands
  alone. So a second url line is read here as what it is — a url with no
  `#EXTINF` — and reported.

## Warnings

Parsing never throws on malformed input and never stops. Problems are reported
as `warning` events (or collected in `M3uPlaylist.warnings`), each anchored to a
1-based `line` and `col`:

| code | when |
|---|---|
| `missing-header` | the playlist does not open with `#EXTM3U` |
| `incomplete-entry` | an `#EXTINF` reached the next one, or the end, with no url |
| `orphan-url` | a url with no `#EXTINF` before it |
| `orphan-directive` | a `#` line the playlist ended before any `#EXTINF` could claim |
| `line-too-long` | a line ran past `maxLineLength`; it is dropped and scanning resumes after it |
| `invalid-duration` | the duration was not a number; the entry is kept with `-1` |
| `malformed-attributes` | a quote was opened and never closed, or an `#EXTINF` had no comma |

An entry that never got a url is **kept**, not dropped — most readers of a
playlist want the channel list rather than the streams, and a metadata line with
nothing to play is still a channel. Its `url` is empty and the warning is what
says so.

`orphan-directive` is the one case this module cannot round-trip, which is
exactly why it is reported rather than passed over in silence.

### Attribute names, and a third-party url

The names on an `#EXTINF` line come from someone else's server and go straight
in as keys, so **attributes are a `Map`** rather than an object. Three things
follow:

- **`__proto__` is an ordinary attribute.** On a plain object it is not:
  assigning it is diverted to the prototype accessor, creating no property, so
  the attribute would disappear with nothing said. It cannot *pollute* anything
  — the accessor ignores a string, and these values are always strings — but
  this module's rule is losslessness, and silently losing an attribute breaks it.
- **A name the playlist never carried reads back `undefined`**, not an inherited
  `valueOf`. A declared `Record<string, string>` would be a lie for any code
  doing `attributes[someKey]`.
- It is **quicker**, measurably, both to fill while parsing and to write back
  out.

The cost is one thing worth knowing: **a `Map` is `{}` under
`JSON.stringify`**. To store or log an entry, convert first —
`Object.fromEntries(entry.attributes)` — which is exactly what
[`channelsFromM3u`](#a-playlist-as-a-sites-channel-list) does on the way to a
channel, since a cached channel list is stored as JSON.

For comparison, on the same input:

| | `__proto__="v"` | `_foo="v"` |
|---|---|---|
| **`epg-tools/m3u`** | kept, and round-trips | kept as `_foo` |
| `@iptv/playlist` 1.2.1 | kept as **`proto__`** | kept as **`foo`** |
| `m3u-parser-generator` 5.0.2 | dropped | kept as `_foo` |
| `iptv-playlist-parser` 0.15.2 | never exposed — it models a fixed subset only | never exposed |

`@iptv/playlist` strips leading underscores from every attribute name, so it
does not lose the attribute so much as file it under a different one. None of
the three pollutes `Object.prototype`.

## Reading a playlist you did not write

A playlist is nearly always fetched from a url someone else controls, and two
things follow from that.

**A line is held until its newline arrives** — that is what lets a chunk fall
anywhere — so a response of megabytes with *no* newline in it would grow the
buffer without limit. `maxLineLength` bounds it: over the bound the line is
dropped with a `line-too-long` warning and scanning resumes at the next
newline, so a broken endpoint costs one line rather than the process. Measured
on a 200 MB body with no newline, reading the entry that follows it either way:

| | peak heap |
|---|---|
| `maxLineLength: Infinity` | 200.2 MiB |
| the 1 MiB default | **1.0 MiB** |

The default is unreachable by anything real — the longest line in iptv-org's
26,803 is 1,184 characters, roughly 885× under it — and it is a property of the
*line*, not of how the bytes were chunked, so the same playlist reads the same
whatever the chunk size.

**There is no encoding declaration** anywhere in this format, so a provider
writing `windows-1251` produces a file that is not valid UTF-8 and whose every
channel name comes back as replacement characters. Say so with `charset`, as
tvheadend does:

```ts
parseM3uFile('list.m3u', { charset: 'windows-1251' });
```

`M3uCharset` names the encodings these playlists are actually found in so they
autocomplete and a typo is a compile error, and still accepts any other label
`TextDecoder` takes — including aliases like `cp1251` and `latin1`. An unknown
one throws where you gave it rather than quietly falling back to UTF-8.

## Serializing

```ts
serializeM3uHeader(header?, options?): string   // the #EXTM3U line
serializeM3uEntry(entry, options?): string      // #EXTINF, directives, url
writeM3uStream(input, options?): AsyncGenerator<string>
writeM3uToFile(path, input, options?): Promise<void>
```

| option | default | |
|---|---|---|
| `eol` | `'\n'` | `'\r\n'` for the set-top boxes and Windows players most playlists are read by — and what iptv-org writes |
| `highWaterMark` | Node's stream default | how much `writeM3uStream` accumulates before yielding a chunk |
| `signal` | — | checked between entries, the granularity a playlist has |

```ts
await writeM3uToFile('channels.m3u', {
  header: { attributes: new Map([['x-tvg-url', 'https://example.com/guide.xml']]) },
  entries: channels.map((channel) => ({
    url: channel.streamUrl,
    name: channel.name,
    duration: -1,
    attributes: new Map([
      ['tvg-id', channel.xmltvId],
      ['group-title', 'News'],
    ]),
  })),
}, { eol: '\r\n' });
```

Values are always written quoted, even one that arrived unquoted: a quoted value
is what every reader expects and the only form that survives a space. So what
round-trips is the **model** — parse, serialize, parse again, and the entries are
identical.

Anything that could not be read back as what it was is **refused rather than
written**, the way `serializeProcessingInstruction` refuses a `?>`. This format
has no escape (RFC 8216 §4.2 gives quoted strings none), so a `"` in a value or a
line break anywhere produces a line that parses as something else entirely, and
`serializeM3uEntry` throws a `TypeError` instead.

## Node streams

`M3uParseStream` and `M3uSerializeStream` are the `Transform` counterparts, and
consume exactly the events the other emits — so a `parse → serialize` pipeline
round-trips:

```ts
await pipeline(
  createReadStream('in.m3u'),
  new M3uParseStream(),
  new M3uSerializeStream({ eol: '\r\n' }),
  createWriteStream('out.m3u'),
);
```

A `warning` event has no place in the output, so `M3uSerializeStream` re-emits it
as a `'warning'` event on itself (`stream.on('warning', …)`), exactly as
`XmltvSerializeStream` does.

Its `header` option takes preference over a `header` event on the stream, so a
passed-through playlist can be pointed at a different guide while keeping
everything else it carried:

```ts
new M3uSerializeStream({ header: { attributes: new Map([['x-tvg-url', ours]]) } })
```

## Reading it as something other than IPTV

The module is two layers, and the seam between them is public.

**`M3uScanner` is purely lexical.** RFC 8216 §4.1 is its whole brief — "each
line is a URI, is blank, or starts with the character `#`" — so it splits lines,
drops the carriage return of a CRLF playlist, skips blanks, enforces
`maxLineLength`, splits a tag from its value, and hands each remaining line to a
handler. It reports exactly the two things the RFC requires of *any* playlist:
a line too long to hold, and a playlist that does not open with `#EXTM3U`
(§4.3.1.1, "the first line of every Media Playlist and every Master Playlist").

**`M3uIptvReader` is one handler**, and it holds every convention this document
has described: that `#EXTINF` opens a channel, that the url below closes it,
that a `#` line describes the channel beside it. None of that is in the RFC.

So another dialect is another handler:

```ts
interface M3uTokens<TEvent> {
  tag(tag: M3uTag): void;                 // a `#` line, split into name and value
  uri(text: string, line: number): void;  // by §4.1, everything else
  warn(warning: M3uWarning): void;        // a line too long, or no #EXTM3U
  end(): void;                            // report whatever is unfinished
  readonly events: TEvent[];              // drained by the scanner, per line
}
```

An HLS media playlist is the case that needs one. RFC 8216 scopes its tags three
ways — `EXT-X-TARGETDURATION` covers the document, `EXT-X-BYTERANGE` only the
next segment, `EXT-X-KEY` and `EXT-X-MAP` every segment until the next one — and
none of that is decidable without knowing the tags. A handler that does know
them is short, and gets CRLF, the BOM, blank lines, the line bound, `charset`
and the `#EXTM3U` check for nothing:

```ts
class HlsReader implements M3uTokens<never> {
  readonly events = [];
  tag(tag) {
    if (tag.name === 'EXT-X-TARGETDURATION') this.playlist.targetDuration = Number(tag.value);
    // …applies until the next one, so it is simply kept:
    else if (tag.name === 'EXT-X-KEY') this.key = tag.attributes({ separator: ',' });
  }
  uri(text) { this.playlist.segments.push({ uri: text, key: this.key }); }
  warn(warning) { /* … */ }
  end() { /* EXT-X-TARGETDURATION is REQUIRED — report if it never came */ }
}

for (const _ of new M3uScanner(new HlsReader()).consume(text, true)) {}
```

`events` is what the scanner drains after **each line**, which is what keeps a
playlist streaming line by line however large a chunk arrives. A handler that
assembles a whole document rather than emitting as it goes — the one above —
leaves it empty.

### Why a tag's value arrives unparsed

`M3uTag` carries the `name`, the `value`, the `line` and the `col` where the
value starts. Reading the value as an attribute list is `tag.attributes()`, and
it is the *only* way to read one — deliberately, because which grammar applies
is a property of the tag and only a handler knows the tag:

| | |
|---|---|
| `EXT-X-KEY:METHOD=AES-128,URI="k.bin"` | an attribute list, comma-separated (§4.2) |
| `EXTINF:-1 tvg-id="a",Name` | an attribute list, space-separated, behind a duration |
| `EXT-X-TARGETDURATION:10` | a bare number |
| `EXTVLCOPT:http-user-agent=Mozilla/5.0 … (KHTML, like Gecko) …` | one key and free text, commas and all |

That last shape is **628 of the 909 directives** in iptv-org's playlist, so a
scanner that guessed at a grammar would be wrong most of the time it tried.

```ts
tag.attributes({ separator: ',' })          // the RFC 8216 §4.2 grammar
tag.attributes()                            // the space-separated IPTV one
tag.attributes({ from, to })                // only a slice of the value
tag.attributes({ onUnterminated: (at) => … }) // told about a quote left open
```

Values come back as strings. §4.2 defines seven value types, but which one an
attribute has is also a property of the tag.

## A playlist as a site's channel list

`channelsFromM3u` lives in `epg-tools/grabber`, not in this module — the M3U
module imports nothing outside itself:

```ts
import { channelsFromM3u } from 'epg-tools/grabber';
import { parseM3uFile } from 'epg-tools/m3u';

channels: () => channelsFromM3u(parseM3uFile('./channels.m3u')),
```

It takes what the parser produces — events or an `M3uPlaylist` — rather than a
path or a string, so there is no guessing which a string was.

The mapping is the conventional one: `tvg-id` → `xmltvId` **and** `siteId`,
`tvg-name` (falling back to the display name) → `name`, `tvg-logo` → `logo`,
`tvg-chno` → `preset`, `tvg-language` → `lang`. Everything else is kept in
`data`: the url, the groups, the full attribute set and any directives. The
attributes arrive here as a plain object rather than the entry's `Map`, because
this is what gets cached and a cache stores it as JSON.

**Groups come from both places a playlist can put them** — `group-title` on the
`#EXTINF` and `#EXTGRP`, each split on `;` because both are *lists*. `#EXTGRP`
is a **begin directive**: Kodi sets the group from one and deliberately does not
clear it after each entry, so a single line groups every entry that follows
until the next one, and `data.groups` reflects that.

**Relative stream urls resolve** against the playlist's own url when you pass
`base` (`defineM3uSite` passes it for you), the way tvheadend resolves them — a
channel list holding `stream/a.m3u8` is of no use downstream. Without a `base`,
or for anything that is not a url, the value is kept exactly as written.

**Check what it skips.** An entry with no `tvg-id` cannot become a channel, and
**1,948 of iptv-org's 12,946 entries (15%) have none**:

```ts
channelsFromM3u(parseM3uFile('./channels.m3u'), {
  // The usual repair, at the risk of two channels sharing a name.
  id: (entry) => entry.attributes['tvg-id'] || entry.name,
  onSkipped: (entry, reason) => console.warn(`skipped ${entry.name}: ${reason}`),
});
```

The reverse direction is deliberately not a helper: only you know what url a
channel has, and once you do, building entries for `writeM3uStream` is three
lines.

## A playlist as a whole source

A playlist carries both halves of a site. Its entries are the channel list, and
its `#EXTM3U` line carries **`x-tvg-url`** — where the XMLTV guide for those
channels is published. So one url is a complete source:

```ts
import { defineM3uSite } from 'epg-tools/grabber';

export default defineConfig({
  sites: [defineM3uSite({ site: 'iptv-org', url: 'https://iptv-org.github.io/iptv/index.m3u' })],
  output: 'guide.xml',
});
```

That is the whole configuration. `defineM3uSite` reads the playlist once, takes
the channels from its entries and the guide url from its header, and hands the
rest to [`defineXmltvSite`](./site-config.md#a-published-guide-as-a-source) —
which streams the guide, splits it by channel-day, and asks whether it changed
on later runs.

The two halves line up because `tvg-id` **is** the guide's `<channel id>`: it
becomes both `siteId` and `xmltvId`, so nothing has to be written down to
connect them. `<channel>` elements in the output are built from what the
*playlist* said — its name and `tvg-logo` — since the playlist is the thing you
chose; pass `channelInfo` to do otherwise.

| option | |
|---|---|
| `url` | where the playlist is (a `.m3u.gz` is sniffed and decompressed like a guide) |
| `channels` | the [`channelsFromM3u` options](#a-playlist-as-a-sites-channel-list) — `id`, `onSkipped`, `onWarning`; `base` is filled in for you |
| `playlist` | how to read the *playlist's* bytes — `charset`, `maxLineLength`. Distinct from `parse`, which is the guide's |
| `guide` | which guide to grab when the header names more than one; the first by default |
| | plus everything `defineXmltvSite` takes — `dayZone`, `parse`, `order`, `compression`, `channelInfo` |

**`x-tvg-url` may be a comma-separated list.** Kodi's source takes the first and
says in a comment that it does not support more than one; here the whole list
reaches `guide` so you can choose:

```ts
defineM3uSite({
  site: 'provider',
  url: 'https://provider.example/playlist.m3u',
  guide: (urls) => urls.find((one) => one.endsWith('.xml.gz')) ?? urls[0]!,
});
```

To grab *all* of them, define one site per guide — that is what the merge is
for, and it keeps each cached and revalidated separately.

`url-tvg` is read as a second spelling of the same thing. A playlist that names
no guide is not an error for `channelsFromM3u` — it is a perfectly good channel
list — but it cannot be a source, and `defineM3uSite` says so when the grab asks
for the guide.

## Benchmarks

`npm run bench` (throughput) and `npm run bench:memory:m3u` (peak heap). Every
comparator takes the whole playlist as a string and returns the whole model, so
the fair speed comparison is against `parseM3uString`.

Over a 2.7 MB, 12,946-entry playlist, rounded because repeat runs on one machine
move each figure by around ±10%:

| | parse | write |
|---|---|---|
| `epg-tools/m3u` | — | — |
| [`m3u-parser-generator`][generator] | ~1.4× slower | ~1.15× slower |
| [`@iptv/playlist`][iptv-playlist] | ~3× slower | — |
| [`iptv-playlist-parser`][legacy] | ~4× slower | — |

Worth saying what the nearest one is doing differently rather than leaving a
number to speak for itself: `m3u-parser-generator` drops every directive it was
not configured to keep (**~6.6% fewer bytes** on the real playlist), mangles the
name of the 628 comma-in-attribute entries, and validates nothing on the way
out. The margin here is small and the work is not the same — this side validates
every name, value, url and directive and emits a byte-identical playlist.

**Memory is where the difference is real**, because it is the one thing none of
them do. Peak heap over a 20.6 MB, 100,000-entry playlist:

| | peak heap |
|---|---|
| `parseM3uFile` (streaming) | **0.9 MiB** |
| `m3u-parser-generator` | 55.0 MiB |
| `parseM3uString` | 68.8 MiB |
| `@iptv/playlist` | 62.5 MiB |
| `iptv-playlist-parser` | 81.9 MiB |

Roughly **65–100× smaller**, and flat as the playlist grows rather than
proportional to it. That, and [where the display name
begins](#where-the-display-name-begins), are the reasons to reach for this one;
the throughput is a bonus rather than the argument.

[iptv-org]: https://iptv-org.github.io/iptv/index.m3u
[rfc8216]: https://www.rfc-editor.org/rfc/rfc8216.html
[kodi]: https://github.com/kodi-pvr/pvr.iptvsimple
[kodi-src]: https://github.com/kodi-pvr/pvr.iptvsimple/blob/Omega/src/iptvsimple/PlaylistLoader.cpp
[iptv-playlist]: https://www.npmjs.com/package/@iptv/playlist
[legacy]: https://www.npmjs.com/package/iptv-playlist-parser
[generator]: https://www.npmjs.com/package/m3u-parser-generator
[tvh-src]: https://github.com/tvheadend/tvheadend/blob/master/src/misc/m3u.c
[dispatcharr]: https://github.com/Dispatcharr/Dispatcharr/issues/1400

# XMLTV parser, serializer and builders

The `epg-tools/xmltv` entry point is the standalone half of this package: a
streaming XMLTV parser, a streaming serializer, a fluent builder API for
constructing guides, and the date helpers that back both. It pulls in nothing
else — no grabber, no cache, no config loading, and no runtime dependencies —
so it is usable on its own.

```ts
import { parseXmltvFile, writeXmltvToFile } from 'epg-tools/xmltv';
```

- [Parsing](#parsing)
  - [Parse options](#parse-options)
  - [Warnings](#warnings)
- [Serializing](#serializing)
- [Node stream Transforms](#node-stream-transforms)
- [Builders](#builders)
- [Dates](#dates)

See also: [Programmatic API](./api.md) for the full export map,
[Benchmarks](../README.md#benchmarks) for how it measures up.

## Parsing

Three entry points, all taking the same [parse options](#parse-options):

| function | takes | gives |
|---|---|---|
| `parseXmltvFile(path, options?)` | a file path | `AsyncGenerator<XmltvParseEvent>` |
| `parseXmltvStream(source, options?)` | any iterable of string/`Uint8Array` chunks | `AsyncGenerator<XmltvParseEvent>` |
| `parseXmltvString(xml, options?)` | a whole string | `XmltvDocument` — everything collected |

The streaming forms hold **one element at a time**, whether the guide is 16 MiB
or 16 GiB:

```ts
import { parseXmltvFile } from 'epg-tools/xmltv';

for await (const event of parseXmltvFile('guide.xml')) {
  if (event.type === 'programme') {
    console.log(event.value.start, event.value.title[0]?.value);
  } else if (event.type === 'warning') {
    console.warn(`${event.value.code} at line ${event.value.line}: ${event.value.message}`);
  }
}
```

An event is `{ type, value }` with `type` one of `meta`, `channel`, `programme`,
`processing-instruction` or `warning`. `meta` carries the root `<tv>` attributes
and arrives first — unless the document opens with a
[processing instruction](#processing-instructions), which is genuinely there
before the root is.

`parseXmltvString` is the synchronous whole-document form other XMLTV parsers
offer — the same shape as `@iptv/xmltv`'s `parseXmltv`, but it also hands back
the `warnings` most parsers do not expose at all:

```ts
import { parseXmltvString } from 'epg-tools/xmltv';

const { meta, channels, programmes, warnings } = parseXmltvString(xml);
```

It is exported from `epg-tools/xmltv` only, not from the package root.

### Processing instructions

XML's own way of addressing one reader: `<?target data?>`, ignored by everything
that does not know the target and constrained by no DTD. The parser yields each
one as it comes (never the XML declaration, which only looks like one), and
`parseXmltvString` collects them in document order:

```ts
const { processingInstructions } = parseXmltvString(xml);
// [{ target: 'epg-cache', data: '{"grabbedAt":"…"}', position: 'root' }]
```

Writing them back is the same shape: `writeXmltvStream` takes
`processingInstructions` beside its channels and programmes,
`XmltvSerializeStream` accepts `{ type: 'processing-instruction', value }` events
— so a parse piped into a serialize keeps them — `XmltvDocumentBuilder` has
`.processingInstruction(target, data?, position?)`, and
`serializeProcessingInstruction` writes a single one.

Only the top level: one inside a `<programme>` or a `<channel>` is skipped like a
comment, since there is nothing in the parsed element to hang it on.

#### Position

`position` is where one sits relative to the root element. The parser reports
where it found it and the serializer puts it back there, so a document survives
a round trip unchanged:

| `position` | Where it goes |
| --- | --- |
| `'prolog'` | Before `<tv>`, after the DOCTYPE |
| `'root'` | Inside `<tv>`, among the channels and programmes |
| `'epilog'` | After `</tv>` |

It is **required**, because it is the whole of where the instruction goes: one
placed by a default rather than by intent is one that comes back out of a parse
somewhere other than where it went in. `.processingInstruction()` on the builder
defaults it to `'root'`, which is the place to be brief about the common case.

```ts
new XmltvDocumentBuilder()
  .processingInstruction('xml-stylesheet', 'type="text/xsl" href="guide.xsl"', 'prolog')
  .processingInstruction('epg-cache', '{"programmeCount":1}')
  .toXml({ indent: 2 });
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE tv SYSTEM "xmltv.dtd">
<?xml-stylesheet type="text/xsl" href="guide.xsl"?>
<tv>
  <?epg-cache {"programmeCount":1}?>
</tv>
```

The one place an instruction cannot go is ahead of the XML declaration, which
nothing may precede. That is also why `writeXmltvStream` takes them as a plain
`Iterable` rather than streaming them like the channels: a prolog one has to be
in hand before the header goes out. `XmltvSerializeStream` holds the ones that
arrive before the header for the same reason, and throws if a `prolog` one shows
up after the root has already been written.

#### `?>` cannot be escaped

`data` goes out verbatim, because XML recognizes no markup and no entity inside
an instruction — nothing is decoded on the way in either. The consequence is that
`?>` **cannot appear in `data` at all**: XML ends the instruction at the first
one and offers no escape for it, so `serializeProcessingInstruction` throws
rather than write a document that reads back as a truncated instruction followed
by stray text.

A caller that owns its payload encodes around it instead. The cache store's meta
is JSON, so it writes every `>` as a unicode escape: JSON gives the character
back on parse, and XML never sees a `>` to end an instruction on — the same trick
as embedding JSON in a `<script>` tag without tripping over `</script>`.

This is how a cache entry in [xmltv format](./configuration.md#cache-reference)
records what the DTD has no attribute for: it stays a document any other reader
accepts, and `xmllint --dtdvalid` agrees.

### Cancelling

`parseXmltvStream`, `parseXmltvFile` and `XmltvParseStream` take a `signal`, as
`writeXmltvStream`, `writeXmltvToFile` and `XmltvSerializeStream` do:

```ts
const controller = new AbortController();

for await (const event of parseXmltvFile('guide.xml', { signal: controller.signal })) {
  if (enough(event)) controller.abort();
}
```

Parsing stops **between chunks** and writing **between elements** — a check per
event would sit in the middle of the hot loop, and a 512 KiB read is a
millisecond of it. What cancelling promises is that the rest of the file is
never read: `parseXmltvFile` hands the signal to `fs`, so the descriptor closes
with it rather than waiting to be collected, and `writeXmltvToFile` discards
what it had written. The two `Transform`s take the signal the way any Node
stream does — they are destroyed with an `AbortError` whose `cause` is the
reason, which is what the rest of a `pipeline()` around them is waiting to hear.

`parseXmltvString` takes none: it has the whole document in hand already and
nothing to interrupt.

### Parse options

`XmltvParseOptions` is accepted by every entry point above and by
[`XmltvParseStream`](#node-stream-transforms).

| option | type | default | what it does |
|---|---|---|---|
| `tolerateMissingId` | `boolean` | `false` | Keep a `<channel>` with no `id`, or a `<programme>` with no `channel`, instead of dropping it — the missing attribute is left as `""`. For a single-channel feed that omits the reference everywhere, leaving the merge layer to attach them to the one known channel. |
| `rootScanLimit` | `number` | `1_048_576` (1 MiB) | How many characters are buffered while looking for the root `<tv>` before giving up with a `TypeError`. Guards against unbounded buffering of a non-XML or headerless stream: raise it for an unusually large preamble, lower it to fail faster on untrusted input. |
| `timezones` | `Record<string, number>` | — | Named timezone abbreviations → UTC offset in minutes, **UPPERCASE keys**: `{ BST: 60, CET: 60, CEST: 120 }`. `GMT`/`UTC`/`UT`/`Z` are always understood; any other named zone must be listed here or the datetime is dropped with a warning naming the unknown zone, so an unmapped abbreviation is surfaced and fixed rather than silently assumed to be UTC. Numeric `±HHMM` offsets never need this. |

### Warnings

A malformed feed never aborts the stream. One bad programme in a 20 MB guide
costs you one programme, not the guide — each problem is reported as a
`{ type: 'warning' }` event (or collected into `warnings` by
`parseXmltvString`) and parsing continues. The whole mechanism costs about 2%
of throughput.

```ts
interface XmltvWarning {
  code:
    | 'invalid-programme' | 'invalid-attribute' | 'invalid-element'
    | 'malformed-markup' | 'unknown-element' | 'truncated-input';
  message: string;
  line: number;   // 1-based
  col: number;    // 1-based, in characters
}
```

What is tolerated, and how:

- a programme with a missing or invalid `start` is skipped
- a `<channel>` without its required `id`, or a `<programme>` without its
  required `channel`, is skipped — unless `tolerateMissingId` is on
- a bad attribute value is dropped, keeping the rest of the element
- a duplicated attribute, or a repeated single-occurrence element, keeps its
  **first** value and ignores the repeat
- truncated input is detected and reported rather than silently accepted

Only a document with no root `<tv>` inside `rootScanLimit` throws.

### Provider extensions

Anything outside the DTD round-trips instead of being dropped, so a consumer
like [tvheadend's XPath-based grabber](https://github.com/tvheadend/tvheadend/blob/master/docs/class/epggrabber_modules.md#xmltv-xpath-examples-and-notes)
can still extract it: `uniqueID` on `<programme>`, `eit` codes on
`<category>`, `<crid><series>…</series></crid>`, `<live/>`, `<lcn>`.

Two places hold it:

- **`extraAttributes`** — an optional `Record<string, string>` on every modeled
  element (`icon`, `url`, `rating`, `image`, credit persons, `video`, the `<tv>`
  root, …), for attributes the DTD does not define.
- **`extra`** — on `programme` and `channel` (and other elements whose content
  model allows trailing unknown children), an `XmltvExtraElement[]` of
  `{ name, attributes?, value?, children? }`.

Both are emitted verbatim on the way out, so a parse → serialize round-trip is
lossless. You can produce them the same way: the
[builders](#builders) have `.extra()`, `.extraAttribute()` and
`.extraAttributes()`, and every element method takes a trailing
`extraAttributes` argument — which is how a site's `parseDay` and `channelInfo`
[write extensions into a grabbed guide](./site-config.md#building-programmes).

## Serializing

| function | gives |
|---|---|
| `writeXmltvStream(input, options?)` | `AsyncGenerator<string>` — XML chunks |
| `writeXmltvToFile(path, input, options?)` | writes the file |
| `serializeChannel(channel, options?)` | one `<channel>` element |
| `serializeProgramme(programme, options?)` | one `<programme>` element |
| `serializeDocumentHeader(meta?, options?)` | the XML declaration, doctype and opening `<tv>` |
| `serializeDocumentFooter(options?)` | the closing `</tv>` |
| `serializeProcessingInstruction(instruction, options?)` | one `<?target data?>` |

The last four let you assemble a document by hand — header, your own elements
in any order, footer — when neither the stream form nor the builders fit. Pass
`processingInstructions` to the header and the footer and each writes the ones
that belong to it, so nothing between them has to know about them.

`SerializeOptions`:

| option | type | default | what it does |
|---|---|---|---|
| `indent` | `string \| number` | omitted — **compact** | Pretty-print with this indentation, mirroring `JSON.stringify`: a number of spaces or a literal string like `'\t'`. Compact output has no whitespace between elements at all, which is smaller and what a machine consumer like tvheadend wants. |
| `highWaterMark` | `number` | Node's stream default (16 KiB before Node 22, 64 KiB since) | For `writeXmltvStream`, how many characters accumulate before a chunk is yielded — one yield per batch, not per element, since a generator has no buffer of its own. For `XmltvSerializeStream` it is simply the readable `highWaterMark`. Ignored by the per-element serializers. |

```ts
writeXmltvStream(input, { indent: 2 });     // two-space pretty-print
serializeProgramme(programme);              // compact (default)
```

## Node stream Transforms

Both directions also come as `Transform` classes for `stream.pipeline()`.
They are symmetric: the events `XmltvParseStream` emits are exactly what
`XmltvSerializeStream` consumes, so a `parse → serialize` pipeline round-trips.

```ts
import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { XmltvParseStream, XmltvSerializeStream } from 'epg-tools/xmltv';

// Bytes → parse events ({ type: 'meta' | 'channel' | 'programme' | 'warning', value }):
await pipeline(createReadStream('guide.xml'), new XmltvParseStream(), async (events) => {
  for await (const event of events) { /* … */ }
});

// Tagged events → XML bytes (a `meta` event sets the <tv> attributes,
// then channels, then programmes):
await pipeline(source, new XmltvSerializeStream({ meta }), createWriteStream('guide.xml'));
```

`XmltvParseStream`'s object-mode output carries `warning` events inline with
the data. `XmltvSerializeStream` produces XML text, so any `warning` event it
receives is re-surfaced as a `'warning'` event on the stream
(`stream.on('warning', w => …)`) rather than lost. A `meta` event supplies the
base `<tv>` attributes and the constructor's `meta` option overrides them
field by field — handy for relabelling a guide as it passes through. Misuse
errors the stream: a `meta` event after the first channel or programme, or an
unrecognized event type.

## Builders

Writing an `XmltvProgramme` by hand means spelling out every field as an array
of language-tagged values. The builders do that part for you — a fluent,
chainable API over the same typed model, so `.desc('…')` appends to `desc`
with the right shape and the right default `lang`.

`ProgrammeBuilder` covers the whole DTD: text elements (`title`, `subTitle`,
`desc`, `category`, `keyword`, `language`, `origLanguage`, `country`), times
(`stop`, `pdcStart`, `vpsStart`, `date`, `length`), identifiers (`showview`,
`videoplus`, `clumpidx`, `episodeNum`, `episode`), media (`icon`, `url`,
`image`), technical detail (`video`, `audio`, `subtitles`), flags (`new`,
`premiere`, `lastChance`, `previouslyShown`), ratings (`rating`, `starRating`,
`review`), every credit role (`director`, `writer`, `adapter`, `producer`,
`composer`, `editor`, `presenter`, `commentator`, `guest`, `actor`), and the
escape hatches `extra` / `creditsExtra` / `extraAttribute(s)` for non-DTD
content. `ChannelBuilder` covers `displayName`, `icon`, `url` and `extra`.

Both take their required fields in the constructor and end with `.build()`:

```ts
import { ProgrammeBuilder } from 'epg-tools/xmltv';

const programme = new ProgrammeBuilder({
  channel: 'one.example.tv',
  start: '20260717200000 +0200',
  title: 'The Nine O\'Clock News',
  lang: 'en',                    // the default lang for every method below
})
  .stop('20260717203000 +0200')
  .desc('The day in review.')
  .category('News')
  .episode(3, 2)                 // episode 3, season 2 → an xmltv_ns episode-num
  .actor('Jane Doe', { role: 'Presenter' })
  .build();
```

`XmltvDocumentBuilder` assembles a whole guide. Root `<tv>` attributes go in
through `meta()` (merging, later calls win per field) or the shortcuts
`date()`, `sourceInfo(name, url?)`, `sourceDataUrl(url)` and
`generatorInfo(name, url?)`. Channels and programmes go in as base fields, as
a standalone builder, or through a configure callback:

```ts
import { XmltvDocumentBuilder } from 'epg-tools/xmltv';

const doc = new XmltvDocumentBuilder()
  .generatorInfo('epg-tools', 'https://github.com/Ruby184/epg-tools')
  .sourceInfo('Example TV', 'https://example.tv')
  .channel({ id: 'one.example.tv', displayName: 'One', lang: 'en' }, (c) =>
    c.displayName('Jeden', 'sk').icon('https://example.tv/one.png'))
  .programme({ channel: 'one.example.tv', start: '20260717200000 +0200', title: 'News' }, (p) =>
    p.desc('Evening news').episode(3));
```

`addChannel` / `addProgramme` are the same thing without a callback: they open
a builder bound to the document, and `.end()` returns to it.

```ts
const doc = new XmltvDocumentBuilder()
  .addProgramme({ channel: 'one.example.tv', start: '20260717200000 +0200', title: 'News' })
    .desc('Evening news')
    .episode(3)
    .end()
  .addChannel({ id: 'one.example.tv', displayName: 'One' })
    .icon('https://example.tv/one.png')
    .end();
```

Four ways out, so the document suits whichever consumer you have:

| method | gives |
|---|---|
| `.build()` | `{ meta, channels, programmes }` — the input `writeXmltvStream` / `writeXmltvToFile` take |
| `.toXml(options?)` | the whole document as one XML string |
| `.toStream(options?)` | a Node `Readable` of XML chunks, ready to pipe |
| `.toEvents()` | tagged `{ type, value }` events — what `XmltvSerializeStream` consumes and the parser emits |

The builders are also handed to you while grabbing: `parseDay` receives a
`programme` factory with the channel and language already filled in, and may
return builders instead of objects. See
[Site configuration](./site-config.md#building-programmes).

## Dates

An XMLTV datetime is `YYYYMMDDHHMMSS ±HHMM`, and truncated forms
(`YYYYMMDDHHMM`, `YYYYMMDD`, `YYYY`) are legal. A JS `Date` is a bare UTC
instant with no timezone slot and no notion of "how precise was this", so
parsing one and formatting it back would normally lose both. This package
preserves them on the `Date` under two `Symbol` keys — invisible to
`Object.keys`, `for...in` and `JSON.stringify`, so they never leak into your
data — and the serializer reads them back to re-emit the source's own offset
and shape.

| function | what it does |
|---|---|
| `parseXmltvDate(value, timezones?)` | Parse an XMLTV datetime, preserving offset and precision. Throws `XmltvDateError` with a `reason` and an `index` into the input. |
| `formatXmltvDate(date, options?)` | Format a `Date` back, honouring what was preserved. `{ offset: false }` omits the `±HHMM` suffix, for offset-free elements like a programme's production `<date>`. |
| `xmltvDate(value, options?)` | Coerce a `DateInput` and set the flags in one call — the convenience form of `new Date()` + the two setters. |
| `getXmltvOffset` / `setXmltvOffset` | Read or preserve the source UTC offset in minutes (`120` for `+0200`). Defaults to `0`, meaning UTC. |
| `getXmltvPrecision` / `setXmltvPrecision` | Read or preserve the source precision as a digit count: `4` year, `6` month, `8` day, `10` hour, `12` minute, `14` second. Defaults to `14`. |
| `XMLTV_OFFSET` / `XMLTV_PRECISION` | The `Symbol` keys themselves, for typing a value as carrying them. |

`DateInput` — accepted by `xmltvDate` and everywhere the builders take a time
— is a `Date` (any preserved flags carry over), an XMLTV datetime string, or a
**unix timestamp in seconds** (pass milliseconds as `new Date(ms)`).

```ts
import { parseXmltvDate, formatXmltvDate, xmltvDate } from 'epg-tools/xmltv';

const d = parseXmltvDate('20260717 +0200');   // day precision, +02:00 preserved
formatXmltvDate(d);                            // '20260717 +0200' — not normalized to UTC
formatXmltvDate(xmltvDate(d, { precision: 14 }));  // '20260717000000 +0200'
```

A named zone other than `GMT`/`UTC`/`UT`/`Z` needs a `timezones` mapping,
either here or in the [parse options](#parse-options) — an unmapped one throws
rather than being silently read as UTC.

---

[← README](../README.md) · [Site configuration](./site-config.md) · [Configuration & CLI](./configuration.md) · [XMLTV grabber](./tv-grab.md) · [Programmatic API](./api.md)

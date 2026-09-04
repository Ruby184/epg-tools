# Channel lists, and matching two of them

`epg-tools/channels` reads and writes the `*.channels.xml` files the community
keeps by hand, and answers the question those files exist to answer: **which
channel on a source is which channel in a guide.**

```ts
import { parseChannelsXml, serializeChannelsXml, matchChannels } from 'epg-tools/channels';
```

Zero dependencies, and no grabber, cache or config loading behind it — the same
rule [`epg-tools/xmltv`](./xmltv.md) and [`epg-tools/m3u`](./m3u.md) follow. The
one thing it does load from the rest of the package is `escape.ts`, the XMLTV
module's entity rules, which imports nothing itself: a `*.channels.xml` escapes
exactly as a guide does, and a second copy of those rules is how the two drift.

## Why this exists

The commonest failure in this whole ecosystem is not a grab that breaks. It is
an id in one file that does not equal an id in another. Nothing errors. The
playlist loads, the guide loads, and one of them simply has nothing to say about
the other, so a row in the grid is empty and no component anywhere says why.

`*.channels.xml` is how [iptv-org/epg](https://github.com/iptv-org/epg) and
[WebGrab+Plus](https://webgrabplus.com) both record the mapping that prevents
it. They are the same document — iptv-org writes

```xml
<channel site="tvtv.us" site_id="10035" lang="en" xmltv_id="AE.us@East">A&amp;E East</channel>
```

and WebGrab+Plus the same four attributes plus an `update` of its own — so one
reader serves both. It is also exactly the split this package already models in
`GrabberChannel`: an id the **source** understands, and an id the **guide**
does.

Keeping it right is the whole game, and it is not a solved problem in the
files that exist: tvtv.us's own curated list carries **69 of its 2,299 channels
with `xmltv_id=""`**. Those channels can be fetched and cannot be published.

## Reading

```ts
const { site, entries, warnings } = parseChannelsXml(await readFile(path, 'utf8'));
```

| | |
|---|---|
| `entries` | every `<channel>`, **in file order** |
| `site` | the `site` on the `<channels>` root, when the file put one there |
| `warnings` | non-fatal problems; the reader never throws |

Order is kept because these files are hand-maintained and diffed. A reader that
sorted would turn a one-line change into a review nobody can read.

An entry is the element's attributes plus its text, renamed to this package's
spelling:

```ts
interface ChannelListEntry {
  siteId: string; // site_id — the id the source knows it by
  xmltvId: string; // xmltv_id — the id the guide knows it by, '' when unmapped
  name: string; // the element's text
  site?: string; // resolved: the root's, where the channel gave none
  lang?: string; // the language the *name* is in, not the channel's
  update?: string; // WebGrab+Plus's refresh policy, kept so its files round-trip
  logo?: string;
  url?: string; // the channel's own page, not a stream
  lcn?: string; // Logical Channel Number — a string, because `101.2` exists
}
```

`site` is **resolved**, not copied: a file that names its source once on the
root means every channel in it, and an entry should not have to be read back
with the document in hand to know where it came from. Writing puts it back where
it was rather than repeating it on every line.

It is a small hand-written reader rather than a general XML parser, because the
document is small and flat — one level of elements, attributes and text, no
nesting and no mixed content.

### Warnings

| code | when |
|---|---|
| `missing-site-id` | a `<channel>` with no `site_id`, which can identify nothing |
| `unmapped-channel` | an empty `xmltv_id` — nothing in a guide can ever match it |
| `duplicate-site-id` | two entries claiming one `site_id` for the same site |
| `unexpected-document` | not a `<channels>` list at all |

`unmapped-channel` is the one that matters, and it is why the reader warns
rather than throwing: the useful answer to a file with a problem in it is the
2,298 channels that *did* read, plus a note about the one that did not.

Duplicates are counted per **resolved** site, so a channel naming its site and
one inheriting it from the root still collide — they are the same channel of the
same source.

## Writing

```ts
const xml = serializeChannelsXml(parseChannelsXml(text)); // reads back byte-identical
```

Takes what the reader returned, or just its entries. `serializeChannelsXmlEntry`
writes one element if you are assembling a file yourself.

The output is shaped **for a diff**, not for a parser: entries stay in the order
given, the indentation matches what iptv-org and WebGrab+Plus both write, and
the attributes come out in the order those two put them in — `update` first
where WebGrab+Plus puts it, then the four iptv-org writes, in its order. An
entry whose `site` is the root's writes without it. `xmltv_id` is written even
when empty, because that is what an unmapped channel *is* in these files.

| option | |
|---|---|
| `site` | the root's `site`, naming the source once |
| `eol` | `'\n'` by default — these files live in git, and are LF even on Windows |

## Matching

This is the part that matters. Reading a file is bookkeeping; knowing that the
`BBC One HD` in a playlist is the `bbcone.uk` in a guide is the thing nobody
has.

```ts
const matches = matchChannels(
  wanted.map((c) => ({ id: c.tvgId, name: c.name, value: c })),
  available.map((c) => ({ id: c.xmltvId, name: c.name, value: c })),
);
```

Both sides are `{ id?, name?, value }`, and `value` is your own object handed
back untouched — so this matches a playlist against a guide, a guide against a
channel list, or any two of anything.

**The rules are asymmetric on purpose.** Getting a match wrong is worse than
getting none: a channel with no guide shows an empty grid, and a channel with
the *wrong* guide shows a confident, plausible, incorrect schedule.

| result | `kind` | `confidence` | what it means |
|---|---|---|---|
| ids are equal | `id` | `1` | certain, and applied |
| names agree once normalized | `name` | `0.8` | a suggestion — **nothing is written** |
| two candidates normalize the same | `none`, with `ambiguous` | `0` | reported, matched to neither |
| a shift of something available | `none`, with `timeshiftOf` | `0` | an answer, but not a mapping |
| nothing | `none` | `0` | nothing produces this channel |

A name match is never applied on its own. Confirm one by writing the id into
your channel list, which is what `epg channels` tells you to do.

### What a name can differ by

Normalizing drops case, accents, punctuation, and **picture-quality markers** —
`HD`, `SD`, `FHD`, `UHD`, `4K`, `HEVC` and the rest. Two feeds of one channel
differing only by those carry the same schedule, which is what makes them safe
to drop.

```ts
'BBC One HD' → 'bbc one'
'Français'   → 'francais'
```

### What it will not drop

A **timeshift** is recognized and deliberately not stripped:

```ts
timeshiftOf('Sky One +1'); // { offset: 60, base: 'Sky One' }
```

`Sky One +1` is a different channel from `Sky One`. Folding the two together
would assign a schedule that is confidently an hour out — so when the name
declares an offset and the base name *is* available, the match carries
`timeshiftOf: { channel, offset }` instead of `matched`. The answer is "this is
`Sky One` an hour later", which is a channel you can **derive**, not one you can
map.

`timeshiftName` is the inverse, and the two read each other back:

```ts
timeshiftName('Sky One', 60); // 'Sky One +1'
```

A derived channel declared in a config lands on the name a viewer is looking
for, so `matchChannels` places it by name even before an id is set — see
[derived channels](./configuration.md#derived-channels) for the declaration
itself, which is what turns this hint into a channel. It returns
`undefined` rather than inventing a spelling when the offset is not a whole
number of hours — `+90 minutes` has no form the recognizer would read back, and
one that reads back as something else is worse than declining.

## `epg channels`

The command form of all of the above: given what you want and what your
configured sites can produce, which of the two do not line up.

```console
$ epg channels --against playlist.m3u
  ~ BBC Two HD
      looks like bbctwo.uk (BBC Two) — set its id to confirm
  ~ Sky One +1
      a +1h shift of skyone.uk — a derived channel, not a mapping
  ✗ Some Channel Nobody Has (nope.uk)
      nothing produces this

4 wanted, 1 matched by id, 1 by name, 2 with nothing
```

`--against` takes an **M3U playlist, a `*.channels.xml`, or an XMLTV guide** —
sniffed rather than taken from the extension, since all three get renamed and
`.xml` alone does not say which of the last two it is.

Only what is wrong is printed; a channel matched by id says nothing. Add
`--check` to exit non-zero unless **every** wanted channel matched by id, which
is the form for CI — a name match is a suggestion, so a channel resting on one
still shows an empty grid tomorrow. `--format json` gives the whole report,
matches included.

## A channel list as a site's channels

The bridge lives in `epg-tools/grabber`, not here — this subpath imports nothing
from the rest of the package:

```ts
import { channelsFromChannelsXml } from 'epg-tools/grabber';

channels: channelsFromChannelsXml('./tvtv.us.channels.xml'),
```

It returns the `channels` function rather than the channels, so the file is read
when the list is resolved rather than when the config module loads, and the
site's own `warn` hears about an unmapped channel without your wiring anything
up. A string is a path; entries can be passed instead for a list that came from
somewhere else.

`site_id` and `xmltv_id` are already the split `GrabberChannel` models, so most
of the mapping is a rename — `lang`, `logo`, and `lcn` → `preset`, the number a
box shows the channel at. An entry with **no `xmltv_id` is skipped**: it names
something the source has but nothing a guide could refer to, so grabbing it
would write programmes under an id no consumer can ask for. `onSkipped` is told
about each one and why.

`data` carries only the three things a `GrabberChannel` has no field for: the
`site`, for a file holding more than one; the channel's own `url`; and
WebGrab+Plus's `update`, so a list built from one of its files and written back
does not come back with everyone's refresh policy silently reset.

| option | |
|---|---|
| `site` | keep only the entries belonging to this source |
| `onSkipped` | `(entry, reason)` — `unmapped`, `other-site`, `duplicate-site-id` |
| `onWarning` | the parse warnings; goes to the site's `warn` if you do not take it |

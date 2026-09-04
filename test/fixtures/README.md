# Test fixtures

Vendored third-party data used to test parsing against the real-world XMLTV and
M3U that other tools produce and consume.

- **`xmltv.dtd`** — the official XMLTV DTD from
  <https://github.com/XMLTV/xmltv/blob/master/xmltv.dtd> (GPL-2.0). Used only
  by the `xmllint --valid` conformance test; not shipped in the package.
- **`xmltv-lineups.xsd`** — the official channel-lineup schema from
  <https://github.com/XMLTV/xmltv/blob/master/xmltv-lineups.xsd> (GPL-2.0).
  Used only by the `xmllint --schema` conformance test for what
  `--list-lineups` and `--get-lineup` produce; not shipped in the package.
- **`epg-parser-basic.xml`** — the `basic.xml` sample from
  [`epg-parser`](https://github.com/freearhey/epg-parser) (MIT,
  `test/data/basic.xml`). A dense real-world guide: two channels (one
  minimal), a fully-populated programme, a multi-line root tag, and an empty
  programme with no `<title>`.
- **`iptv-org-slice.m3u`** — four entries and the header from
  [iptv-org's `index.m3u`](https://iptv-org.github.io/iptv/index.m3u) (the
  [iptv-org/iptv](https://github.com/iptv-org/iptv) repository is released into
  the public domain under the Unlicense), taken on 2026-09-03. Chosen one entry
  per case the M3U parser has to get right: a plain entry, one whose
  `http-user-agent` contains **a comma inside a quoted value** (628 of the
  playlist's 12,946 entries do), one carrying two `#EXTVLCOPT` directives, and
  one with an `http-referrer` that no specification documents. CRLF throughout,
  as the original is. Not shipped in the package.

  A comma in the *display name* — the other half of the case that tells the
  parsing rules apart — is not in here because no entry of the 12,946 has one;
  `test/m3u.test.ts` covers that with a synthetic entry instead.

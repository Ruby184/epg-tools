# Test fixtures

Vendored third-party data used to test parsing against real-world XMLTV that
other tools produce and consume.

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

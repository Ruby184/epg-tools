# Contributing

Thanks for taking a look. This is a small package with a fast local loop —
there is no build step to run before tests, and nothing to configure.

## Getting set up

```sh
npm ci
```

Node **>= 20** is required, and >= 23.6 if you want to run `epg.config.ts`
files directly via native type stripping. CI runs the suite on 20, 22 and 24.

## The loop

| command | does |
|---|---|
| `npm test` | the whole suite, once (`vitest run`) |
| `npm run test:watch` | the suite in watch mode |
| `npm run typecheck` | `tsc --noEmit` — also what checks the documentation, see below |
| `npm run build` | bundle to `dist/` with tsup |
| `npm run bench` | speed benchmarks (`vitest bench`) |
| `npm run bench:memory` | memory benchmarks — builds first, then runs isolated processes |

`npm run typecheck && npm test && npm run build` is what CI does, and what
`prepublishOnly` runs before a release.

Tests live in `test/**/*.test.ts` and benchmarks in `bench/**/*.bench.ts` —
`vitest.config.ts` keeps the two apart, so a benchmark never runs as part of
`npm test`.

### `xmllint` is optional, and silently skips

Some suites validate generated output against the official
[`xmltv.dtd`](test/fixtures/xmltv.dtd) and
[`xmltv-lineups.xsd`](test/fixtures/xmltv-lineups.xsd) by shelling out to
`xmllint`. When it is not installed those `describe` blocks are **skipped
rather than failed**, so a green local run does not by itself mean the
conformance tests passed. Install it if you are touching the serializer or the
lineups output:

```sh
sudo apt install libxml2-utils    # Debian/Ubuntu
brew install libxml2              # macOS
```

The two schema files are vendored third-party documents — see
[test/fixtures/README.md](test/fixtures/README.md) for their provenance and
licensing. They are used only by tests and are not shipped (`files` in
`package.json` is `["dist"]`).

## Documentation is typechecked

[`test/readme-examples.ts`](test/readme-examples.ts) re-declares the code
blocks from `README.md` and `docs/*.md` against the real `src/` imports. It is
not a test — nothing in it runs — but it is typechecked with everything else,
so an API change that would make a documented example wrong **fails
`npm run typecheck`** instead of being discovered by whoever copies it out.

It is kept in step by hand. **If you change a code block in the documentation,
or change an API a block uses, update that file too.** Its sections are
banner-commented to mirror the documentation layout, so the block you edited
should be easy to find.

Where the documentation lives:

| file | covers |
|---|---|
| `README.md` | the pitch, install, quick start, benchmarks — kept short enough to read on npm |
| `docs/configuration.md` | `EpgConfig`, the cache, the CLI, merge strategies |
| `docs/site-config.md` | `SiteConfig` — channels, requests, parsing, batching, pacing |
| `docs/xmltv.md` | the standalone parser, serializer, builders and dates |
| `docs/tv-grab.md` | the XMLTV grabber protocol and capabilities |
| `docs/api.md` | the programmatic API and the export map |

When you add or rename a public export, `docs/api.md`'s export map is the place
that has to keep up.

## Commits

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/),
scoped by the module they touch:

```
feat(grabber): fetch a channel list with the site's own client
fix(xmltv): never write out a null attribute value
refactor(cli): share the stream-writing helpers between entry points
```

Scopes in use: `xmltv`, `grabber`, `cache`, `merge`, `tv-grab`, `cli`, `build`.
Mark a breaking change with a `!` after the scope (`feat(grabber)!:`) and
explain the migration in the body — the changelog is written from these.

## Releasing

Releases are automated: pushing a `v*` tag triggers
[`.github/workflows/release.yml`](.github/workflows/release.yml), which
publishes to npm via OIDC trusted publishing (no token in the repo, provenance
attached automatically). Update `CHANGELOG.md` and the version in
`package.json` before tagging.

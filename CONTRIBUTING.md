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
| `npm run format` | format everything with [oxfmt](https://oxc.rs) |
| `npm run format:check` | fail instead of writing — what CI runs |
| `npm run lint` | [oxlint](https://oxc.rs) over the whole tree |
| `npm run lint:fix` | …and apply what it can fix |
| `npm run build` | bundle to `dist/` with tsup |
| `npm run bench` | speed benchmarks (`vitest bench`) |
| `npm run bench:memory` | memory benchmarks — builds first, then runs isolated processes |

Formatting and linting are the Oxc tools, so both finish in well under a
second over the whole tree. Their configuration is `.oxfmtrc.json` (100
columns, single quotes, trailing commas) and `.oxlintrc.json` (the
`correctness` category, plus the `typescript`, `unicorn`, `oxc` and `promise`
plugins).

Two rules are deliberately off or suppressed, both explained where they are
set: `unicorn/no-useless-spread`, because `...(cond ? { x } : {})` is how
`exactOptionalPropertyTypes` lets a possibly-undefined value be omitted rather
than set to `undefined`; and `typescript/no-unsafe-declaration-merging` at one
site in `src/xmltv/serialize.ts`, where merging an interface into the class is
how a stream's `on('warning', …)` overload gets typed.

`prepublishOnly` runs format:check, lint, typecheck, test and build.

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

## Git hooks

`npm ci` installs [husky](https://typicode.github.io/husky/), which wires three
hooks:

| hook | runs | why |
|---|---|---|
| `pre-commit` | `lint-staged` — oxfmt and `oxlint --fix` over staged files | nothing unformatted lands, and it only touches what you staged |
| `commit-msg` | `commitlint` | the changelog is generated from these messages, so a malformed one is a problem later |
| `pre-push` | `npm run typecheck && npm test` | the suite is ~2s; better here than in CI |

All three are bypassable with `--no-verify`, so CI checks the same things
independently — formatting, lint and commit messages in one `check` job,
typecheck/test/build across Node 20, 22 and 24.

Markdown is deliberately outside oxfmt's reach (see `.oxfmtrc.json`): it
formats fenced code blocks, and the documentation's examples are fragments
rather than whole programs, so a bare `cache: { dir: … }` picks up a semicolon
and stops being valid.

The tree was formatted in one commit, which `.git-blame-ignore-revs` lists so
it does not sit on top of every line in `git blame`. GitHub honours that file
on its own; locally it is one command per clone:

```sh
git config blame.ignoreRevsFile .git-blame-ignore-revs
```

## Commits

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/),
scoped by the module they touch:

```
feat(grabber): fetch a channel list with the site's own client
fix(xmltv): never write out a null attribute value
refactor(cli): share the stream-writing helpers between entry points
```

Scopes are enforced by [`commitlint.config.js`](./commitlint.config.js): one
per module — `xmltv`, `grabber`, `cache`, `merge`, `tv-grab`, `cli`, `core` —
plus `build` and `deps` for the toolchain. A scope is optional, since a `docs:`
or `test:` change is rarely one module's.

The type decides what the release does: `feat` bumps the minor, `fix` the
patch, and a `!` after the scope (`feat(grabber)!:`) or a `BREAKING CHANGE:`
footer bumps the minor too while the version is below 1.0.0. `docs`, `perf`,
`refactor` and `revert` appear in the changelog; `chore`, `style`, `test`,
`ci` and `build` are hidden from it.

Write the body for whoever reads the changelog: what changed and why, not how.

## Releasing

Releases are driven by [release-please](https://github.com/googleapis/release-please).
Nothing is tagged by hand:

1. Conventional commits land on `main`.
2. release-please keeps a **release PR** open — titled `chore(main): release
   x.y.z` — that bumps `package.json` and writes the new `CHANGELOG.md`
   section. It rewrites that PR as more commits arrive.
3. Merging it creates the tag **and** the GitHub Release with those notes.
4. That same workflow then publishes to npm via OIDC trusted publishing — no
   token in the repo, and provenance attached automatically.

So releasing is one action: merge the release PR when the accumulated changes
are worth shipping.

The publish is a job in
[`.github/workflows/release.yml`](.github/workflows/release.yml) rather than a
separate workflow keyed on the tag, because a tag pushed by `GITHUB_TOKEN` does
not trigger another workflow — a `on: push: tags` publish would silently never
run.

Version state lives in [`.release-please-manifest.json`](./.release-please-manifest.json);
the changelog sections and bump behaviour are in
[`release-please-config.json`](./release-please-config.json). `0.1.0` in the
changelog is hand-written, describing where the package started; everything
after it is generated.

import { readFileSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defineConfig } from 'tsdown';

const { name, version } = JSON.parse(readFileSync('./package.json', 'utf8')) as {
  name: string;
  version: string;
};

/**
 * What a declaration needs before it can name `Symbol.asyncDispose`.
 *
 * `CacheManager` and `SqliteCacheDriver` are disposable, so the types shipped
 * for them name `AsyncDisposable` and `Symbol.asyncDispose` — which exist only
 * with TypeScript's `esnext.disposable` lib. Without this a consumer on
 * `"lib": ["ES2022"]` cannot read our types at all, and the error names a
 * symbol they never asked for; with it they need nothing in their own config.
 *
 * Written onto the output rather than into the source: a `/// <reference lib>`
 * in a `.ts` file is not carried through to the declaration the generator
 * emits — tried, and it is simply dropped.
 */
const DISPOSABLE = '/// <reference lib="esnext.disposable" />';

/** Every `.d.ts` under `dir`, however deep the entry points nest them. */
async function declarations(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.d.ts'))
    .map((entry) => join(entry.parentPath, entry.name));
}

export default defineConfig({
  entry: {
    main: 'src/main.ts',
    'xmltv/main': 'src/xmltv/main.ts',
    'm3u/main': 'src/m3u/main.ts',
    'channels/main': 'src/channels/main.ts',
    'cache/main': 'src/cache/main.ts',
    'cache/sqlite': 'src/cache/sqlite-driver.ts',
    'grabber/main': 'src/grabber/main.ts',
    'merge/main': 'src/merge/main.ts',
    'serve/main': 'src/serve/main.ts',
    'tv-grab/main': 'src/tv-grab/main.ts',
    'cli/main': 'src/cli/main.ts',
  },
  // Mirrored by the vitest config, so tests see the same values the build
  // bakes in.
  define: {
    __PKG_NAME__: JSON.stringify(name),
    __PKG_VERSION__: JSON.stringify(version),
  },
  format: ['esm'],
  // `.js`, not tsdown's default `.mjs`: the package is `"type": "module"`, so
  // plain `.js` is already ESM, and the export map and `bin` name these files.
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  platform: 'node',
  // The floor in `engines`, so nothing newer than the oldest Node this runs on
  // is left untranspiled.
  target: 'node20',
  // Spelled out rather than inferred: rolldown-plugin-dts picks its generator
  // from what is installed, and having TypeScript 7 in devDependencies is
  // enough to move declaration emit from `tsc` to the Go compiler. That is the
  // only generator TypeScript 7 can drive — the `tsc` one wants the 5.x/6.x
  // JavaScript API, which 7 does not ship — so it may as well be written down,
  // where a future reader can see it is a choice and not an accident.
  dts: { generator: 'tsgo' },
  sourcemap: true,
  clean: true,
  // The export map is written by hand — one entry per module, documented in
  // docs/api.md — and `bin` with it. Nothing here rewrites package.json.
  exports: false,
  hooks: {
    // See `DISPOSABLE`: the two chunks that name a disposable say so for
    // themselves, so nothing is asked of whoever imports them.
    'build:done': async ({ options }) => {
      const dir = options.outDir;

      await Promise.all(
        (await declarations(dir)).map(async (file) => {
          const text = await readFile(file, 'utf8');

          if (!text.includes('asyncDispose') || text.startsWith(DISPOSABLE)) {
            return;
          }

          await writeFile(file, `${DISPOSABLE}\n${text}`, 'utf8');
        }),
      );
    },
  },
});

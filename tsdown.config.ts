import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsdown';

const { name, version } = JSON.parse(readFileSync('./package.json', 'utf8')) as {
  name: string;
  version: string;
};

export default defineConfig({
  entry: {
    main: 'src/main.ts',
    'xmltv/main': 'src/xmltv/main.ts',
    'cache/main': 'src/cache/main.ts',
    'cache/sqlite': 'src/cache/sqlite-driver.ts',
    'grabber/main': 'src/grabber/main.ts',
    'merge/main': 'src/merge/main.ts',
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
});

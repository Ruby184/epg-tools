import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const { name, version } = JSON.parse(readFileSync('./package.json', 'utf8')) as {
  name: string;
  version: string;
};

export default defineConfig({
  // Mirrors the tsdown `define`, so tests see the same value the build bakes in.
  define: {
    __PKG_NAME__: JSON.stringify(name),
    __PKG_VERSION__: JSON.stringify(version),
  },
  test: {
    include: ['test/**/*.test.ts'],
    benchmark: {
      include: ['bench/**/*.bench.ts'],
      // The getters Vitest warns about are inside `src`'s own cross-module
      // calls (`decodeEntities`, `parseXmltvDate`), not bindings a benchmark
      // could hoist into a local. Benchmarking the sources rather than the
      // bundle is the deliberate trade: the arms all pay the same toll, so the
      // epg-tools arms compare cleanly against each other, and the margin
      // against a prebuilt comparator from node_modules — which pays none of
      // it — is read as a floor rather than a figure.
      suppressExportGetterWarnings: true,
    },
  },
});

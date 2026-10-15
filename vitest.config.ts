import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

const { name, version } = JSON.parse(readFileSync('./package.json', 'utf8')) as {
  name: string;
  version: string;
};

/**
 * The tests that start real worker threads. Apart, because a worker loads this
 * package's source with Node itself rather than through the runner, and needs
 * the flags in `test/fixtures/source-loader.mjs` to — flags no other test
 * should run under.
 */
const THREADS = 'test/threads.test.ts';

export default defineConfig({
  // Mirrors the tsdown `define`, so tests see the same value the build bakes in.
  define: {
    __PKG_NAME__: JSON.stringify(name),
    __PKG_VERSION__: JSON.stringify(version),
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: [...configDefaults.exclude, THREADS],
        },
      },
      {
        extends: true,
        test: {
          name: 'threads',
          include: [THREADS],
          // Inherited by every worker a test starts, which is the point.
          execArgv: [
            '--disable-warning=ExperimentalWarning',
            '--import',
            fileURLToPath(new URL('./test/fixtures/source-loader.mjs', import.meta.url)),
          ],
          // The benchmarks are the other project's to run, once — an empty
          // `include` reads as unset, so this one shuts them out instead.
          benchmark: { exclude: ['**'] },
        },
      },
    ],
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

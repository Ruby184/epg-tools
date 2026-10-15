/**
 * What lets a worker thread run this package from its TypeScript source, for
 * the tests that start real ones (`test/threads.test.ts`).
 *
 * A worker loads its files with Node itself, not with the test runner, so it
 * gets none of what the runner does for the source: the `.js` specifiers the
 * source writes are mapped to the `.ts` files they stand for here, and the two
 * constants the build bakes in are defined. Node's own `--experimental-
 * transform-types`, beside this in the same project's `execArgv`, does the
 * rest — including the enum and the parameter properties type stripping alone
 * refuses. Workers inherit both from the test process that starts them.
 */

import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

const { name, version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
);

globalThis.__PKG_NAME__ = name;
globalThis.__PKG_VERSION__ = version;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith('file:')) {
      const written = new URL(specifier, context.parentURL);
      const source = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);

      if (!existsSync(fileURLToPath(written)) && existsSync(fileURLToPath(source))) {
        return next(source.href, context);
      }
    }

    return next(specifier, context);
  },
});

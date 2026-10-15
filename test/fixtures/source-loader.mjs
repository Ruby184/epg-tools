/**
 * What lets a worker thread run this package from its TypeScript source, for
 * the tests that start real ones (`test/threads.test.ts`).
 *
 * A worker loads its files with Node itself, not with the test runner, so it
 * gets none of what the runner does for the source: the `.js` specifiers the
 * source writes are mapped to the `.ts` files they stand for here, and the two
 * constants the build bakes in are defined. Node strips the types itself —
 * which is all it does from Node 26 on, and why the source is held to
 * `erasableSyntaxOnly`. Workers inherit this from the test process that starts
 * them, through the project's `execArgv`.
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

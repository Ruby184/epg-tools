/**
 * A config module for the thread tests: what a site's worker imports to find
 * its site. Each site is one case in `test/thread.test.ts`.
 */

import { defineConfig } from '../../src/config.js';
import type { SiteConfig } from '../../src/grabber/main.js';
import { xmltvDate } from '../../src/xmltv/main.js';

/** An error as an HTTP client throws one: a name of its own, a code, and a cause. */
class HTTPError extends Error {
  override readonly name = 'HTTPError';
  readonly code = 'E_TEST';
}

const one = [{ xmltvId: 'one', siteId: '1' }];

const sites: SiteConfig<unknown>[] = [
  {
    // A programme in +0200, a note with data a thread cannot be handed, and
    // something remembered for the next run.
    site: 'offset.example',
    channels: one,
    async request() {
      return {};
    },
    parseDay({ day, programme, log, state }) {
      log('parsed', { day, format: () => 'a function' });
      state.set('last', day);

      return [programme(xmltvDate(`${day.replaceAll('-', '')}200000 +0200`), 'Evening')];
    },
  },
  {
    // Its own channel list is a function; the run may have settled another.
    site: 'channels.example',
    channels: () => [{ xmltvId: 'own', siteId: 'own' }],
    async request() {
      return {};
    },
    parseDay({ day, programme }) {
      return [programme(new Date(`${day}T06:00:00.000Z`), 'Morning')];
    },
  },
  {
    site: 'failing.example',
    channels: one,
    async request() {
      throw new HTTPError('Request failed with status code 503', {
        cause: new TypeError('fetch failed'),
      });
    },
    parseDay: () => [],
  },
  {
    // A request that waits until the run is cancelled.
    site: 'slow.example',
    channels: one,
    request: ({ signal }) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    parseDay: () => [],
  },
];

export default defineConfig({ sites, output: 'guide.xml' });

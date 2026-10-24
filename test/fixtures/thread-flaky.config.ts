// A config whose factory fails the first time it is asked — a fetch that did
// not answer — and answers after.
import { defineConfig } from '../../src/config.js';

let asked = 0;

export default defineConfig(() => {
  asked++;

  if (asked === 1) {
    throw new Error('the token service did not answer');
  }

  return {
    output: 'guide.xml',
    sites: [
      {
        site: 'flaky.example',
        channels: [{ xmltvId: 'one', siteId: '1' }],
        async request() {
          return {};
        },
        parseDay: () => [],
      },
    ],
  };
});

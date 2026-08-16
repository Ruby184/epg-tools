import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defineCapability } from '../capability.js';

/**
 * `cache` — where the day cache lives, or whether to keep one at all.
 *
 * XMLTV declares `--cache` as `cache:s`, so its value is optional; an empty
 * string is what a bare `--cache` yields there too, and here it means
 * "wherever the config says", i.e. the same as omitting the option.
 *
 * `--no-cache` is ours. XMLTV has no equivalent because its cache is an
 * optional speed-up, whereas here the cache is how a guide is assembled at
 * all — so "off" means a scratch directory thrown away afterwards: every
 * channel-day refetched, nothing left behind.
 *
 * It shapes the grab instead of claiming the run, so `run` does nothing but
 * register the adjustment.
 */
export const cacheCapability = defineCapability({
  name: 'cache',
  options: {
    cache: {
      type: 'string',
      optionalValue: '',
      negatable: true,
      placeholder: 'DIR',
      description:
        'Keep the day cache in DIR, or --no-cache to grab everything afresh and keep nothing.',
    },
  },
  usage: { grab: ['cache'] },
  run(ctx) {
    ctx.onAdjust(async (config) => {
      if (ctx.values.cache === null) {
        const scratch = await mkdtemp(path.join(tmpdir(), 'epg-tv-grab-'));

        ctx.onFinish(() => rm(scratch, { recursive: true, force: true }));

        return { ...config, cache: { ...config.cache, dir: scratch, prune: false } };
      }

      if (ctx.values.cache) {
        return { ...config, cache: { ...config.cache, dir: path.resolve(ctx.values.cache) } };
      }

      return config;
    });
  },
});

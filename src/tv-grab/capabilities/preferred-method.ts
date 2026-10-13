import { writeLines } from '../../core/streams.js';
import { defineCapability } from '../capability.js';

/**
 * `preferredmethod` — tells the caller how to invoke this grabber.
 *
 * `allatonce` means "ask once for a wide window" rather than looping over
 * `--offset`, which is right here: every run re-reads the whole window out of
 * the cache to merge it, so N calls for one day each cost N merges.
 */
export function preferredMethodCapability(method = 'allatonce') {
  if (method === '') {
    throw new TypeError('The preferredmethod capability needs a non-empty method');
  }

  return defineCapability({
    name: 'preferredmethod',
    options: {
      preferredmethod: {
        type: 'boolean',
        description: 'Print how this grabber prefers to be called.',
      },
    },
    usage: { info: ['preferredmethod'] },
    async run(ctx) {
      if (!ctx.values.preferredmethod) {
        return;
      }

      // Flushed rather than queued: the answer is the whole of what this call
      // produces, and the process exits as soon as it has one.
      await writeLines(ctx.stdout, method);

      return 0;
    },
  });
}

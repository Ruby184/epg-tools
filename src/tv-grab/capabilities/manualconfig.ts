import type { Readable } from 'node:stream';
import { defineCapability } from '../capability.js';
import { createPrompter, runConfigure } from '../configure.js';
import { listChannelChoices } from '../list-channels.js';

// XMLTV requires channel ids to be dotted and DNS-like; tv_validate_file
// reports anything else as `invalidid`.
const CHANNEL_ID = /^[-a-zA-Z0-9]+(\.[-a-zA-Z0-9]+)+$/;

/**
 * `manualconfig` — `--configure`, the interactive walk over the stages.
 *
 * An existing, non-empty configuration is only replaced with the user's
 * consent: as in the reference there is no editing in place, so configuring
 * again starts from scratch.
 */
export const manualConfigCapability = defineCapability({
  name: 'manualconfig',
  options: {
    configure: {
      type: 'boolean',
      description: 'Ask which channels to grab, and remember the answers.',
    },
  },
  usage: { modes: [['configure', 'config-file']] },
  run(ctx) {
    if (!ctx.values.configure) {
      return;
    }

    // Waits for the load, rather than reading the file itself, only to find
    // out whether there is something to overwrite.
    ctx.onConfigLoaded(async (existing) => {
      const prompter = createPrompter(
        (ctx.stdin ?? process.stdin) as Readable,
        ctx.stderr,
        ctx.signal,
      );

      try {
        if (existing !== undefined && Object.keys(existing).length > 0 && prompter.interactive) {
          const answer = await prompter.ask(
            `${ctx.configFile} already exists and cannot be edited in place. Overwrite it? [y/N] `,
          );

          if (!/^y(es)?$/i.test(answer.trim())) {
            return 0;
          }
        }

        const conf = await runConfigure({
          stages: ctx.stages,
          prompter,
          out: ctx.stderr,
          // The answers just given, not an empty configuration: a site that
          // needs the credentials from this very walk to fetch its channel
          // list would otherwise be asked to do it without them.
          channels: async (answers) => listChannelChoices(await ctx.resolveConfig(answers)),
        });

        if (conf === undefined) {
          return 1;
        }

        for (const id of conf.channel ?? []) {
          if (!CHANNEL_ID.test(id)) {
            ctx.warn(
              `Warning: channel id "${id}" is not a valid XMLTV id (expected e.g. one.example.tv)`,
            );
          }
        }

        ctx.replaceConfig(conf);

        // Absent when a stage settled the channels itself, as a lineup does —
        // and "0 channel(s)" would be the wrong way to report that. The
        // framework's own line saying the file was written still appears.
        if (conf.channel !== undefined) {
          ctx.log?.(`Configured ${conf.channel.length} channel(s)`);
        }

        return 0;
      } finally {
        prompter.close();
      }
    });
  },
});

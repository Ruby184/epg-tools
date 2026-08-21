import { defineCapability } from '../capability.js';
import { GrabberError } from '../../core/error.js';
import { listChannelChoices, listChannelsXml } from '../list-channels.js';
import {
  findStage,
  renderSelectChannelsStage,
  renderStageXml,
  SELECT_CHANNELS,
} from '../stages.js';

/**
 * `apiconfig` — the machine-driven counterpart to `--configure`: the caller
 * asks for one stage at a time and does the prompting itself.
 *
 * Both options wait for the configuration to be read, but neither requires one
 * to exist: `--configure-api --stage start` has to work before any does — that
 * is the whole point of the first stage — and `--list-channels` enforces its
 * own requirement, with its own message.
 */
export const apiConfigCapability = defineCapability({
  name: 'apiconfig',
  options: {
    'configure-api': {
      type: 'boolean',
      description: 'Print one configuration stage as XML, for a caller that does the asking.',
    },
    stage: {
      type: 'string',
      default: 'start',
      placeholder: 'NAME',
      description: 'Which stage to print. Defaults to start.',
    },
    'list-channels': {
      type: 'boolean',
      description: 'Print every channel this grabber can deliver, as XMLTV.',
    },
  },
  usage: {
    modes: [
      ['configure-api', 'stage', 'config-file', 'output'],
      ['list-channels', 'config-file', 'output', 'quiet'],
    ],
  },
  run(ctx) {
    const { values } = ctx;

    if (values['configure-api']) {
      ctx.onConfigLoaded(async (conf) => {
        // Every stage but the first may depend on the answers before it.
        if (conf === undefined && values.stage !== 'start') {
          throw new GrabberError(`You need to start configuration with the 'start' stage.`);
        }

        if (values.stage === SELECT_CHANNELS) {
          const channels = await listChannelChoices(await ctx.resolveConfig(conf ?? {}));
          await ctx.emit(renderSelectChannelsStage(channels, ctx.grabberName));
          return 0;
        }

        const stage = findStage(ctx.stages, values.stage);

        if (stage === undefined) {
          throw new GrabberError(`Unknown configuration stage '${values.stage}'`);
        }

        await ctx.emit(renderStageXml(stage, ctx.grabberName));
        return 0;
      });
    } else if (values['list-channels']) {
      ctx.onConfigLoaded(async (conf) => {
        if (conf === undefined) {
          // Its own message: the generic "run --configure" would be less use to
          // a caller that has just been told the grabber supports apiconfig.
          throw new GrabberError(
            'You need to configure the grabber before you can list the channels.',
          );
        }

        // Deliberately the unfiltered config: this lists what *can* be
        // delivered, because the caller uses it to offer a choice.
        await ctx.emit(await listChannelsXml(await ctx.resolveConfig(conf)));
        return 0;
      });
    }
  },
});

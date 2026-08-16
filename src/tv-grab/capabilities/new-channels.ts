import { OptionError } from '../../core/options.js';
import { defineCapability } from '../capability.js';
import { resolveChannelIds } from '../select.js';

/** What to do about channels the configuration has never been asked about. */
export const CHANNEL_UPDATES = ['add', 'ignore', 'notify', 'signal'] as const;

export type ChannelUpdates = (typeof CHANNEL_UPDATES)[number];

/**
 * Exit code for "the grab succeeded, but channels you have never been asked
 * about are on offer" — `--channel-updates signal`, never the default.
 *
 * The proposed capability calls for a "special error code" without naming one.
 * 1 is taken by partial data, and it has to be told apart from that, so 2 is
 * the lowest code left: within this grabber 0 is fine, 1 failed, 2 is fine but
 * worth knowing. (2 conventionally means a usage error elsewhere; here a bad
 * command line exits 1, as the reference does, so nothing is ambiguous.)
 *
 * It is opt-in because nothing implements the proposal — to every existing
 * consumer this is simply a non-zero exit, so a complete, valid guide would be
 * reported as a failed run. Worse, it would fire only on the day a provider
 * added a channel: a pipeline that had worked for months breaking with no
 * local change is the hardest kind of failure to place, and not something to
 * hand anyone by default.
 */
export const NEW_CHANNELS_CODE = 2;

/**
 * `newchannels` — a *proposed* capability: described on the XMLTV wiki, but
 * absent from `XMLTV::Options`, so no reference grabber implements it.
 *
 * A channel counts as new when the configuration mentions it neither as
 * selected (`channel=`) nor as declined (`channel!`) — which is exactly what
 * those bang lines are recorded for.
 *
 * An adjustment rather than a claim on the run: it changes the selection and
 * asks for an exit code, but the grab still happens.
 */
export const newChannelsCapability = defineCapability({
  name: 'newchannels',
  options: {
    'channel-updates': {
      type: 'string',
      default: 'notify',
      placeholder: CHANNEL_UPDATES.join('|'),
      description:
        `What to do about channels that have appeared upstream: report them (notify, the `
        + `default), report them and exit ${NEW_CHANNELS_CODE} (signal), select them (add), `
        + `or say nothing (ignore).`,
      transform: (raw: string, flag: string): ChannelUpdates => {
        if ((CHANNEL_UPDATES as readonly string[]).includes(raw)) {
          return raw as ChannelUpdates;
        }

        throw new OptionError(`Invalid ${flag} value: ${raw} (expected ${CHANNEL_UPDATES.join(', ')})`);
      },
    },
  },
  usage: { grab: ['channel-updates'] },
  run(ctx) {
    const mode = ctx.values['channel-updates'];

    if (mode === 'ignore') {
      return;
    }

    ctx.onAdjust(async (config, { conf, selection }) => {
      if (conf.channel === undefined && conf.no_channel === undefined) {
        // A configuration that records no channel decisions at all is not
        // choosing them by hand — something else is (a lineup), and every
        // channel would count as new, on every run, with "run --configure to
        // include them" as advice that would not include them.
        return config;
      }

      const known = new Set([...(conf.channel ?? []), ...(conf.no_channel ?? [])]);
      const available = await resolveChannelIds(config);
      const added = available.filter((id) => !known.has(id));
      const offered = new Set(available);
      const gone = [...selection].filter((id) => !offered.has(id));

      if (gone.length > 0) {
        // Never dropped automatically: a site whose channel list is fetched can
        // return a short list after a transient failure, and silently deleting
        // selections on that basis would be unrecoverable.
        ctx.warn(`No longer offered, keeping in ${ctx.configFile}: ${gone.join(', ')}`);
      }

      if (added.length === 0) {
        return config;
      }

      if (mode === 'add') {
        for (const id of added) {
          selection.add(id);
        }

        ctx.replaceConfig({ ...conf, channel: [...selection] });
        ctx.log?.(`Added ${added.length} new channel(s) to ${ctx.configFile}: ${added.join(', ')}`);

        return config;
      }

      // The signal itself, so it is printed even under --quiet.
      ctx.warn(`New channel(s) available: ${added.join(', ')} — run --configure to include them`);

      if (mode === 'signal') {
        ctx.setExitCode(NEW_CHANNELS_CODE);
      }

      return config;
    });
  },
});

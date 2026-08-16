import type { EpgConfig } from '../../config.js';
import { defineCapability, type CapabilityContext } from '../capability.js';
import type { GrabberConf } from '../config-file.js';
import { GrabberError } from '../../core/error.js';
import { serializeLineups, type LineupConfig, type LineupsMeta } from '../lineups.js';
import { END, type ConfigStage } from '../stages.js';

/**
 * The lineups a grabber offers: a fixed list, or a function of its `EpgConfig`
 * — which is what {@link lineupsFromSites} is, so `lineupsCapability(lineupsFromSites)`
 * is the whole of the simple case.
 */
export type LineupSource =
  | readonly LineupConfig[]
  | ((config: EpgConfig) => LineupConfig[] | Promise<LineupConfig[]>);

/** The stage that asks which lineup, and the key it is recorded under. */
const LINEUP = 'lineup';

/**
 * Resolve the lineups, at most once per run and only where one is needed:
 * `--list-lineups`, `--get-lineup` and configuring need them, a plain grab of a
 * channel-configured grabber does not, and the function form may reach the
 * network for a site's channel list.
 */
async function resolveLineups(
  source: LineupSource,
  ctx: CapabilityContext,
  conf: GrabberConf,
): Promise<LineupConfig[]> {
  if (typeof source !== 'function') {
    return [...source];
  }

  return source(await ctx.resolveConfig(conf));
}

/** What a chooser shows for a lineup. */
function titleOf(lineup: LineupConfig): string {
  return lineup.displayName[0]?.value ?? lineup.id;
}

/** The configured lineup, or the reason there is not one. */
async function chosenLineup(
  source: LineupSource,
  ctx: CapabilityContext,
  conf: GrabberConf,
): Promise<LineupConfig> {
  const id = conf[LINEUP]?.[0];

  if (id === undefined) {
    throw new GrabberError(`No lineup is configured in ${ctx.configFile}; run --configure`);
  }

  const lineup = (await resolveLineups(source, ctx, conf)).find((entry) => entry.id === id);

  if (lineup === undefined) {
    // The offer can change under a configuration that was written months ago,
    // so this is news rather than a bug: name what was asked for.
    throw new GrabberError(`Configured lineup "${id}" is not one this grabber offers`);
  }

  return lineup;
}

/** The question to ask while configuring, built from the lineups on offer. */
function lineupStage(lineups: readonly LineupConfig[]): ConfigStage {
  const [only] = lineups;

  if (only === undefined) {
    throw new GrabberError('This grabber offers no lineups to choose from');
  }

  const description = 'Which lineup to grab. Its channels are then grabbed as a set.';

  return {
    name: LINEUP,
    // Not `select-channels`: a lineup *is* the channel selection, so asking
    // again would be asking the same question twice with different answers.
    next: END,
    fields: [lineups.length === 1
      // Nothing to choose between, but the answer still has to be recorded —
      // which is what a constant is: written to the configuration, never asked.
      ? { type: 'string', id: LINEUP, title: 'Lineup', description, constant: only.id }
      : {
        type: 'selectone',
        id: LINEUP,
        title: 'Lineup',
        description,
        options: lineups.map((lineup) => ({ value: lineup.id, text: titleOf(lineup) })),
      }],
  };
}

/**
 * `lineups` — the channel lineups a grabber can deliver, as
 * `xmltv-lineups.xsd` documents.
 *
 * Opt-in, because it needs data no grabber has by default: pass the lineups to
 * the factory and add the result to `capabilities`.
 *
 * ```ts
 * capabilities: [...DEFAULT_CAPABILITIES, lineupsCapability(lineupsFromSites)]
 * ```
 *
 * It reaches three points at once, which is why it is one capability and not
 * three: `--list-lineups` answers before any configuration is read, as the
 * reference orders it — a caller uses it to *choose* — while `--get-lineup`
 * requires one, and a configured lineup then decides which channels are
 * grabbed, in place of the per-channel selection.
 */
export function lineupsCapability(source: LineupSource, meta?: LineupsMeta) {
  return defineCapability({
    name: 'lineups',
    options: {
      'list-lineups': {
        type: 'boolean',
        description: 'Print every channel lineup this grabber can deliver.',
      },
      'get-lineup': {
        type: 'boolean',
        description: 'Print the lineup the configuration selected.',
      },
    },
    usage: {
      modes: [
        ['list-lineups', 'output'],
        ['get-lineup', 'config-file', 'output'],
      ],
    },
    async run(ctx) {
      if (ctx.values['list-lineups']) {
        // No configuration is read for this, deliberately: a caller asks what
        // is on offer before there is anything to configure with.
        const lineups = await resolveLineups(source, ctx, {});

        if (lineups.length === 0) {
          throw new GrabberError('This grabber offers no lineups to choose from');
        }

        await ctx.emit(serializeLineups(lineups, meta));
        return 0;
      }

      if (ctx.values['get-lineup']) {
        ctx.onConfigLoaded(async (conf) => {
          if (conf === undefined) {
            throw new GrabberError(
              'You need to configure the grabber before you can output your chosen lineup.',
            );
          }

          await ctx.emit(serializeLineups([await chosenLineup(source, ctx, conf)], meta));
          return 0;
        });

        return;
      }

      // Only the two configuration modes render stages, and building the stage
      // means resolving the lineups — which a grab should not pay for. Both
      // options belong to other capabilities, so they may not be there at all;
      // then there is no configuring to do and nothing to add.
      const configuring = ctx.values as Record<string, unknown>;

      if (configuring['configure'] === true || configuring['configure-api'] === true) {
        ctx.addStage(lineupStage(await resolveLineups(source, ctx, {})));
        return;
      }

      ctx.onAdjust(async (config, { conf, selection }) => {
        // A configuration written before this grabber offered lineups still
        // names its channels one by one, and goes on working.
        if (conf[LINEUP] === undefined) {
          return config;
        }

        const lineup = await chosenLineup(source, ctx, conf);

        // Replaces rather than adds: the lineup is the selection.
        selection.clear();

        for (const entry of lineup.entries) {
          selection.add(entry.station.xmltvId);
        }

        ctx.log?.(`Lineup ${titleOf(lineup)}: ${selection.size} channel(s)`);

        return config;
      });
    },
  });
}

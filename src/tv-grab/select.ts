import type { EpgConfig } from '../config.js';
import { resolveChannels } from '../grabber/channels.js';
import type { AnySiteConfig, GrabberChannel } from '../grabber/types.js';
import { resolveDeclarations } from '../merge/derive.js';
import type { DerivedChannel } from '../merge/types.js';

/**
 * Restrict every site to the selected channel ids.
 *
 * A site's `channels` may be a function, so filtering stays lazy: resolving it
 * here would fire a site's remote channel-list request during option handling,
 * which `--capabilities` and friends must never trigger. Sites left with no
 * channels are dropped, which is only decidable for the eager form.
 */
export function applyChannelSelection(config: EpgConfig, selected: Set<string>): EpgConfig {
  const { derived, wanted } = selectDerived(config.derived, selected);
  const sites: AnySiteConfig[] = [];

  for (const site of config.sites) {
    if (typeof site.channels === 'function') {
      const resolve = site.channels;

      sites.push({
        ...site,
        channels: async (ctx): Promise<GrabberChannel[]> =>
          (await resolve(ctx)).filter((channel) => wanted.has(channel.xmltvId)),
      });

      continue;
    }

    const channels = site.channels.filter((channel) => wanted.has(channel.xmltvId));

    if (channels.length > 0) {
      sites.push({ ...site, channels });
    }
  }

  return { ...config, sites, ...(config.derived === undefined ? {} : { derived }) };
}

/**
 * The `derived` declarations a selection keeps, and every channel id that has to
 * be grabbed for them.
 *
 * Two things a plain filter gets wrong. A derived channel is never grabbed — its
 * source is — so selecting `X+1` has to keep `X` even though nobody asked for
 * it; and a selection that keeps `X` alone must not leave `X+1` behind, which a
 * filter on the sites cannot do anything about.
 *
 * An unselected declaration in the middle of a chain is flattened rather than
 * kept: `X+2` shifting a dropped `X+1` becomes `X+2` shifting `X` by both
 * offsets, since a shift of a shift is one shift. Lexical throughout — nothing
 * here resolves a site's channel list, which option handling must never do.
 */
function selectDerived(
  declarations: readonly DerivedChannel[] | undefined,
  selected: Set<string>,
): { derived: DerivedChannel[]; wanted: Set<string> } {
  const wanted = new Set(selected);

  if (declarations === undefined || declarations.length === 0) {
    return { derived: [], wanted };
  }

  const byId = new Map(declarations.map((declaration) => [declaration.xmltvId, declaration]));
  const kept = declarations.filter((declaration) => selected.has(declaration.xmltvId));
  const keptIds = new Set(kept.map((declaration) => declaration.xmltvId));

  const derived = kept.map((declaration) => {
    const seen = new Set([declaration.xmltvId]);
    let { from, offset } = declaration;

    while (byId.has(from) && !keptIds.has(from) && !seen.has(from)) {
      const step = byId.get(from)!;

      seen.add(from);
      offset += step.offset;
      from = step.from;
    }

    // Whatever the chain ends at has to survive the filter below. A kept
    // derivation is already selected; a real channel may not be, and is added.
    wanted.add(from);

    return { ...declaration, from, offset };
  });

  return { derived, wanted };
}

/** Every channel id a config can deliver, in site priority order, deduplicated. */
export async function resolveChannelIds(config: EpgConfig): Promise<string[]> {
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const site of config.sites) {
    const channels = await resolveChannels(site);

    for (const channel of channels) {
      if (!seen.has(channel.xmltvId)) {
        seen.add(channel.xmltvId);
        ids.push(channel.xmltvId);
      }
    }
  }

  if (config.derived?.length) {
    // After the real ones, and counted the same: a selection offering them, and
    // `--channel-updates` not calling them "no longer offered" every run.
    for (const { declaration } of resolveDeclarations(config.derived, seen, new Set())) {
      if (!seen.has(declaration.xmltvId)) {
        seen.add(declaration.xmltvId);
        ids.push(declaration.xmltvId);
      }
    }
  }

  return ids;
}

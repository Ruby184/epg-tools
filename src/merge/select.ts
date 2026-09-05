/**
 * What a channel selection means.
 *
 * Here rather than beside the config or the CLI because the hard half is the
 * *derived* rules, which live next door in `derive.ts` — and because the merge
 * needs it, so anywhere further up would be a cycle.
 *
 * Nothing here resolves a site's channel list. It is lexical throughout, which
 * is what lets option handling ask the question without firing a request.
 */

import type { DerivedChannel } from './types.js';

/** The two fields a selection reads. `EpgConfig` and `BuildGuideOptions` both fit. */
export interface Selectable {
  channels?: readonly string[];
  derived?: readonly DerivedChannel[];
}

/** What a selection amounts to once its derived channels are accounted for. */
export interface ChannelSelection {
  /** Every id to keep, including sources kept only for something derived. */
  select: ReadonlySet<string>;
  /** The `derived` declarations that survive it, flattened where they must be. */
  derived: DerivedChannel[];
}

/**
 * What `channels` means once `derived` is taken into account, or `undefined` for
 * a config that selects nothing and therefore keeps everything.
 *
 * Two things a plain filter gets wrong. A derived channel is never grabbed — its
 * source is — so selecting `X+1` has to keep `X` even though nobody asked for
 * it; and a selection that keeps `X` alone must not leave `X+1` behind, which a
 * filter on the sites cannot do anything about.
 *
 * An unselected declaration in the middle of a chain is flattened rather than
 * kept: `X+2` shifting a dropped `X+1` becomes `X+2` shifting `X` by both
 * offsets, since a shift of a shift is one shift.
 *
 * Idempotent, which is what lets every caller ask rather than pass the answer
 * around: run against a config whose `channels` already carries the sources this
 * added, it adds them again to no effect.
 */
export function channelSelection(config: Selectable): ChannelSelection | undefined {
  if (config.channels === undefined) {
    return undefined;
  }

  const selected = new Set(config.channels);
  const declarations = config.derived;
  const wanted = new Set(selected);

  if (declarations === undefined || declarations.length === 0) {
    return { select: wanted, derived: [] };
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

    // Whatever the chain ends at has to survive the filter. A kept derivation is
    // already selected; a real channel may not be, and is added.
    wanted.add(from);

    return { ...declaration, from, offset };
  });

  return { select: wanted, derived };
}

/**
 * The selected ids nothing produced, for a caller that can now say so.
 *
 * The question only makes sense against a selection: an id absent from a guide
 * that selected nothing is not missing, it is simply a channel this config does
 * not carry. So no selection means nothing to report.
 */
export function unmatched(
  selection: ChannelSelection | undefined,
  produced: Iterable<string>,
): string[] {
  if (selection === undefined) {
    return [];
  }

  const has = produced instanceof Set ? produced : new Set(produced);
  // A derived channel is produced by the guide rather than by any site, and one
  // whose source is missing has already been reported by `resolveDeclarations`
  // in its own words. Saying it again here would be the same news twice.
  const derived = new Set(selection.derived.map((declaration) => declaration.xmltvId));

  return [...selection.select].filter((id) => !has.has(id) && !derived.has(id));
}

/** How the shortfall is put, wherever it is noticed. */
export function unmatchedMessage(missing: readonly string[], wanted: number): string {
  return (
    `${missing.length} of ${wanted} selected channels are produced by no site — ` +
    `${missing.join(', ')}. \`epg channels --against <file>\` says what they look like.`
  );
}

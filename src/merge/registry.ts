/**
 * What one output `<channel>` is made of.
 *
 * Its own module because two things need the shape: the guide, which builds the
 * registry from the configured sites, and {@link file://./derive.ts | derive},
 * which adds entries whose programmes come from another entry rather than from
 * a site of their own.
 */

import type { AnySiteConfig, GrabberChannel } from '../grabber/types.js';
import type { DerivedChannel } from './types.js';

/** One site's claim on a channel: its config, and the channel as that site has it. */
export interface ChannelSource {
  config: AnySiteConfig;
  channel: GrabberChannel;
}

/**
 * Where a derived entry's programmes really come from: another entry, and how
 * far along to move them.
 *
 * The source is always a real entry — a chain of derivations is resolved to its
 * root with the offsets summed, since a shift of a shift is one shift.
 */
export interface DerivedFrom {
  source: RegistryEntry;
  offsetMs: number;
  /** What declared it, for the `<channel>` element it publishes. */
  declaration: DerivedChannel;
}

/** One output `<channel>` with its covering sites in priority order. */
export interface RegistryEntry {
  xmltvId: string;
  sources: ChannelSource[];
  /**
   * Set when this channel is another one shifted.
   *
   * A derived entry has no `sources` of its own. It reads the source entry's, so
   * a channel derived from one that several sites cover is merged exactly as its
   * source is and only then shifted — which is what makes "derived from an
   * already merged channel" fall out rather than being a case of its own.
   */
  derivedFrom?: DerivedFrom;
}

/** A registry entry that is a derivation, so {@link DerivedFrom} is known present. */
export type DerivedEntry = RegistryEntry & { derivedFrom: DerivedFrom };

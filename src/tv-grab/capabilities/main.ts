import type { CapabilityEntry } from '../capability.js';
import { apiConfigCapability } from './apiconfig.js';
import { cacheCapability } from './cache.js';
import { manualConfigCapability } from './manualconfig.js';
import { newChannelsCapability } from './new-channels.js';
import { preferredMethodCapability } from './preferred-method.js';

export { apiConfigCapability } from './apiconfig.js';
export { cacheCapability } from './cache.js';
export { lineupsCapability } from './lineups.js';
export type { LineupSource } from './lineups.js';
export { manualConfigCapability } from './manualconfig.js';
export { newChannelsCapability, CHANNEL_UPDATES, NEW_CHANNELS_CODE } from './new-channels.js';
export type { ChannelUpdates } from './new-channels.js';
export { preferredMethodCapability } from './preferred-method.js';

/**
 * What a grabber advertises unless it says otherwise.
 *
 * `baseline` is a bare name rather than a definition: it is not a plug-in but
 * the thing capabilities plug into — the grab itself, plus the options the
 * framework consumes (`--days`, `--offset`, `--output`, `--quiet`, `--debug`,
 * `--config-file`).
 */
export const DEFAULT_CAPABILITIES: readonly CapabilityEntry[] = [
  'baseline',
  manualConfigCapability,
  apiConfigCapability,
  cacheCapability,
  preferredMethodCapability(),
  newChannelsCapability,
];

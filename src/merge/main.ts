export {
  DEFAULT_MATCH,
  mergeInto,
  mergeProgrammes,
  mergeProgrammeLists,
  normalizeTitle,
  resolveMatch,
  titlesMatch,
} from './programme.js';
export type { ResolvedMatch } from './programme.js';
export { mergeChannels } from './channel.js';
export { generateGuide, writeGuide, defaultChannelInfo } from './guide.js';
export { channelSelection, unmatched } from './select.js';
export type { ChannelSelection, Selectable } from './select.js';
export type * from './types.js';

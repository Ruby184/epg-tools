export { defineConfig, resolveConfigSource } from './config.js';
export type {
  CacheDriverFactory,
  ConfigFactory,
  ConfigSource,
  DefineConfigOptions,
  EpgCacheConfig,
  EpgConfig,
  ResolvableConfig,
} from './config.js';
export { createConfigContext, defaultsReader, envReader } from './core/answers.js';
export type { ConfigContext, ConfigReader, StageDefaults } from './core/answers.js';
export { GrabberError } from './core/error.js';
export { build, runGrab, runMerge, guideStream, createCacheStore } from './build.js';
export type { RunOptions } from './build.js';

export { toDayString, dayToDate, addDays, diffDays, dayRange } from './core/days.js';
export { parseOptions, OptionError } from './core/options.js';
export type {
  BooleanSpec,
  NumberSpec,
  OptionSpec,
  ParsedValues,
  ParseOptionsResult,
  StringSpec,
} from './core/options.js';

export {
  escapeXml,
  formatXmltvDate,
  getXmltvOffset,
  getXmltvPrecision,
  parseXmltvDate,
  setXmltvOffset,
  setXmltvPrecision,
  xmltvDate,
  XmltvDateError,
  XMLTV_OFFSET,
  XMLTV_PRECISION,
  serializeChannel,
  serializeProgramme,
  writeXmltvStream,
  writeXmltvToFile,
  parseXmltvStream,
  parseXmltvFile,
  xmltvZone,
  xmltvZoneOffset,
  zonedXmltvDate,
  setXmltvZone,
} from './xmltv/main.js';
export type {
  DateInput,
  FormatXmltvDateOptions,
  XmltvDate,
  XmltvDateOptions,
  XmltvTimezoneOffsets,
} from './xmltv/main.js';
export type * from './xmltv/types.js';

export {
  CacheManager,
  FsCacheDriver,
  FsNdjsonCacheDriver,
  FsXmltvCacheDriver,
  CacheDriverBase,
  isStale,
  DEFAULT_STALENESS,
  CACHE_DRIVER_NAMES,
} from './cache/main.js';
export type * from './cache/types.js';

export {
  grab,
  channelElement,
  defineSiteConfig,
  resolveChannels,
  resolveSites,
  retryAfterMs,
  siteHttp,
  sitePacing,
} from './grabber/main.js';
export type * from './grabber/types.js';

export {
  DEFAULT_MATCH,
  mergeInto,
  mergeProgrammes,
  mergeProgrammeLists,
  normalizeTitle,
  resolveMatch,
  titlesMatch,
  generateGuide,
  writeGuide,
  defaultChannelInfo,
} from './merge/main.js';
export type { ResolvedMatch } from './merge/main.js';
export type * from './merge/types.js';

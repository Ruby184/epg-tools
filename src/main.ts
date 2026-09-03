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
export { errorChain, errorMessage, GrabberError } from './core/error.js';
export { atLevel, emitter, EVENT_KINDS, LEVELS } from './core/events.js';
export type {
  Emit,
  EpgEvent,
  EpgEventInput,
  EpgEventType,
  EventKind,
  EventLevel,
  GrabCounts,
  ReportedOptions,
  Reporter,
  RunPhase,
} from './core/events.js';
export {
  DEFAULT_FAILURE_CAP,
  FAILURE_MODES,
  isFailure,
  jsonReporter,
  progressReporter,
  render,
  renderFailure,
  reporterFor,
  REPORTER_NAMES,
  textReporter,
} from './core/reporters.js';
export type {
  FailureEvent,
  FailureMode,
  JsonReporterOptions,
  ProgressReporterOptions,
  ReporterFactory,
  ReporterName,
  ReporterRuntime,
  TextReporterOptions,
} from './core/reporters.js';
export type { CompressionFormat, CompressionOptions } from './core/output.js';
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
  ExtensionFilter,
  ExtensionRef,
  FormatXmltvDateOptions,
  SerializeOptions,
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
  channelsMaxAgeMs,
  defineSiteConfig,
  defineStreamSiteConfig,
  defineXmltvSite,
  DEFAULT_CHANNELS_MAX_AGE_DAYS,
  resolveChannels,
  resolveSites,
  retryAfterMs,
  isUnchanged,
  siteHttp,
  sitePacing,
  SiteStateHandle,
  StateKey,
  TrackedMap,
  UnchangedError,
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

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
export { atLevel, emitter, EVENT_KINDS, LEVELS, PHASES } from './core/events.js';
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
  SaidFields,
  Says,
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
  validateXmltv,
  xmltvZone,
  xmltvZoneOffset,
  zonedXmltvDate,
  setXmltvZone,
} from './xmltv/main.js';
export type {
  DateInput,
  ExtensionFilter,
  FindingCode,
  FindingSeverity,
  ValidateOptions,
  ValidationFinding,
  ValidationReport,
  ExtensionRef,
  FormatXmltvDateOptions,
  SerializeOptions,
  XmltvDate,
  XmltvDateOptions,
  XmltvTimezoneOffsets,
} from './xmltv/main.js';
export type * from './xmltv/types.js';

export {
  M3uParseStream,
  M3uSerializeStream,
  parseM3uFile,
  parseM3uStream,
  parseM3uString,
  serializeM3uEntry,
  serializeM3uHeader,
  writeM3uStream,
  writeM3uToFile,
} from './m3u/main.js';
export type {
  M3uAttributeOptions,
  M3uParseStreamOptions,
  M3uSerializeOptions,
  M3uSerializeStreamOptions,
  M3uStreamInput,
  M3uWriteOptions,
} from './m3u/main.js';
// Named rather than `export type *`, which the other modules use: `src/m3u` is
// hermetic and so declares its own `AnyIterable`, and two star re-exports of the
// same name resolve to neither — the root would quietly stop exporting a type it
// exports today. The two declarations are identical, so xmltv's stands for both.
export type {
  M3uCharset,
  M3uDirective,
  M3uEntry,
  M3uHeader,
  M3uParseEvent,
  M3uParseOptions,
  M3uPlaylist,
  M3uWarning,
} from './m3u/types.js';

export {
  matchChannels,
  parseChannelList,
  serializeChannelList,
  timeshiftOf,
} from './channels/main.js';
export type {
  Candidate,
  ChannelList,
  ChannelListEntry,
  ChannelListWarning,
  ChannelMatch,
  ChannelMatchKind,
  ChannelMatchResult,
  WriteChannelListOptions,
} from './channels/main.js';

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
  channelsFromM3u,
  channelsMaxAgeMs,
  defineM3uSite,
  guideUrlsFromM3u,
  defineSiteConfig,
  defineStreamSiteConfig,
  defineXmltvSite,
  DEFAULT_CHANNELS_MAX_AGE_DAYS,
  fellShort,
  resolveAllowance,
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
export type {
  M3uChannelData,
  M3uChannelsOptions,
  M3uSiteOptions,
  M3uSkipReason,
  MissingAllowance,
  ResolvedAllowance,
} from './grabber/main.js';
export type * from './grabber/types.js';

export { serveGuide } from './serve/main.js';
export type { EpgServeConfig, GuideServer, ServeOptions } from './serve/main.js';

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

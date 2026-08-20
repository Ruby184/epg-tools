/**
 * Channel lineups — `xmltv-lineups.xsd`, the document `--list-lineups` and
 * `--get-lineup` return.
 *
 * A lineup is a *reception platform* (a DVB multiplex, a set-top box package,
 * an IPTV bouquet, or just a list), which is why it is a concept of its own and
 * not a `SiteConfig`: a site is where data comes from, and one lineup is
 * normally fed by several of them. Configuring a lineup also **replaces**
 * per-channel selection — the reference skips channel selection outright once
 * `lineup=` is set — so the two cannot be the same thing without pinning a user
 * to one site.
 *
 * The schema is unusually strict: every complex type is an `xs:sequence`, so
 * element order is not a matter of taste, and the four delivery branches are an
 * `xs:choice`, so one entry may describe only one kind of delivery. Both are
 * enforced here rather than left to whoever validates the output.
 */

import type { EpgConfig } from '../config.js';
import { resolveChannels } from '../grabber/channels.js';
import type { GrabberChannel } from '../grabber/types.js';
import { escapeXml } from '../xmltv/escape.js';

/** How the lineup is received. Required on every lineup. */
export type LineupType = 'DTV' | 'STB' | 'IPTV' | 'Analog' | 'List';

/** What a station carries. */
export type StationType = 'TV' | 'Radio' | 'Data' | 'Text service';

/** How widely a lineup or an entry is available. */
export type AvailabilityArea = 'country' | 'region' | 'city' | 'postcode' | 'transmitter';

export interface LineupText {
  value: string;
  lang?: string;
}

export interface LineupLogo {
  url?: string;
  width?: number;
  height?: number;
}

export interface LineupAvailability {
  value: string;
  area?: AvailabilityArea;
}

/** A subscription package an entry belongs to, e.g. `Basic`. */
export interface LineupPackage {
  value: string;
  type?: string;
}

/**
 * The channel itself, as opposed to how it is delivered.
 *
 * {@link xmltvId} becomes the `rfc2838` attribute, which is the join with the
 * guide: it is the same id as `<channel id>`, so a consumer can match a lineup
 * entry to the programmes for it.
 */
export interface LineupStation {
  xmltvId: string;
  /** Defaults to {@link xmltvId} — the schema requires a name. */
  name?: string;
  shortName?: string;
  /** Applied to both names. */
  lang?: string;
  logo?: LineupLogo[];
  type?: StationType;
  commercialFree?: boolean;
  video?: { format?: string; aspectRatio?: string };
  audio?: { format?: string };
}

/** A DVB service: the triplet, plus what the NIT and SDT say about it. */
export interface DvbChannel {
  originalNetworkId: number;
  transportId?: number;
  serviceId: number;
  /** Logical channel number, from the NIT — not the guide's `<lcn>` extension. */
  lcn?: string;
  serviceName?: string;
  providerName?: string;
  encrypted?: boolean;
}

/** A set-top box channel: the number to key in. */
export interface StbChannel {
  preset: string;
}

export interface IptvChannel {
  url: string;
  port: number;
}

export interface AnalogChannel {
  /** The broadcast system, e.g. `PAL-B/G`. */
  system: string;
  /** The channel designation, e.g. `E7` — a string, not a number. */
  number: string;
  /** In kHz. */
  frequency?: number;
  fccCallsign?: string;
  /** The teletext packet 8/30/1 country and network identifier. */
  cni?: string;
}

/**
 * One channel in a lineup: what it is, and — at most one kind — how it is
 * received.
 */
export interface LineupEntry {
  station: LineupStation;
  /** The number it appears on. */
  preset?: string;
  /** A grouping within the lineup, e.g. `Entertainment`. */
  section?: string;
  packages?: LineupPackage[];
  availability?: LineupAvailability[];
  dvb?: DvbChannel[];
  stb?: StbChannel[];
  iptv?: IptvChannel[];
  analog?: AnalogChannel[];
}

export interface LineupConfig {
  id: string;
  type: LineupType;
  /** At least one is required; the first is what a chooser shows. */
  displayName: LineupText[];
  logo?: LineupLogo[];
  availability?: LineupAvailability[];
  entries: LineupEntry[];
}

/**
 * Where the document came from — the `sourceGeneratorAttrs` group, which is the
 * same set the guide's `<tv>` element carries, plus `modified`.
 */
export interface LineupsMeta {
  /** When the lineups last changed, as an XMLTV timestamp. */
  modified?: string;
  sourceInfoName?: string;
  sourceInfoUrl?: string;
  sourceDataUrl?: string;
  generatorInfoName?: string;
  generatorInfoUrl?: string;
}

type AttrValue = string | number | boolean | undefined;

function attr(name: string, value: AttrValue): string {
  return value === undefined ? '' : ` ${name}="${escapeXml(String(value))}"`;
}

function attrs(pairs: [string, AttrValue][]): string {
  return pairs.map(([name, value]) => attr(name, value)).join('');
}

function metaAttrs(meta: LineupsMeta | undefined): string {
  return attrs([
    ['modified', meta?.modified],
    ['source-info-name', meta?.sourceInfoName],
    ['source-info-url', meta?.sourceInfoUrl],
    ['source-data-url', meta?.sourceDataUrl],
    ['generator-info-name', meta?.generatorInfoName],
    ['generator-info-url', meta?.generatorInfoUrl],
  ]);
}

/**
 * `<name attrs>text</name>`, or nothing at all when there is no value.
 *
 * A boolean is written as `true`/`false`, which is what `xs:boolean` wants —
 * and why `false` has to be told apart from "not given" rather than skipped.
 */
function el(indent: string, name: string, value: AttrValue, tagAttrs = ''): string {
  return value === undefined ? '' : `${indent}<${name}${tagAttrs}>${escapeXml(String(value))}</${name}>\n`;
}

function logos(indent: string, all: LineupLogo[] | undefined): string {
  return (all ?? []).map((logo) =>
    `${indent}<logo${attrs([['url', logo.url], ['height', logo.height], ['width', logo.width]])} />\n`,
  ).join('');
}

function availability(indent: string, all: LineupAvailability[] | undefined): string {
  return (all ?? []).map((entry) =>
    el(indent, 'availability', entry.value, attr('area', entry.area)),
  ).join('');
}

/** `<station>` — a strict sequence, so the order here is the schema's. */
function serializeStation(station: LineupStation, indent: string): string {
  const inner = `${indent}  `;
  const lang = attr('lang', station.lang);

  let out = `${indent}<station${attr('rfc2838', station.xmltvId)}${attr('type', station.type)}>\n`;

  // Required by the schema, and the id is the only thing certain to be there.
  out += el(inner, 'name', station.name ?? station.xmltvId, lang);
  out += el(inner, 'short-name', station.shortName, lang);
  out += logos(inner, station.logo);
  out += el(inner, 'commercial-free', station.commercialFree);

  if (station.video !== undefined) {
    out += `${inner}<video>\n`;
    out += el(`${inner}  `, 'format', station.video.format);
    out += el(`${inner}  `, 'aspect-ratio', station.video.aspectRatio);
    out += `${inner}</video>\n`;
  }

  if (station.audio !== undefined) {
    out += `${inner}<audio>\n`;
    out += el(`${inner}  `, 'format', station.audio.format);
    out += `${inner}</audio>\n`;
  }

  return `${out}${indent}</station>\n`;
}

function serializeDvb(channel: DvbChannel, indent: string): string {
  const inner = `${indent}  `;

  return `${indent}<dvb-channel>\n`
    + el(inner, 'original-network-id', channel.originalNetworkId)
    + el(inner, 'transport-id', channel.transportId)
    + el(inner, 'service-id', channel.serviceId)
    + el(inner, 'lcn', channel.lcn)
    + el(inner, 'service-name', channel.serviceName)
    + el(inner, 'provider-name', channel.providerName)
    + el(inner, 'encrypted', channel.encrypted)
    + `${indent}</dvb-channel>\n`;
}

function serializeAnalog(channel: AnalogChannel, indent: string): string {
  const inner = `${indent}  `;

  return `${indent}<analog-channel>\n`
    + el(inner, 'system', channel.system)
    + el(inner, 'number', channel.number)
    + el(inner, 'frequency', channel.frequency)
    + el(inner, 'fcc-callsign', channel.fccCallsign)
    // Alone among the optional-looking elements this one is not: the schema
    // leaves `minOccurs` off it, so an analog channel without a `<cni>` does
    // not validate. It is an empty element carrying an attribute, so an
    // unknown identifier is written as the empty tag rather than omitted.
    + `${inner}<cni${attr('tt-8-30-1', channel.cni)} />\n`
    + `${indent}</analog-channel>\n`;
}

/** The delivery branch, and the check that there is only one of them. */
function serializeDelivery(entry: LineupEntry, indent: string): string {
  const branches: [string, unknown[] | undefined][] = [
    ['dvb', entry.dvb],
    ['stb', entry.stb],
    ['iptv', entry.iptv],
    ['analog', entry.analog],
  ];

  const used = branches.filter(([, value]) => value !== undefined && value.length > 0);

  if (used.length > 1) {
    // An xs:choice: a station is reached one way per lineup, and a document
    // saying otherwise would be rejected by anything that validates it.
    throw new TypeError(
      `Lineup entry for "${entry.station.xmltvId}" describes ${used.map(([name]) => name).join(' and ')}`
      + ` delivery; an entry may describe only one kind`,
    );
  }

  return (entry.dvb ?? []).map((channel) => serializeDvb(channel, indent)).join('')
    + (entry.stb ?? []).map((channel) =>
      `${indent}<stb-channel>\n${el(`${indent}  `, 'stb-preset', channel.preset)}${indent}</stb-channel>\n`,
    ).join('')
    + (entry.iptv ?? []).map((channel) =>
      `${indent}<iptv-channel>\n`
      + el(`${indent}  `, 'iptv-url', channel.url)
      + el(`${indent}  `, 'port', channel.port)
      + `${indent}</iptv-channel>\n`,
    ).join('')
    + (entry.analog ?? []).map((channel) => serializeAnalog(channel, indent)).join('');
}

function serializeEntry(entry: LineupEntry, indent: string): string {
  const inner = `${indent}  `;

  return `${indent}<lineup-entry>\n`
    + el(inner, 'preset', entry.preset)
    + el(inner, 'section', entry.section)
    + (entry.packages ?? []).map((pkg) => el(inner, 'package', pkg.value, attr('type', pkg.type))).join('')
    + availability(inner, entry.availability)
    + serializeStation(entry.station, inner)
    + serializeDelivery(entry, inner)
    + `${indent}</lineup-entry>\n`;
}

/** One `<xmltv-lineup>` element, indented for placing in a document. */
export function serializeLineup(lineup: LineupConfig, indent = '  '): string {
  const inner = `${indent}  `;

  let out = `${indent}<xmltv-lineup${attr('id', lineup.id)}>\n`;

  out += el(inner, 'type', lineup.type);
  out += lineup.displayName.map((name) =>
    el(inner, 'display-name', name.value, attr('lang', name.lang))).join('');
  out += logos(inner, lineup.logo);
  out += availability(inner, lineup.availability);
  out += lineup.entries.map((entry) => serializeEntry(entry, inner)).join('');

  return `${out}${indent}</xmltv-lineup>\n`;
}

/** The whole `xmltv-lineups` document — what `--list-lineups` prints. */
export function serializeLineups(
  lineups: readonly LineupConfig[],
  meta?: LineupsMeta,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n`
    + `<xmltv-lineups${metaAttrs(meta)}>\n`
    + lineups.map((lineup) => serializeLineup(lineup)).join('')
    + `</xmltv-lineups>\n`;
}

export interface LineupsFromSitesOptions {
  /** What the sites are as platforms. Defaults to `List` — a plain channel list. */
  type?: LineupType;
  /** Language of the generated names. */
  lang?: string;
}

function stationOf(channel: GrabberChannel, lang: string | undefined): LineupStation {
  // The channel's own language wins; the option is the fallback for a site
  // whose channels do not carry one.
  const language = channel.lang ?? lang;

  return {
    xmltvId: channel.xmltvId,
    ...(channel.name === undefined ? {} : { name: channel.name }),
    ...(language === undefined ? {} : { lang: language }),
    ...(channel.logo === undefined ? {} : { logo: [{ url: channel.logo }] }),
  };
}

/**
 * One lineup per site, for the case where a grabber's sites genuinely are
 * separate platforms — a convenience, not the model: sites are usually several
 * sources feeding *one* lineup, and that has to be written out by hand.
 *
 * `List` by default, since a site says nothing about how its channels are
 * received, and a `List` lineup is the schema's way of saying just that.
 */
export async function lineupsFromSites(
  config: EpgConfig,
  options: LineupsFromSitesOptions = {},
): Promise<LineupConfig[]> {
  const lineups: LineupConfig[] = [];

  for (const site of config.sites) {
    const channels = await resolveChannels(site);

    lineups.push({
      id: site.site,
      type: options.type ?? 'List',
      displayName: [{
        value: site.site,
        ...(options.lang === undefined ? {} : { lang: options.lang }),
      }],
      entries: channels.map((channel) => ({
        station: stationOf(channel, options.lang),
        ...(channel.preset === undefined ? {} : { preset: channel.preset }),
      })),
    });
  }

  return lineups;
}

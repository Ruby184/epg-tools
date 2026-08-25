/**
 * The documentation's examples, compiled.
 *
 * Not a test — nothing here runs. It is typechecked with everything else, so a
 * change to the API that would make the documentation wrong fails the build
 * instead of being found by whoever copies it out.
 *
 * Keep it in step with the code blocks in README.md and docs/*.md. The banners
 * below name the page each group of examples comes from.
 */

import {
  build,
  CacheDriverBase,
  defineConfig,
  defineSiteConfig,
  guideStream,
} from '../src/main.js';
import type {
  CacheDriver,
  CacheDriverFactory,
  ChannelDayKey,
  FoundEntry,
  FoundMeta,
  StoredEntryMeta,
  StoredProgramme,
} from '../src/main.js';
import { envReader } from '../src/core/answers.js';
import {
  parseXmltvFile,
  parseXmltvString,
  setXmltvZone,
  xmltvZone,
  zonedXmltvDate,
  writeXmltvStream,
  formatXmltvDate,
  parseXmltvDate,
  xmltvDate,
  ProgrammeBuilder,
  XmltvDocumentBuilder,
} from '../src/xmltv/main.js';
import {
  defineCapability,
  defineStages,
  DEFAULT_CAPABILITIES,
  GrabberError,
  runXmltvGrabber,
  lineupsCapability,
  lineupsFromSites,
} from '../src/tv-grab/main.js';

// --- README: Quick start ---------------------------------------------------
const example = defineSiteConfig({
  site: 'example.tv',
  channels: [{ xmltvId: 'one.example.tv', siteId: '101', name: 'Example One' }],
  concurrency: 2,
  rateLimit: { requests: 8, perMs: 1_000 },
  ky: { prefix: 'https://api.example.tv', headers: { 'x-api-key': 'k' }, retry: 2 },
  async request({ channel, date, http }) {
    return http
      .post('epg', { json: { channel_id: channel.siteId, date: date.toISOString() } })
      .json<{ items: { start: string; end: string; title: string }[] }>();
  },
  parseDay({ payload, programme }) {
    return payload.items.map((item) =>
      programme(new Date(item.start), item.title).stop(new Date(item.end)),
    );
  },
});

export const quickStart = defineConfig({ sites: [example], days: 14, output: 'public/epg.xml' });

// --- docs/site-config.md: Batching ----------------------------------------
interface RawProgramme {
  start: string;
  title: string;
}

const byChannels = defineSiteConfig({
  site: 'example.tv',
  channels: [{ xmltvId: 'one.example.tv', siteId: '101' }],
  batching: { mode: 'channels', channelsPerRequest: 50 },
  async request({ channels, date, http }) {
    return http
      .get('epg', {
        searchParams: { ids: channels.map((c) => c.siteId).join(','), date: date.toISOString() },
      })
      .json<{ items: { channelId: string; programmes: RawProgramme[] }[] }>();
  },
  parseDay({ payload, channel }) {
    const item = payload.items.find((i) => i.channelId === channel.siteId);
    return (item?.programmes ?? []).map((p) => ({
      channel: channel.xmltvId,
      start: new Date(p.start),
      title: [{ value: p.title }],
    }));
  },
});

const byDays = defineSiteConfig({
  site: 'example.tv',
  channels: [{ xmltvId: 'one.example.tv', siteId: '101' }],
  batching: { mode: 'days', daysPerRequest: 7 },
  async request({ channel, from, to, http }) {
    return http
      .get('epg', {
        searchParams: { id: channel.siteId, from: from.toISOString(), to: to.toISOString() },
      })
      .json<{ items: { day: string; programmes: RawProgramme[] }[] }>();
  },
  parseDay({ payload, day, channel }) {
    const item = payload.items.find((i) => i.day === day);
    return (item?.programmes ?? []).map((p) => ({
      channel: channel.xmltvId,
      start: new Date(p.start),
      title: [{ value: p.title }],
    }));
  },
});

// Every mode also gets `channelDays` — what the request is for, pair by pair.
const byPairs = defineSiteConfig({
  site: 'example.tv',
  channels: [{ xmltvId: 'one.example.tv', siteId: '101' }],
  batching: { mode: 'both', channelsPerRequest: 50, daysPerRequest: 7 },
  async request({ channelDays, http }) {
    return http
      .post('epg', {
        json: { queries: channelDays.map(({ channel, day }) => ({ id: channel.siteId, day })) },
      })
      .json<{ items: { channelId: string; day: string; programmes: RawProgramme[] }[] }>();
  },
  parseDay({ payload, channel, day }) {
    const item = payload.items.find((i) => i.channelId === channel.siteId && i.day === day);
    return (item?.programmes ?? []).map((p) => ({
      channel: channel.xmltvId,
      start: new Date(p.start),
      title: [{ value: p.title }],
    }));
  },
});

export const batched = defineConfig({ sites: [byChannels, byDays, byPairs], output: 'guide.xml' });

// --- docs/site-config.md: Building programmes -----------------------------
interface RawItem {
  start: string;
  end: string;
  title: string;
  summary: string;
  genre: string;
  episode: number;
  season: number;
  rating: string;
}

export const built = defineSiteConfig({
  site: 'example.tv',
  channels: [{ xmltvId: 'one.example.tv', siteId: '101', lang: 'sk' }],
  async request({ http }) {
    return http.get('epg').json<{ items: RawItem[] }>();
  },
  parseDay({ payload, programme }) {
    return payload.items.map((item) =>
      programme(new Date(item.start), item.title)
        .stop(new Date(item.end))
        .desc(item.summary)
        .category(item.genre)
        .episode(item.episode, item.season)
        .video({ quality: 'HDTV' })
        .rating(item.rating, { system: 'SK' }),
    );
  },
});

// --- docs/site-config.md: Rate limits and backoff --------------------------
export const paced = defineSiteConfig({
  site: 'example.tv',
  channels: [{ xmltvId: 'one.example.tv', siteId: '101' }],
  rateLimit: { requests: 20, perMs: 60_000 },
  backoff: { statuses: [429, 503], fallbackMs: 5_000, maxMs: 60_000, adapt: true },
  async request() {
    return {};
  },
  parseDay: () => [],
});

// --- docs/site-config.md: A channel list that has to be fetched ------------
const fetchedChannels = defineSiteConfig({
  site: 'example.tv',
  ky: { prefix: 'https://api.example.tv', headers: { 'x-api-key': 'k' } },
  async channels({ http }) {
    const { items } = await http.get('channels').json<{
      items: {
        id: string;
        titles: { text: string; lang: string }[];
        logo: string;
        number: number;
      }[];
    }>();

    return items.map((item) => ({
      xmltvId: `${item.id}.example.tv`,
      siteId: item.id,
      data: { names: item.titles, logo: item.logo, lcn: item.number },
    }));
  },
  channelInfo({ data }, element) {
    const channel = element();

    for (const name of data?.names ?? []) {
      channel.displayName(name.text, name.lang);
    }

    return data?.lcn ? channel.extra({ name: 'lcn', value: String(data.lcn) }) : channel;
  },
  async request({ channel, date, http }) {
    return http
      .get('epg', { searchParams: { id: channel.siteId, date: date.toISOString() } })
      .json<{ items: RawProgramme[] }>();
  },
  parseDay({ channel, payload }) {
    return payload.items.map((p) => ({
      channel: channel.xmltvId,
      start: new Date(p.start),
      title: [{ value: p.title }],
    }));
  },
});

export const fetched = defineConfig({ sites: [fetchedChannels], output: 'guide.xml' });

// The mode decides which caps are accepted, and the shape of the context.
export const wrongCap = defineSiteConfig({
  site: 'example.tv',
  channels: [],
  // @ts-expect-error — 'channels' batches one day at a time; there is nothing to cap.
  batching: { mode: 'channels', daysPerRequest: 7 },
  async request() {
    return {};
  },
  parseDay: () => [],
});

// --- docs/tv-grab.md: Asking for more than channels -----------------------
export const stages = defineStages([
  {
    name: 'start',
    next: 'select-channels',
    fields: [
      { type: 'string', id: 'username', title: 'Username', description: 'Your account name.' },
      { type: 'secretstring', id: 'password', title: 'Password', description: 'Not echoed.' },
    ],
  },
]);

export const shared = defineConfig(
  (ctx) => ({
    sites: [example],
    days: 7,
    output: 'guide.xml',
    meta: { sourceInfoName: `${ctx.require('username')}:${ctx.require('password')}` },
  }),
  { stages, env: 'TV_GRAB_SK_EXAMPLE_' },
);

export const envFirst = defineConfig(
  (ctx) => ({ sites: [example], output: 'guide.xml', days: Number(ctx.get('days') ?? 7) }),
  { readers: (supplied) => [envReader('TV_GRAB_SK_EXAMPLE_'), ...supplied] },
);

// --- docs/tv-grab.md: Capabilities of your own ----------------------------
declare function myLineupsXml(): string;
declare function myLineupXml(id: string | undefined): string;

const myLineups = defineCapability({
  name: 'my-lineups',
  options: { 'list-lineups': { type: 'boolean' }, 'get-lineup': { type: 'boolean' } },
  usage: {
    modes: [
      ['list-lineups', 'output'],
      ['get-lineup', 'config-file', 'output'],
    ],
  },
  async run(ctx) {
    if (ctx.values['list-lineups']) {
      await ctx.emit(myLineupsXml());
      return 0;
    }

    if (ctx.values['get-lineup']) {
      ctx.onConfigLoaded(async (conf) => {
        if (conf === undefined) {
          throw new GrabberError('You need to configure the grabber first.');
        }

        await ctx.emit(myLineupXml(conf.lineup?.[0]));
        return 0;
      });
    }
  },
});

export const withCapability = (): Promise<number> =>
  runXmltvGrabber(shared, {
    description: '…',
    version: '0.1.0',
    capabilities: [...DEFAULT_CAPABILITIES, myLineups],
  });

// --- docs/tv-grab.md: Channel lineups -------------------------------------
export const withLineups = (): Promise<number> =>
  runXmltvGrabber(shared, {
    description: 'Slovakia (tv_grab_sk_example)',
    version: '0.1.0',
    capabilities: [...DEFAULT_CAPABILITIES, lineupsCapability(lineupsFromSites)],
  });

export const handWritten = lineupsCapability([
  {
    id: 'dvbt-west',
    type: 'DTV',
    displayName: [{ value: 'DVB-T West', lang: 'en' }],
    availability: [{ value: 'SK', area: 'country' }],
    entries: [
      {
        preset: '1',
        station: { xmltvId: 'one.example.tv', name: 'One', type: 'TV' },
        dvb: [{ originalNetworkId: 8442, transportId: 2049, serviceId: 4351, lcn: '1' }],
      },
    ],
  },
]);

// What `defineStages` is for: a bare array literal widens `type` to `string`,
// so a misspelt one compiles and becomes a question no renderer ever asks.
export const typo = defineStages([
  {
    name: 'start',
    next: 'select-channels',
    // @ts-expect-error — caught here, rather than at the first --configure.
    fields: [{ type: 'strng', id: 'username', title: 'U', description: 'D' }],
  },
]);

// --- docs/configuration.md: EpgConfig reference -----------------------------
export const configured = defineConfig({
  sites: [example],
  output: 'public/epg.xml',
  days: 14,
  siteConcurrency: 2,
  localConcurrency: 16,
  indent: 2,
  cache: {
    dir: '.epg-cache',
    driver: 'ndjson',
    staleness: { alwaysRefetchDays: 1, maxAgeDays: 7 },
    prune: true,
  },
  merge: { channelStrategy: 'merge-programmes', programmeStrategy: 'merge' },
  meta: {
    generatorInfoName: 'epg-tools',
    generatorInfoUrl: 'https://github.com/Ruby184/epg-tools',
    sourceInfoName: 'Example TV',
    sourceInfoUrl: 'https://example.tv',
    sourceDataUrl: 'https://api.example.tv/epg',
  },
});

// --- docs/api.md: A driver of your own -------------------------------------

/**
 * The store behind the example driver. A real one is a client — Redis,
 * Postgres, a bucket — and stands in here as a `Map`, since what the
 * documentation is promising is the shape of the driver rather than the client.
 */
const rows = new Map<string, { meta: StoredEntryMeta; programmes: StoredProgramme[] }>();

class KeyValueCacheDriver extends CacheDriverBase implements CacheDriver<StoredProgramme> {
  readonly #prefix: string;

  constructor(options: { prefix: string; signal?: AbortSignal | undefined }) {
    super();
    this.#prefix = options.prefix;
  }

  #id(key: ChannelDayKey): string {
    return `${this.#prefix}:${key.site}:${key.channelId}:${key.day}`;
  }

  async readMeta(key: ChannelDayKey): Promise<FoundMeta | undefined> {
    const row = rows.get(this.#id(key));

    return row && { meta: row.meta };
  }

  async read(key: ChannelDayKey): Promise<FoundEntry<StoredProgramme> | undefined> {
    return rows.get(this.#id(key));
  }

  async write(
    key: ChannelDayKey,
    programmes: StoredProgramme[],
    meta: StoredEntryMeta,
  ): Promise<void> {
    rows.set(this.#id(key), { meta, programmes });
  }

  async delete(key: ChannelDayKey): Promise<void> {
    rows.delete(this.#id(key));
  }

  async prune(options: { before: string }): Promise<number> {
    let removed = 0;

    for (const id of rows.keys()) {
      if (id.slice(id.lastIndexOf(':') + 1) < options.before) {
        rows.delete(id);
        removed++;
      }
    }

    return removed;
  }

  async close(): Promise<void> {}
}

/** The builder the documentation recommends exporting, rather than the class. */
export function keyValueCache(options: { prefix?: string }): CacheDriverFactory {
  return async ({ signal }) => new KeyValueCacheDriver({ prefix: options.prefix ?? 'epg', signal });
}

export const cachedElsewhere = defineConfig({
  sites: [example],
  output: 'public/epg.xml',
  cache: { driver: keyValueCache({ prefix: 'epg' }) },
});

// --- docs/api.md: Running a build ------------------------------------------
export const run = async (): Promise<number> => {
  const summary = await build(configured, { logger: console.log });
  return summary.fetched + summary.fromCache + summary.failed.length;
};

export const streamed = async (): Promise<string> => {
  let out = '';

  for await (const chunk of guideStream(configured, { offset: 1 })) {
    out += chunk;
  }

  return out;
};

// --- docs/xmltv.md: Parsing -------------------------------------------------
export const parseEvents = async (): Promise<number> => {
  let programmes = 0;

  for await (const event of parseXmltvFile('guide.xml')) {
    if (event.type === 'programme') {
      programmes += 1;
    } else if (event.type === 'warning') {
      console.warn(`${event.value.code} at line ${event.value.line}: ${event.value.message}`);
    }
  }

  return programmes;
};

// Every parse entry point takes the same options.
export const tolerant = (xml: string): number =>
  parseXmltvString(xml, {
    tolerateMissingId: true,
    rootScanLimit: 2 * 1024 * 1024,
    timezones: { BST: 60, CET: 60, CEST: 120 },
  }).warnings.length;

// --- docs/xmltv.md: Serializing ---------------------------------------------
export const pretty = writeXmltvStream({ meta: {}, channels: [], programmes: [] }, { indent: 2 });

// --- docs/xmltv.md: Builders ------------------------------------------------
export const programme = new ProgrammeBuilder({
  channel: 'one.example.tv',
  start: '20260717200000 +0200',
  title: "The Nine O'Clock News",
  lang: 'en',
})
  .stop('20260717203000 +0200')
  .desc('The day in review.')
  .category('News')
  .episode(3, 2)
  .actor('Jane Doe', { role: 'Presenter' })
  .build();

export const document = new XmltvDocumentBuilder()
  .generatorInfo('epg-tools', 'https://github.com/Ruby184/epg-tools')
  .sourceInfo('Example TV', 'https://example.tv')
  .channel({ id: 'one.example.tv', displayName: 'One', lang: 'en' }, (c) =>
    c.displayName('Jeden', 'sk').icon('https://example.tv/one.png'),
  )
  .programme({ channel: 'one.example.tv', start: '20260717200000 +0200', title: 'News' }, (p) =>
    p.desc('Evening news').episode(3),
  );

export const bound = new XmltvDocumentBuilder()
  .addProgramme({ channel: 'one.example.tv', start: '20260717200000 +0200', title: 'News' })
  .desc('Evening news')
  .episode(3)
  .end()
  .addChannel({ id: 'one.example.tv', displayName: 'One' })
  .icon('https://example.tv/one.png')
  .end();

export const asXml = document.toXml({ indent: 2 });
export const asEvents = document.toEvents();
export const asStream = document.toStream();

// --- docs/xmltv.md: Dates ---------------------------------------------------
export const roundTripped = (): string => {
  const d = parseXmltvDate('20260717 +0200'); // day precision, +02:00 preserved
  return `${formatXmltvDate(d)} ${formatXmltvDate(xmltvDate(d, { precision: 14 }))}`;
};

// --- docs/site-config.md: Building programmes (a source's wall clock) -------
export const localStart = (
  programme: (start: Date, title: string) => ProgrammeBuilder,
  item: { start: string; title: string },
): ProgrammeBuilder => programme(zonedXmltvDate(item.start, 'Europe/Bratislava'), item.title);

// --- docs/xmltv.md: Named zones ---------------------------------------------
export const zoned = (epochSeconds: number): Date[] => [
  zonedXmltvDate('2026-07-17 20:00', 'Europe/Bratislava'), // 18:00Z, written +0200
  zonedXmltvDate('20261225183000', 'Europe/Bratislava'), // 17:30Z, written +0100

  // A source that stamps every datetime `CET` means a place, not an offset: the
  // same three letters are +0200 in July and +0100 in December.
  parseXmltvDate('20260717200000 CET', { CET: xmltvZone('Europe/Bratislava') }),

  // A source that gives an instant, where the guide should still read locally.
  setXmltvZone(new Date(epochSeconds * 1000), 'Europe/Bratislava'),
];

/**
 * The README's examples, compiled.
 *
 * Not a test — nothing here runs. It is typechecked with everything else, so a
 * change to the API that would make the documentation wrong fails the build
 * instead of being found by whoever copies it out.
 *
 * Keep it in step with the code blocks in README.md.
 */

import { defineConfig, defineSiteConfig } from '../src/main.js';
import { envReader } from '../src/core/answers.js';
import {
  defineCapability, defineStages, DEFAULT_CAPABILITIES, GrabberError, runXmltvGrabber,
  lineupsCapability, lineupsFromSites,
} from '../src/tv-grab/main.js';

// --- Quick start -----------------------------------------------------------
const example = defineSiteConfig({
  site: 'example.tv',
  channels: [{ xmltvId: 'one.example.tv', siteId: '101', name: 'Example One' }],
  ky: { prefix: 'https://api.example.tv', headers: { 'x-api-key': 'k' }, retry: 2 },
  async request({ channel, date, http }) {
    return http.post('epg', { json: { channel_id: channel.siteId, date: date.toISOString() } })
      .json<{ items: { start: string; end: string; title: string }[] }>();
  },
  parseDay({ data, channel }) {
    return data.items.map((item) => ({
      channel: channel.xmltvId,
      start: new Date(item.start),
      stop: new Date(item.end),
      title: [{ value: item.title, lang: 'sk' }],
    }));
  },
});

export const quickStart = defineConfig({ sites: [example], days: 14, output: 'public/epg.xml' });

// --- Batching: how much one request covers --------------------------------
interface RawProgramme { start: string; title: string }

const byChannels = defineSiteConfig({
  site: 'example.tv',
  channels: [{ xmltvId: 'one.example.tv', siteId: '101' }],
  batching: { mode: 'channels', channelsPerRequest: 50 },
  async request({ channels, date, http }) {
    return http.get('epg', {
      searchParams: { ids: channels.map((c) => c.siteId).join(','), date: date.toISOString() },
    }).json<{ items: { channelId: string; programmes: RawProgramme[] }[] }>();
  },
  parseDay({ data, channel }) {
    const item = data.items.find((i) => i.channelId === channel.siteId);
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
    return http.get('epg', {
      searchParams: { id: channel.siteId, from: from.toISOString(), to: to.toISOString() },
    }).json<{ items: { day: string; programmes: RawProgramme[] }[] }>();
  },
  parseDay({ data, day, channel }) {
    const item = data.items.find((i) => i.day === day);
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
    return http.post('epg', {
      json: { queries: channelDays.map(({ channel, day }) => ({ id: channel.siteId, day })) },
    }).json<{ items: { channelId: string; day: string; programmes: RawProgramme[] }[] }>();
  },
  parseDay({ data, channel, day }) {
    const item = data.items.find((i) => i.channelId === channel.siteId && i.day === day);
    return (item?.programmes ?? []).map((p) => ({
      channel: channel.xmltvId,
      start: new Date(p.start),
      title: [{ value: p.title }],
    }));
  },
});

export const batched = defineConfig({ sites: [byChannels, byDays, byPairs], output: 'guide.xml' });

// --- A channel list that has to be fetched ---------------------------------
const fetchedChannels = defineSiteConfig({
  site: 'example.tv',
  ky: { prefix: 'https://api.example.tv', headers: { 'x-api-key': 'k' } },
  async channels({ http }) {
    const { items } = await http.get('channels').json<{
      items: { id: string; titles: { text: string; lang: string }[]; logo: string; number: number }[];
    }>();

    return items.map((item) => ({
      xmltvId: `${item.id}.example.tv`,
      siteId: item.id,
      data: { names: item.titles, logo: item.logo, lcn: item.number },
    }));
  },
  channelInfo({ xmltvId, data }) {
    return {
      id: xmltvId,
      displayName: (data?.names ?? []).map((name) => ({ value: name.text, lang: name.lang })),
      ...(data?.logo ? { icon: [{ src: data.logo }] } : {}),
      ...(data?.lcn ? { extra: [{ name: 'lcn', text: String(data.lcn) }] } : {}),
    };
  },
  async request({ channel, date, http }) {
    return http.get('epg', { searchParams: { id: channel.siteId, date: date.toISOString() } })
      .json<{ items: RawProgramme[] }>();
  },
  parseDay({ channel, data }) {
    return data.items.map((p) => ({
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

// --- Asking for more than channels ----------------------------------------
export const stages = defineStages([{
  name: 'start',
  next: 'select-channels',
  fields: [
    { type: 'string', id: 'username', title: 'Username', description: 'Your account name.' },
    { type: 'secretstring', id: 'password', title: 'Password', description: 'Not echoed.' },
  ],
}]);

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

// --- Capabilities of your own ---------------------------------------------
declare function myLineupsXml(): string;
declare function myLineupXml(id: string | undefined): string;

const myLineups = defineCapability({
  name: 'my-lineups',
  options: { 'list-lineups': { type: 'boolean' }, 'get-lineup': { type: 'boolean' } },
  usage: { modes: [['list-lineups', 'output'], ['get-lineup', 'config-file', 'output']] },
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

export const withCapability = (): Promise<number> => runXmltvGrabber(shared, {
  description: '…', version: '0.1.0',
  capabilities: [...DEFAULT_CAPABILITIES, myLineups],
});

// --- Channel lineups -------------------------------------------------------
export const withLineups = (): Promise<number> => runXmltvGrabber(shared, {
  description: 'Slovakia (tv_grab_sk_example)',
  version: '0.1.0',
  capabilities: [...DEFAULT_CAPABILITIES, lineupsCapability(lineupsFromSites)],
});

export const handWritten = lineupsCapability([{
  id: 'dvbt-west',
  type: 'DTV',
  displayName: [{ value: 'DVB-T West', lang: 'en' }],
  availability: [{ value: 'SK', area: 'country' }],
  entries: [{
    preset: '1',
    station: { xmltvId: 'one.example.tv', name: 'One', type: 'TV' },
    dvb: [{ originalNetworkId: 8442, transportId: 2049, serviceId: 4351, lcn: '1' }],
  }],
}]);

// What `defineStages` is for: a bare array literal widens `type` to `string`,
// so a misspelt one compiles and becomes a question no renderer ever asks.
export const typo = defineStages([{
  name: 'start',
  next: 'select-channels',
  // @ts-expect-error — caught here, rather than at the first --configure.
  fields: [{ type: 'strng', id: 'username', title: 'U', description: 'D' }],
}]);

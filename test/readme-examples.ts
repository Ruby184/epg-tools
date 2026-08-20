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
  async fetchDay({ channel, date, http }) {
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

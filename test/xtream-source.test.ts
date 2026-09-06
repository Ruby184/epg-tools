import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CacheManager, MemoryCacheDriver } from '../src/cache/main.js';
import type { CacheStore } from '../src/cache/main.js';
import { defineXtreamSite, grab, resolveChannels } from '../src/grabber/main.js';
import { generateGuide } from '../src/merge/main.js';
import type { EpgEvent } from '../src/core/events.js';

const NOW = new Date('2026-09-06T05:00:00.000Z');
const DAY = '2026-09-06';

let running: Server | undefined;

afterEach(async () => {
  const server = running;

  running = undefined;

  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** Base64 as a panel sends it. */
const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

/** One listing, in the panel's own shape. */
function listing(
  start: string,
  stop: string,
  title: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const at = Date.parse(`${start}Z`) / 1000;

  return {
    id: '11',
    epg_id: '7',
    title: b64(title),
    description: b64(`About ${title}`),
    lang: 'sk',
    // The wall clock the panel writes in — here +02:00 against the timestamp.
    start: start.replace('T', ' '),
    start_timestamp: String(at - 2 * 3600),
    stop_timestamp: String(Date.parse(`${stop}Z`) / 1000 - 2 * 3600),
    has_archive: 1,
    now_playing: 1,
    ...extra,
  };
}

interface Panel {
  url: string;
  asked: IncomingMessage[];
  /** How many schedule calls were made, and for which stream. */
  schedules: string[];
}

/** A stand-in panel. `answers` overrides what an action replies with. */
async function panel(
  answers: {
    streams?: unknown;
    categories?: unknown;
    listings?: (streamId: string) => unknown;
    status?: number;
    profile?: unknown;
  } = {},
): Promise<Panel> {
  const asked: IncomingMessage[] = [];
  const schedules: string[] = [];

  const server = createServer((request, response) => {
    asked.push(request);

    const query = new URL(request.url ?? '/', 'http://panel');
    const action = query.searchParams.get('action');

    if (answers.status !== undefined) {
      response.writeHead(answers.status, { 'content-type': 'application/json' });
      response.end('{}');

      return;
    }

    response.writeHead(200, { 'content-type': 'application/json' });

    // No action at all: the panel's word on the account and on itself. Note it
    // echoes the password straight back, which is why none of it is kept.
    if (action === null) {
      response.end(
        JSON.stringify(
          answers.profile ?? {
            user_info: { auth: 1, status: 'Active', exp_date: null, password: 'hunter2' },
            server_info: { timezone: 'Europe/Bratislava' },
          },
        ),
      );

      return;
    }

    if (action === 'get_live_categories') {
      response.end(
        JSON.stringify(answers.categories ?? [{ category_id: '5', category_name: 'Sport' }]),
      );

      return;
    }

    if (action === 'get_simple_data_table') {
      const streamId = query.searchParams.get('stream_id') ?? '';

      schedules.push(streamId);
      response.end(
        JSON.stringify(
          answers.listings?.(streamId) ?? {
            epg_listings: [listing(`${DAY}T20:00:00`, `${DAY}T21:00:00`, 'Späť do budúcnosti')],
          },
        ),
      );

      return;
    }

    response.end(
      JSON.stringify(
        answers.streams ?? [
          {
            num: 1,
            name: 'Jednotka HD',
            stream_id: 101,
            stream_icon: 'http://panel/1.png',
            epg_channel_id: 'jednotka.sk',
            category_id: '5',
            added: '1609459200',
            tv_archive: 1,
            tv_archive_duration: 7,
            direct_source: 'http://host/live/user/PASSWORD/101.ts',
          },
        ],
      ),
    );
  });

  running = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    asked,
    schedules,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

const store = (): CacheStore => new CacheManager({ driver: new MemoryCacheDriver() });

const site = (url: string, options: Record<string, unknown> = {}) =>
  defineXtreamSite({
    site: 'panel.example',
    url,
    username: 'someone',
    password: 'hunter2',
    days: 1,
    ...options,
  });

/** The guide a run of this site produces. */
async function guide(source: Panel, options: Record<string, unknown> = {}): Promise<string> {
  const cache = store();
  const sites = [site(source.url, options)];

  await grab(sites, { cache, now: NOW });

  let xml = '';

  for await (const chunk of generateGuide({ sites, cache, days: 1, startDay: DAY, now: NOW })) {
    xml += chunk;
  }

  return xml;
}

describe('defineXtreamSite', () => {
  it('keeps a non-ASCII title, which is what atob would not', async () => {
    const source = await panel();

    // The decoder the published clients use returns latin1; this is the
    // assertion that fails under it.
    expect(await guide(source)).toContain('Späť do budúcnosti');
  });

  it('reads the panel`s own offset out of the listing, rather than guessing', async () => {
    const xml = await guide(await panel());

    // `start` is wall clock and `start_timestamp` is the same instant in epoch
    // seconds, so their difference is the offset — +0200 here.
    expect(xml).toContain('start="20260906200000 +0200"');
    expect(xml).toContain('stop="20260906210000 +0200"');
  });

  it('maps a channel onto the DTD where it can', async () => {
    const xml = await guide(await panel());

    // Not `id="…">` — the channel carries its extensions as attributes, which
    // is the point of the test below.
    expect(xml).toContain('<channel id="jednotka.sk"');
    expect(xml).toContain('<display-name>Jednotka HD</display-name>');
    expect(xml).toContain('src="http://panel/1.png"');
    expect(xml).toContain('<title lang="sk">Späť do budúcnosti</title>');
    expect(xml).toContain('<desc lang="sk">About Späť do budúcnosti</desc>');
  });

  it('keeps what the DTD has no place for, as extensions', async () => {
    const xml = await guide(await panel());

    // The panel's own ids, its catchup flags, and the category by name.
    expect(xml).toContain('xtreamId="11"');
    expect(xml).toContain('xtreamEpgId="7"');
    expect(xml).toContain('catchup="yes"');
    expect(xml).toContain('catchupDays="7"');
    expect(xml).toContain('<category>Sport</category>');
  });

  it('never keeps what would be a lie or a leak', async () => {
    const xml = await guide(await panel());

    // `now_playing` is true only at the moment of asking; `direct_source`
    // carries the credentials.
    expect(xml).not.toContain('nowPlaying');
    expect(xml).not.toContain('PASSWORD');
  });

  it('asks once per channel, not once per channel-day', async () => {
    const source = await panel({
      streams: [
        { num: 1, name: 'One', stream_id: 101, epg_channel_id: 'one.sk' },
        { num: 2, name: 'Two', stream_id: 102, epg_channel_id: 'two.sk' },
      ],
    });

    await grab([site(source.url, { days: 3 })], { cache: store(), now: NOW });

    // Three days over two channels: two schedule calls, because one call
    // brings a channel's whole table.
    expect(source.schedules).toEqual(['101', '102']);
  });

  it('asks for nothing when every day is already cached', async () => {
    const source = await panel();
    const cache = store();
    // `alwaysRefetchDays` is 1 by default, and today is the only day in this
    // window — so freshness never gets a look in until that is turned off.
    const sites = [site(source.url, { staleness: { alwaysRefetchDays: 0 } })];

    await grab(sites, { cache, now: NOW });

    const first = source.schedules.length;

    await grab(sites, { cache, now: NOW });

    // The claim the adapter exists on: a fresh channel is never asked about,
    // where a whole-guide dump would be downloaded again regardless.
    expect(first).toBe(1);
    expect(source.schedules).toHaveLength(1);
  });

  it('reads listings that arrive as an object with numbered keys', async () => {
    const source = await panel({
      listings: () => ({
        epg_listings: { 0: listing(`${DAY}T20:00:00`, `${DAY}T21:00:00`, 'Numbered') },
      }),
    });

    expect(await guide(source)).toContain('Numbered');
  });

  it('takes a title that was never encoded', async () => {
    const source = await panel({
      listings: () => ({
        epg_listings: [
          { ...listing(`${DAY}T20:00:00`, `${DAY}T21:00:00`, 'x'), title: 'Plain Already' },
        ],
      }),
    });

    expect(await guide(source)).toContain('Plain Already');
  });

  it('skips a listing whose timestamp is empty rather than throwing', async () => {
    const source = await panel({
      listings: () => ({
        epg_listings: [
          { ...listing(`${DAY}T20:00:00`, `${DAY}T21:00:00`, 'Kept') },
          { ...listing(`${DAY}T22:00:00`, `${DAY}T23:00:00`, 'Dropped'), start_timestamp: '' },
          { ...listing(`${DAY}T23:00:00`, `${DAY}T23:30:00`, 'Zero'), start_timestamp: '0' },
        ],
      }),
    });

    const xml = await guide(source);

    expect(xml).toContain('Kept');
    expect(xml).not.toContain('Dropped');
    expect(xml).not.toContain('Zero');
  });

  it('falls back to the stream id when the panel names no epg id', async () => {
    const source = await panel({
      streams: [{ num: 1, name: 'Nameless', stream_id: 404, epg_channel_id: '' }],
    });

    expect(await guide(source)).toContain('<channel id="404">');
  });

  // SD/HD/FHD variants share one `epg_channel_id`, and the cache appends rather
  // than replaces — so keeping both would put every programme in twice.
  it('keeps one of two channels sharing an epg id, and says so once', async () => {
    const source = await panel({
      streams: [
        { num: 1, name: 'One SD', stream_id: 101, epg_channel_id: 'one.sk' },
        { num: 2, name: 'One HD', stream_id: 102, epg_channel_id: 'one.sk' },
        { num: 3, name: 'One FHD', stream_id: 103, epg_channel_id: 'one.sk' },
      ],
    });
    const said: string[] = [];

    const channels = await resolveChannels(site(source.url), {
      says: { log: () => {}, warn: (message) => said.push(message) },
    });

    expect(channels).toHaveLength(1);
    expect(channels[0]?.siteId).toBe('101');
    expect(said).toEqual([expect.stringContaining('2 channels share an epg id')]);
  });

  // A panel answers bad credentials with 200 and an auth object, so nothing
  // throws and the list is merely empty — which must not read as "no channels".
  it('fails the site when the panel answers 200 with no channels', async () => {
    const source = await panel({ streams: { user_info: { auth: 0 } } });

    const summary = await grab([site(source.url)], { cache: store(), now: NOW });

    expect(summary.sitesFailed).toBe(1);
  });

  it('never lets the password reach an event', async () => {
    const source = await panel({ status: 401 });
    const seen: EpgEvent[] = [];

    await grab([site(source.url)], {
      cache: store(),
      now: NOW,
      reporter: (event) => seen.push(event),
    });

    const said = JSON.stringify(seen, (_key, value: unknown) =>
      value instanceof Error ? { message: value.message, stack: value.stack } : value,
    );

    expect(seen.length).toBeGreaterThan(0);
    expect(said).not.toContain('hunter2');
  });

  /** Every `site:failed` message a run produced. */
  async function failures(url: string): Promise<string[]> {
    const said: string[] = [];

    await grab([site(url)], {
      cache: store(),
      now: NOW,
      reporter: (event) => {
        if (event.type === 'site:failed') {
          said.push(String((event.error as Error).message));
        }
      },
    });

    return said;
  }

  // The panel says outright what an empty channel list only implies.
  it('fails the site when the panel refuses the account, and asks nothing else', async () => {
    const refused = await panel({
      profile: { user_info: { auth: 0, message: 'Bad credentials' } },
    });

    expect(await failures(refused.url)).toEqual([expect.stringContaining('Bad credentials')]);
    // There is no sense asking a panel for channels it has already refused you.
    expect(refused.asked).toHaveLength(1);
  });

  it('tells an expired subscription from a working one', async () => {
    const expired = await panel({ profile: { user_info: { auth: 1, status: 'Expired' } } });

    expect(await failures(expired.url)).toEqual([expect.stringContaining('Expired')]);
  });

  // The failure that otherwise looks like the guide mysteriously emptying.
  it('warns before the subscription runs out', async () => {
    const soon = Math.floor(Date.now() / 1000) + 2 * 86_400;
    const source = await panel({
      profile: { user_info: { auth: 1, status: 'Active', exp_date: String(soon) } },
    });
    const said: string[] = [];

    await grab([site(source.url)], {
      cache: store(),
      now: NOW,
      reporter: (event) => {
        if (event.type === 'site:warning') {
          said.push(event.message);
        }
      },
    });

    expect(said).toContain('the account expires in 2 days');
  });

  // The derived offset is per listing and right across a DST boundary; the
  // panel's own zone is what is left when a listing gives nothing to derive
  // from — and it travels with the channel list, so a cached list keeps it.
  it('falls back to the panel`s timezone when a listing has no wall clock', async () => {
    const source = await panel({
      listings: () => ({
        epg_listings: [
          { ...listing(`${DAY}T20:00:00`, `${DAY}T21:00:00`, 'No wall clock'), start: undefined },
        ],
      }),
    });

    // Europe/Bratislava is +0200 in September, which is what the panel said it
    // was in — reached without the listing saying so itself.
    expect(await guide(source)).toContain('start="20260906200000 +0200"');
  });

  it('carries the panel`s timezone on the channel list, so a cached one keeps it', async () => {
    const source = await panel();

    const channels = await resolveChannels(site(source.url));

    expect(channels[0]?.data).toMatchObject({ timezone: 'Europe/Bratislava' });
  });

  it('ignores a timezone the panel made up', async () => {
    const source = await panel({
      profile: { user_info: { auth: 1 }, server_info: { timezone: 'Nowhere/Fictional' } },
    });

    const channels = await resolveChannels(site(source.url));

    // An unknown zone throws where it is used rather than where it was read,
    // which would be a channel failing for a reason nothing names.
    expect(channels[0]?.data).not.toHaveProperty('timezone');
  });

  it('takes a hook for the extensions, on either element', async () => {
    const source = await panel();

    const xml = await guide(source, {
      programmeExtras: (
        element: { extraAttribute: (n: string, v: string) => unknown },
        programme: { epgId?: string },
      ) => {
        element.extraAttribute('mine', programme.epgId ?? '');
      },
      channelExtras: false,
    });

    // Ours replaced the default rather than joining it, and the channel's went
    // entirely.
    expect(xml).toContain('mine="7"');
    expect(xml).not.toContain('xtreamId=');
    expect(xml).not.toContain('<category>');
  });
});

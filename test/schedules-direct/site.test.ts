import { afterEach, describe, expect, it } from 'vitest';
import { CacheManager, MemoryCacheDriver } from '../../src/cache/main.js';
import type { CacheStore } from '../../src/cache/main.js';
import { grab } from '../../src/grabber/main.js';
import {
  defineSchedulesDirectSite,
  schedulesDirectAccount,
} from '../../src/grabber/schedules-direct/main.js';
import { SiteStateHandle } from '../../src/grabber/state.js';
import { generateGuide } from '../../src/merge/main.js';
import { collect } from '../reporting.js';
import { sdServer, stopSdServer, type SdServer } from './server.js';

afterEach(stopSdServer);

const NOW = new Date('2026-09-12T09:00:00.000Z');
const TODAY = '2026-09-12';
const SITE = 'sd.example';
const LINEUP = 'GBR-1000014-DEFAULT';

/** The id the reference grabber writes, which is what this adapter writes too. */
const idOf = (stationID: string) => `I${stationID}.json.schedulesdirect.org`;

/** One airing, in the service's own shape. */
function airing(programID: string, hour: number, minutes = 60) {
  return {
    programID,
    airDateTime: `${TODAY}T${String(hour).padStart(2, '0')}:00:00Z`,
    duration: minutes * 60,
    md5: `${programID}-${String(hour)}`,
    new: true,
  };
}

/** One programme's detail, enough to be written. */
function program(programID: string, title: string) {
  return {
    programID,
    titles: [{ title120: title, titleLanguage: 'en' }],
    descriptions: {
      description1000: [{ descriptionLanguage: 'en', description: `About ${title}` }],
    },
    genres: ['Drama'],
  };
}

/** A service with one lineup, two stations and a day of listings on each. */
async function service(): Promise<SdServer> {
  const source = await sdServer({
    status: { account: { messages: [] }, lineups: [{ lineup: LINEUP }] },
    lineup: {
      map: [
        { stationID: '101', channel: '001' },
        { stationID: '202', channel: '002' },
      ],
      stations: [
        { stationID: '101', name: 'BBC One', callsign: 'BBC1', broadcastLanguage: ['en'] },
        { stationID: '202', name: 'ITV', callsign: 'ITV', broadcastLanguage: ['en'] },
      ],
    },
  });

  source.setSchedule('101', TODAY, [airing('EP000000010001', 18), airing('EP000000010002', 19)]);
  source.setSchedule('202', TODAY, [airing('EP000000020001', 20)]);
  source.setProgram(program('EP000000010001', 'The Six O`Clock Show'));
  source.setProgram(program('EP000000010002', 'The Seven O`Clock Show'));
  source.setProgram(program('EP000000020001', 'The Eight O`Clock Show'));

  return source;
}

const store = (): CacheStore => new CacheManager({ driver: new MemoryCacheDriver() });

/** The guide a cache holds, as XML. */
async function collectGuide(cache: CacheStore, source: SdServer, days = 1): Promise<string> {
  let xml = '';

  for await (const part of generateGuide({
    sites: [site(source, { days })],
    cache,
    days,
    startDay: TODAY,
    now: NOW,
  })) {
    xml += part;
  }

  return xml;
}

/** The site, with whatever a case wants to change. */
function site(source: SdServer, options: Record<string, unknown> = {}) {
  return defineSchedulesDirectSite({
    site: SITE,
    username: 'someone@example.com',
    password: 'hunter2',
    lineup: LINEUP,
    url: source.url,
    days: 1,
    ...options,
  });
}

describe('defineSchedulesDirectSite', () => {
  it('grabs a lineup into a guide with nothing written down', async () => {
    const source = await service();
    const cache = store();
    const sites = [site(source)];

    const summary = await grab(sites, { cache, now: NOW });

    expect(summary.fetched).toBe(2);
    expect(summary.failed).toBe(0);

    let xml = '';

    for await (const part of generateGuide({ sites, cache, days: 1, startDay: TODAY, now: NOW })) {
      xml += part;
    }

    // The channel ids the reference grabber writes, carrying what the DTD has
    // no place for, and the programmes on them.
    expect(xml).toContain(`<channel id="${idOf('101')}" stationId="101" callsign="BBC1">`);
    expect(xml).toContain('The Six O`Clock Show');
    expect(xml).toContain('The Eight O`Clock Show');
    expect(xml).toContain('<category lang="en">Drama</category>');
  });

  it('asks for md5s once for the whole site, then only for what moved', async () => {
    const source = await service();
    const cache = store();

    await grab([site(source)], { cache, now: NOW });

    // One md5 call covering both stations, and one schedule call for them.
    expect(source.countOf('schedules/md5')).toBe(1);
    expect(source.countOf('schedules')).toBe(1);
    expect((source.callsTo('schedules/md5')[0]!.body as unknown[]).length).toBe(2);
  });

  // The claim the adapter exists for.
  it('makes one request on a second run where nothing moved', async () => {
    const source = await service();
    const cache = store();
    const sites = [site(source)];

    await grab(sites, { cache, now: NOW });

    const before = source.calls.length;
    const summary = await grab(sites, { cache, now: NOW, staleness: { alwaysRefetchDays: 7 } });

    // Every channel-day kept, nothing fetched — and the only call made was the
    // one that asked whether anything had changed.
    expect(summary.unchanged).toBe(2);
    expect(summary.fetched).toBe(0);
    expect(source.calls.slice(before).map((call) => call.path)).toEqual(['schedules/md5']);
  });

  it('refetches only the station-day whose md5 moved', async () => {
    const source = await service();
    const cache = store();
    const sites = [site(source)];

    await grab(sites, { cache, now: NOW });

    // One station's listings change; the other's do not.
    source.setSchedule('202', TODAY, [airing('EP000000020001', 20), airing('EP000000020002', 21)]);
    source.setProgram(program('EP000000020002', 'The Nine O`Clock Show'));

    const before = source.calls.length;
    const summary = await grab(sites, { cache, now: NOW, staleness: { alwaysRefetchDays: 7 } });

    expect(summary.unchanged).toBe(1);
    expect(summary.fetched).toBe(1);

    const asked = source.calls.slice(before).filter((call) => call.path === 'schedules');

    // Asked about exactly one station: the one that moved.
    expect(asked).toHaveLength(1);
    expect(asked[0]?.body).toEqual([{ stationID: '202', date: [TODAY] }]);
  });

  // The state and the cache are two files that can be pruned separately, and
  // saying "unchanged" for an entry that is gone makes the run report a failed
  // channel-day — every run, since the md5 keeps agreeing.
  it('refetches a station-day whose md5 matches but whose entry is gone', async () => {
    const source = await service();
    const cache = store();
    const sites = [site(source)];

    await grab(sites, { cache, now: NOW });
    await cache.delete({ site: SITE, channelId: idOf('101'), day: TODAY });

    const summary = await grab(sites, { cache, now: NOW, staleness: { alwaysRefetchDays: 7 } });

    expect(summary.fetched).toBe(1);
    expect(summary.failed).toBe(0);
  });

  it('keeps the token between runs, so it logs in once a day', async () => {
    const source = await service();
    const cache = store();
    const sites = [site(source)];

    await grab(sites, { cache, now: NOW });
    await grab(sites, { cache, now: NOW, staleness: { alwaysRefetchDays: 7 } });

    expect(source.countOf('token')).toBe(1);
    expect(await (await SiteStateHandle.open(cache, SITE).bag()).get('token')).toBe('token-1');
  });

  it('fails the site, naming what the account does have, when the lineup is not on it', async () => {
    const source = await service();
    const report = collect();

    source.answer({ status: { account: { messages: [] }, lineups: [{ lineup: 'GBR-OTA-EC1A' }] } });

    await grab([site(source)], { cache: store(), now: NOW, reporter: report.reporter });

    const failed = report.of('site:failed')[0]!;

    expect((failed.error as Error).message).toContain(LINEUP);
    // What to do about it, which is the whole point of the message.
    expect((failed.error as Error).message).toContain('GBR-OTA-EC1A');
    // And it never tried to add one: this adapter does not change an account.
    expect(source.calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('takes every lineup on the account when the config names none', async () => {
    const source = await service();
    const report = collect();
    const cache = store();

    source.answer({
      status: {
        account: { messages: [] },
        lineups: [{ lineup: LINEUP, name: 'Freeview' }],
      },
    });

    // No `lineup` at all: the service already says what the account has, so
    // there is nothing here worth making someone copy.
    const summary = await grab([site(source, { lineup: undefined })], {
      cache,
      now: NOW,
      reporter: report.reporter,
    });

    expect(summary.fetched).toBe(2);
    // Said out loud, because it is implicit: a lineup added tomorrow joins the
    // guide without the config changing.
    expect(report.messages.some((line) => line.includes('every lineup on the account'))).toBe(true);
  });

  it('fails a site whose account has no lineup at all', async () => {
    const source = await service();
    const report = collect();

    source.answer({ status: { account: { messages: [] }, lineups: [] } });

    await grab([site(source, { lineup: undefined })], {
      cache: store(),
      now: NOW,
      reporter: report.reporter,
    });

    expect((report.of('site:failed')[0]!.error as Error).message).toMatch(/no lineup on it/);
  });

  it('skips the lineup download when its `modified` has not moved', async () => {
    const source = await service();
    const cache = store();
    const config = site(source);

    source.answer({
      status: {
        account: { messages: [] },
        lineups: [{ lineup: LINEUP, name: 'Freeview', modified: '2026-09-01T00:00:00Z' }],
      },
    });

    await grab([config], { cache, now: NOW });

    // Two days on, so the cached list is past its age and the site is asked for
    // one again — where before it would have downloaded the lineup a second
    // time to rebuild exactly what it already had.
    const later = new Date(NOW.getTime() + 2 * 86_400_000);

    await grab([config], { cache, now: later, staleness: { alwaysRefetchDays: 0 } });

    expect(source.countOf(`lineups/${LINEUP}`)).toBe(1);
    // It still asked the account, which is what told it there was nothing to do.
    expect(source.countOf('status')).toBe(2);
  });

  it('downloads the lineup again once its `modified` moves', async () => {
    const source = await service();
    const cache = store();
    const config = site(source);
    const later = new Date(NOW.getTime() + 2 * 86_400_000);

    source.answer({
      status: {
        account: { messages: [] },
        lineups: [{ lineup: LINEUP, modified: '2026-09-01T00:00:00Z' }],
      },
    });

    await grab([config], { cache, now: NOW });

    source.answer({
      status: {
        account: { messages: [] },
        lineups: [{ lineup: LINEUP, modified: '2026-09-15T12:00:00Z' }],
      },
    });

    await grab([config], { cache, now: later, staleness: { alwaysRefetchDays: 0 } });

    expect(source.countOf(`lineups/${LINEUP}`)).toBe(2);
  });

  it('downloads it again when the mapping would build different channels', async () => {
    const source = await service();
    const cache = store();
    const later = new Date(NOW.getTime() + 2 * 86_400_000);

    source.answer({
      status: {
        account: { messages: [] },
        lineups: [{ lineup: LINEUP, modified: '2026-09-01T00:00:00Z' }],
      },
    });

    await grab([site(source)], { cache, now: NOW });
    // The same lineup, unmoved — but a `channelId` that makes different
    // channels out of it, so what is stored is no longer what this site writes.
    await grab([site(source, { channelId: '%s.sd.test' })], {
      cache,
      now: later,
      staleness: { alwaysRefetchDays: 0 },
    });

    expect(source.countOf(`lineups/${LINEUP}`)).toBe(2);
  });

  it('downloads the lineup when the account says nothing about when it changed', async () => {
    const source = await service();
    const cache = store();
    const config = site(source);
    const later = new Date(NOW.getTime() + 2 * 86_400_000);

    // No `modified` at all: an unknown stamp must not read as "the same
    // unknown", or a lineup that never reports one would never be refetched.
    source.answer({ status: { account: { messages: [] }, lineups: [{ lineup: LINEUP }] } });

    await grab([config], { cache, now: NOW });
    await grab([config], { cache, now: later, staleness: { alwaysRefetchDays: 0 } });

    expect(source.countOf(`lineups/${LINEUP}`)).toBe(2);
  });

  it('settles a day whose programme the service will never have', async () => {
    const source = await service();
    const cache = store();

    // `6000`, in-band at HTTP 200: the id is not one the service knows.
    source.answer({
      programs: [
        { programID: 'EP000000010001', code: 6000, message: 'Could not find requested programID.' },
        program('EP000000010002', 'The Seven O`Clock Show'),
        program('EP000000020001', 'The Eight O`Clock Show'),
      ],
    });

    await grab([site(source)], { cache, now: NOW });

    const before = source.countOf('schedules');

    await grab([site(source)], { cache, now: NOW, staleness: { alwaysRefetchDays: 7 } });

    // Nothing would change by asking again, so the day is finished without it.
    // Holding it back instead is a station-day refetched on every run for ever.
    expect(source.countOf('schedules')).toBe(before);
  });

  it('waits and asks again for a programme the service is still writing', async () => {
    const source = await service();
    const cache = store();
    const report = collect();

    // `6001` once, then the programme — which is what the service does while it
    // generates one, and why asking again immediately is no use.
    source.queueProgram('EP000000010001', 1);

    const summary = await grab([site(source, { queuedWaits: [1] })], {
      cache,
      now: NOW,
      reporter: report.reporter,
    });

    expect(summary.failed).toBe(0);
    expect(source.countOf('programs')).toBe(2);

    const guide = await collectGuide(cache, source);

    // Written in this run rather than the next: the whole point of waiting.
    expect(guide).toContain('The Six O`Clock Show');
  });

  it('gives up waiting rather than holding a run open', async () => {
    const source = await service();
    const cache = store();
    const report = collect();

    source.queueProgram('EP000000010001', 5);

    await grab([site(source, { queuedWaits: [1, 1] })], {
      cache,
      now: NOW,
      reporter: report.reporter,
    });

    // Two waits, then the day is written without it and marked unfinished.
    expect(source.countOf('programs')).toBe(3);
    expect(report.messages.some((line) => line.includes('still being generated'))).toBe(true);

    const second = await grab([site(source, { queuedWaits: [] })], {
      cache,
      now: NOW,
      staleness: { alwaysRefetchDays: 7 },
    });

    // And asked for again on the next run, which is where it ends up anyway.
    expect(second.fetched).toBeGreaterThan(0);
  });

  it('asks again for a day whose programme is only queued', async () => {
    const source = await service();
    const cache = store();
    // No waiting here: this is about what the *next* run does with a day left
    // unfinished, which is where a programme still queued ends up regardless.
    const config = site(source, { queuedWaits: [] });

    // `6001`: being generated, so it is worth another run's asking.
    source.answer({
      programs: [
        { programID: 'EP000000010001', code: 6001, message: 'Program is queued for generation.' },
        program('EP000000010002', 'The Seven O`Clock Show'),
        program('EP000000020001', 'The Eight O`Clock Show'),
      ],
    });

    await grab([config], { cache, now: NOW });

    const before = source.countOf('schedules');

    await grab([config], { cache, now: NOW, staleness: { alwaysRefetchDays: 7 } });

    expect(source.countOf('schedules')).toBeGreaterThan(before);
  });

  it('cuts a fetch into requests by station-day, not by station', async () => {
    const source = await service();

    source.setSchedule('101', '2026-09-13', [airing('EP000000010003', 18)]);
    source.setSchedule('202', '2026-09-13', [airing('EP000000020002', 20)]);
    source.setProgram(program('EP000000010003', 'Tomorrow at Six'));
    source.setProgram(program('EP000000020002', 'Tomorrow at Eight'));

    // Two stations over two days is four station-days, which at two per request
    // is two requests — where counting stations would have made it one. The
    // same helper bounds the md5 pass, at the service's own cap of 5,000.
    await grab([site(source, { days: 2, stationDaysPerRequest: 2 })], {
      cache: store(),
      now: NOW,
    });

    const perCall = source
      .callsTo('schedules')
      .map((call) =>
        (call.body as { date?: string[] }[]).reduce((sum, one) => sum + (one.date?.length ?? 0), 0),
      );

    expect(perCall.length).toBe(2);
    expect(Math.max(...perCall)).toBeLessThanOrEqual(2);
  });

  it('caches a day past what the service publishes, rather than failing it', async () => {
    const source = await service();
    const cache = store();
    const report = collect();

    // Two days, of which the service holds only the first — which is what the
    // end of every window looks like, since it publishes about a fortnight.
    const summary = await grab([site(source, { days: 2 })], {
      cache,
      now: NOW,
      reporter: report.reporter,
    });

    // The md5 call simply leaves those days out. Reading that as "unchanged"
    // is what made a real 21-day grab report 435 failed channel-days, every
    // run: unchanged with nothing cached is a failure.
    expect(summary.failed).toBe(0);
    expect(report.messages.some((line) => line.includes('past what it publishes'))).toBe(true);

    // Cached empty, so the next run says nothing about them at all.
    const second = await grab([site(source, { days: 2 })], { cache, now: NOW });

    expect(second.failed).toBe(0);
    expect(second.fetched).toBe(0);
  });

  it('says how far the service does go, so the window can be made to fit', async () => {
    const source = await service();
    const report = collect();

    await grab([site(source, { days: 2 })], {
      cache: store(),
      now: NOW,
      reporter: report.reporter,
    });

    // The refusal names the days that station has, so the answer to "then what
    // should `days` be?" is in the line that raises the question.
    expect(report.messages).toContainEqual(
      expect.stringContaining('it goes as far as 2026-09-14, which is days: 3'),
    );
  });

  it('stores the md5 that came with the listings, not the one asked for earlier', async () => {
    const source = await service();
    const cache = store();
    const state = SiteStateHandle.open(cache, SITE);

    // The service answers one entry per station-day, each carrying the md5 of
    // the very listings in it — and it refreshes several times a day, so the
    // md5 pass a moment earlier may already be behind.
    source.answer({
      schedules: [
        {
          stationID: '101',
          metadata: { startDate: TODAY, md5: 'fresher-than-the-md5-pass' },
          programs: [airing('EP000000010001', 18)],
        },
      ],
    });

    await grab([site(source)], { cache, now: NOW });

    expect((await state.bag()).get(`md5:101:${TODAY}`)).toBe('fresher-than-the-md5-pass');
  });

  it('empties only the day the service refused, not the station`s other days', async () => {
    const source = await service();
    const cache = store();

    // One station with listings today and nothing tomorrow, asked about both in
    // one request: the service answers with two entries, and taking the second
    // for the station's verdict would cache today as empty.
    await grab([site(source, { days: 2 })], { cache, now: NOW });

    const guide = await collectGuide(cache, source, 2);

    expect(guide).toContain('The Six O`Clock Show');
    expect(guide).toContain('The Eight O`Clock Show');
  });

  it('stops when the service says it is offline, as the service asks', async () => {
    const source = await service();
    const report = collect();

    source.answer({
      status: {
        account: { messages: [] },
        lineups: [{ lineup: LINEUP }],
        systemStatus: [{ status: 'Offline', message: 'Maintenance until 06:00 UTC.' }],
      },
    });

    await grab([site(source)], { cache: store(), now: NOW, reporter: report.reporter });

    // The whole site, once, with the reason on it — rather than every
    // channel-day failing separately at a server that is refusing everything.
    expect((report.of('site:failed')[0]!.error as Error).message).toMatch(
      /offline.*Maintenance until.*wait at least half an hour/s,
    );
    expect(source.countOf('schedules/md5')).toBe(0);
  });

  it('carries on when the service says something it has no name for', async () => {
    const source = await service();
    const report = collect();

    source.answer({
      status: {
        account: { messages: [] },
        lineups: [{ lineup: LINEUP }],
        systemStatus: [{ status: 'Degraded', message: 'Slow today.' }],
      },
    });

    const summary = await grab([site(source)], {
      cache: store(),
      now: NOW,
      reporter: report.reporter,
    });

    // Only `Offline` is a state the service names, so anything else is news
    // rather than a verdict: said out loud, and the guide still built.
    expect(summary.fetched).toBe(2);
    expect(report.messages.some((line) => line.includes('Slow today.'))).toBe(true);
  });

  it('says when a lineup has been deleted at the headend, and grabs the rest', async () => {
    const source = await service();
    const report = collect();

    source.answer({
      status: {
        account: { messages: [] },
        lineups: [
          { lineup: LINEUP, name: 'Freeview' },
          // The service's own shape for a deleted one: `ID` where every other
          // entry says `lineup`, so a client reading one name cannot name it.
          { ID: 'GBR-DEAD-DEFAULT', modified: '1970-01-01T00:00:00Z', isDeleted: true },
        ],
      },
    });

    await grab([site(source, { lineup: undefined })], {
      cache: store(),
      now: NOW,
      reporter: report.reporter,
    });

    expect(report.messages).toContainEqual(
      expect.stringContaining('GBR-DEAD-DEFAULT has been deleted at the headend'),
    );
    // Not fetched: taking it would be grabbing a list on its way to empty.
    expect(source.callsTo('lineups/GBR-DEAD-DEFAULT')).toHaveLength(0);
    expect(source.callsTo(`lineups/${LINEUP}`)).toHaveLength(1);
  });

  it('caches a day the station does not have as empty, and remembers that it said so', async () => {
    const source = await service();
    const cache = store();
    const sites = [site(source)];

    source.failStation('202', 7020);

    const summary = await grab(sites, { cache, now: NOW });

    // Two channel-days written, one of them with nothing on it: `empty` counts
    // a subset of `fetched` rather than something beside it.
    expect(summary.fetched).toBe(2);
    expect(summary.empty).toBe(1);
    expect(summary.failed).toBe(0);

    // Said out loud, rather than a channel that quietly has no programmes.
    const before = source.calls.length;

    await grab(sites, { cache, now: NOW, staleness: { alwaysRefetchDays: 7 } });

    // Its md5 was kept, so the second run does not ask for it again.
    expect(source.calls.slice(before).filter((call) => call.path === 'schedules')).toHaveLength(0);
  });

  it('keeps a cached day the service could not answer for, rather than emptying it', async () => {
    const source = await service();
    const cache = store();
    const sites = [site(source)];

    await grab(sites, { cache, now: NOW });

    // Queued for generation: not missing, not ready.
    source.failStation('202', 7100);

    const summary = await grab(sites, { cache, now: NOW, staleness: { alwaysRefetchDays: 7 } });

    expect(summary.unchanged).toBe(2);
    expect(summary.empty).toBe(0);
    // What was already cached is still there, rather than written empty.
    expect(await cache.read({ site: SITE, channelId: idOf('202'), day: TODAY })).toHaveLength(1);
  });

  it('asks for each programme once however many airings carry it', async () => {
    const source = await service();

    // The same programme on both stations, which is what a network block is.
    source.setSchedule('101', TODAY, [airing('EP000000010001', 18)]);
    source.setSchedule('202', TODAY, [airing('EP000000010001', 18)]);

    await grab([site(source)], { cache: store(), now: NOW });

    const asked = source.callsTo('programs').flatMap((call) => call.body as string[]);

    expect(asked).toEqual(['EP000000010001']);
  });

  it('takes what the mapping options say, and refetches when they change', async () => {
    const source = await service();
    const cache = store();

    await grab([site(source)], { cache, now: NOW });

    const before = source.calls.length;

    // A different mapping: what is cached is no longer what this site would
    // write, and every md5 still matches — so without the fingerprint this would
    // be a no-op for as long as the window lasts.
    await grab([site(source, { channelId: '%s.sd.test' })], {
      cache,
      now: NOW,
      staleness: { alwaysRefetchDays: 7 },
    });

    expect(source.calls.slice(before).filter((call) => call.path === 'schedules')).toHaveLength(1);
  });

  it('files an airing on the UTC day its md5 is keyed under', async () => {
    const source = await service();
    const cache = store();

    // Half past eleven at night: the case any other day reckoning would file on
    // the day after, storing an md5 against a day that never held it.
    source.setSchedule('101', TODAY, [airing('EP000000010001', 23, 30)]);
    source.setSchedule('202', TODAY, []);

    await grab([site(source)], { cache, now: NOW });

    expect(await cache.read({ site: SITE, channelId: idOf('101'), day: TODAY })).toHaveLength(1);
  });

  it('refuses a site with no way to authenticate', () => {
    expect(() =>
      defineSchedulesDirectSite({
        site: SITE,
        username: 'someone@example.com',
        lineup: LINEUP,
      } as never),
    ).toThrow(/password/);
  });
});

describe('finding what an account has, before there is a config', () => {
  const account = (source: SdServer) =>
    schedulesDirectAccount({
      username: 'someone@example.com',
      password: 'hunter2',
      url: source.url,
    });

  it('lists the lineups the account is subscribed to', async () => {
    const source = await sdServer({
      status: {
        account: { messages: [] },
        lineups: [
          { lineup: LINEUP, name: 'Freeview', modified: '2026-09-01T00:00:00Z' },
          { lineup: 'GBR-9999999-DEFAULT', name: 'Sky' },
        ],
      },
    });

    await expect(account(source).lineups()).resolves.toEqual([
      { lineup: LINEUP, name: 'Freeview', modified: '2026-09-01T00:00:00Z' },
      { lineup: 'GBR-9999999-DEFAULT', name: 'Sky' },
    ]);
  });

  it('answers two questions on one token, which is the point of the object', async () => {
    const source = await sdServer({
      status: { account: { expires: '2026-12-01T00:00:00Z' }, lineups: [{ lineup: LINEUP }] },
      headends: [{ headend: 'W1A', lineups: [{ lineup: 'GBR-OTA-W1A' }] }],
    });
    const sd = account(source);

    await sd.lineups();
    await sd.headends({ country: 'GBR', postalCode: 'W1A' });
    await sd.status();

    // The service rate-limits authentication, and a token is good for a day.
    expect(source.countOf('token')).toBe(1);
  });

  it('says how the account stands, and what the service says about itself', async () => {
    const source = await sdServer({
      status: {
        account: {
          expires: '2026-12-01T00:00:00Z',
          messages: [{ message: 'Your account renews soon.', date: '2026-09-01T00:00:00Z' }],
        },
        lineups: [{ lineup: LINEUP }],
        systemStatus: [{ status: 'Online', message: 'All is well.' }],
      },
    });

    await expect(account(source).status()).resolves.toEqual({
      expires: '2026-12-01T00:00:00Z',
      lineups: [{ lineup: LINEUP }],
      messages: [{ message: 'Your account renews soon.', date: '2026-09-01T00:00:00Z' }],
      system: [{ status: 'Online', message: 'All is well.' }],
    });
  });

  it('lists what a region offers, in the spelling the service wants', async () => {
    const source = await sdServer({
      headends: [
        {
          headend: 'DTV-LONDON',
          transport: 'Antenna',
          location: 'London',
          lineups: [{ name: 'Freeview', lineup: LINEUP, uri: `/20141201/lineups/${LINEUP}` }],
        },
      ],
    });

    await expect(account(source).headends({ country: 'GBR', postalCode: 'W1A' })).resolves.toEqual([
      {
        headend: 'DTV-LONDON',
        transport: 'Antenna',
        location: 'London',
        lineups: [{ lineup: LINEUP, name: 'Freeview' }],
      },
    ]);

    // Its own spelling: `postalcode`, all lower case, where the option is
    // `postalCode` like every other option here.
    expect(source.callsTo('headends')[0]?.query).toBe('country=GBR&postalcode=W1A');
  });

  it('lists what is in a lineup, for writing a channel list by hand', async () => {
    const source = await service();

    await expect(account(source).stations(LINEUP)).resolves.toMatchObject([
      { xmltvId: idOf('101'), siteId: '101', name: 'BBC One', preset: '001' },
      { xmltvId: idOf('202'), siteId: '202', name: 'ITV', preset: '002' },
    ]);
  });

  it('adds and removes a lineup only when asked by name, and says what is left', async () => {
    const source = await service();
    const sd = account(source);

    await expect(sd.addLineup('GBR-OTA-W1A')).resolves.toEqual({
      message: 'Added lineup.',
      // A string on the wire for a delete and a number for an add, which is the
      // service's own documentation, not a guess.
      changesRemaining: 5,
    });
    await expect(sd.removeLineup('GBR-OTA-W1A')).resolves.toEqual({
      message: 'Deleted lineup.',
      changesRemaining: 6,
    });

    expect(source.callsTo('lineups/GBR-OTA-W1A').map((call) => call.method)).toEqual([
      'PUT',
      'DELETE',
    ]);
  });

  it('never changes the account during a grab', async () => {
    const source = await service();

    await grab([site(source)], { cache: store(), now: NOW });

    // Six adds in 24 hours with no cheap way back: a run that subscribed on
    // someone's behalf would be a bad surprise.
    expect(source.calls.every((call) => call.method === 'GET' || call.method === 'POST')).toBe(
      true,
    );
  });

  it('says what it needs when it is given no way to authenticate', () => {
    expect(() => schedulesDirectAccount({ username: 'someone@example.com' })).toThrow(
      /password or passwordSha1/,
    );
  });
});

/**
 * Schedules Direct as a source.
 *
 * A paid, curated service for the US, Canada and the UK, and the one in this
 * ecosystem whose model this package already matches: it hands out an **md5 per
 * station-day**, so a run can ask what moved before asking for anything else,
 * and a warm run costs one request for the whole site.
 *
 * Which is why this is a {@link StreamSiteConfig} rather than a
 * `request`/`parseDay` one. "This channel-day is unchanged, keep what is cached"
 * is per channel-day, and the only place that can be said per channel-day is a
 * pass yielding `unchanged: true`. A request site can only throw
 * `UnchangedError`, which keeps everything the request was for — and one request
 * here covers a whole grid, so it would almost never be true and the md5 would
 * be worth nothing.
 *
 * **No programme artwork**, deliberately, though the service has plenty and the
 * client can fetch it. Its image host answers 403 without the account token, so
 * an `<icon>` written from it would load for nobody a guide is passed to — and
 * the token cannot go in the url, since it expires in a day and a guide is a
 * file people share. The reference grabbers reach the same end by a different
 * road: neither `tv_grab_zz_sdjson` nor `tv_grab_zz_sdjson_sqlite` calls
 * `/metadata/programs` at all, and the `episodeImage` both of them do write is
 * gone from the API — absent from all 500 programmes of a real day, 499 of
 * which claim artwork exists. Station logos are unaffected and written as
 * usual: those are plain S3 and load for anyone. Reviving this needs something
 * to serve the images through, not more mapping.
 *
 * The window is reckoned in **UTC**, and there is deliberately no `dayZone`
 * option as the other two adapters have. The service keys its md5s by
 * `(stationID, UTC date)`; filing a programme under any other day would store an
 * md5 against a day that never held it, and the guide would quietly stop
 * updating around midnight.
 */

import ky, { type KyInstance } from 'ky';
import { createHash } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { chunk } from '../../core/chunk.js';
import { toDayString } from '../../core/days.js';
import { GrabberError } from '../../core/error.js';
import {
  defineStreamSiteConfig,
  type ChannelDay,
  type ChannelElement,
  type ChannelsContext,
  type GrabberChannel,
  type StreamContext,
  type StreamedChannelDay,
  type StreamSiteConfig,
} from '../types.js';
import {
  createSchedulesDirectClient,
  passwordHash,
  schedulesDirectHooks,
  type SchedulesDirectClient,
  type StationDays,
} from './client.js';
import {
  buildProgramme,
  schedulesDirectChannelExtras,
  schedulesDirectProgramme,
  schedulesDirectStation,
  type SchedulesDirectMapOptions,
  type SchedulesDirectStation,
} from './map.js';
import { decideMd5, forgetMd5, MD5_INCOMPLETE, pruneMd5, rememberMd5, storedMd5 } from './md5.js';
import {
  SD_DATE_OUT_OF_RANGE,
  SD_OK,
  SD_PROGRAM_INVALID,
  SD_PROGRAM_QUEUED,
  type WireAccountLineup,
  type WireAiring,
  type WireLineupChange,
  type WireProgram,
} from './wire.js';

/** Where the shape of the mapping is recorded, so a change to it can be noticed. */
const MAPPING = 'mapping';

/**
 * Bumped when this file changes what a cached channel-day would contain.
 *
 * With the options below it makes a fingerprint: when that differs from what the
 * bag holds, every md5 is dropped and the window is fetched again. Without it,
 * turning an option on — or fixing a mapping bug — would be a no-op for every
 * day already cached, because its md5 still matches and nothing would ever ask
 * for it again.
 */
const MAPPING_VERSION = 1;

/**
 * How many station-days one md5 call may ask about — the service's own cap.
 *
 * Its words: "you may only request 5000 programIDs, schedules, or schedule
 * MD5's per request". An md5 is per station-day, so that is what is counted. A
 * hundred stations over a fortnight is 1,400 of them; nine hundred stations
 * over the same fortnight is 12,600, which counting *stations* would have sent
 * as a single request.
 */
const MD5S_PER_REQUEST = 5000;

/**
 * How many programmes are kept in hand across the chunks of one pass.
 *
 * A network's morning block is the same programme on fifty stations, and asking
 * for it once per chunk is most of the `/programs` traffic a run makes. Bounded,
 * because the alternative is holding every programme of a fortnight: at a
 * kilobyte or two each that is the whole guide in memory to save some requests.
 */
const PROGRAMME_MEMORY = 20_000;

export interface SchedulesDirectSiteOptions
  extends
    Omit<StreamSiteConfig<SchedulesDirectStation>, 'stream' | 'channels' | 'conditionalGet'>,
    SchedulesDirectMapOptions {
  username: string;
  /** Hashed here and never kept; give {@link passwordSha1} instead to keep it out of the config. */
  password?: string;
  /** The SHA1 the service wants, for a config that never holds the password itself. */
  passwordSha1?: string;
  /**
   * The lineup to grab, as the account knows it — `USA-OTA-90210`.
   *
   * **Every lineup on the account** when this is left out, which for the usual
   * account with one is the whole of the configuration: the service says what is
   * on it, so there is nothing here worth making someone copy. Several lineups
   * merge into one channel list, a station in more than one being kept once.
   *
   * Named or not, a lineup must already be on the account: nothing here adds
   * one, since a grab that changes a paid subscription is a surprise, and the
   * service allows six such changes a day with no cheap way back.
   */
  lineup?: string | string[];
  /** The service, for a mirror or a stand-in. */
  url?: string;
  /** A channel list of your own, in place of the lineup's. */
  channels?: StreamSiteConfig<SchedulesDirectStation>['channels'];
  /**
   * How many station-days one schedule request may cover.
   *
   * The memory knob, not a limit of the service's: what is live at once is this
   * many station-days of airings and the programmes they refer to.
   */
  stationDaysPerRequest?: number;
  /** How many programmes one detail request may ask about. Under the service's cap of 5000. */
  programmesPerRequest?: number;
  /**
   * How long to wait for a programme the service is still generating, and how
   * often to ask again — `[10_000, 20_000, 30_000]` by default, which is what
   * the reference grabber waits.
   *
   * A `6001` answer means the programme is queued rather than missing, so
   * asking again immediately gets the same answer. `[]` never waits: the day is
   * written without it and fetched again on the next run, which is what happens
   * anyway when the waits run out.
   */
  queuedWaits?: readonly number[];
  /**
   * Keep the token in the cache between runs. On by default.
   *
   * The service rate-limits authentication and a token is good for a day, so
   * keeping one means one login a day rather than one a run. It is a bearer
   * credential in the cache directory, which is the reason this can be turned
   * off.
   */
  persistToken?: boolean;
}

/** What this site would write, as a short stamp — see {@link MAPPING_VERSION}. */
function mappingFingerprint(options: SchedulesDirectSiteOptions): string {
  const shape = JSON.stringify({
    version: MAPPING_VERSION,
    language: options.language ?? null,
    // A function is its source: two different ones read differently, and the
    // same one across runs reads the same.
    channelId:
      typeof options.channelId === 'function'
        ? String(options.channelId)
        : (options.channelId ?? null),
  });

  return createHash('sha1').update(shape).digest('hex').slice(0, 16);
}

/** Where the lineups' own stamps are kept, beside the list they built. */
const LINEUP_STAMPS = 'lineups';

/**
 * What the account says about the lineups a list would be built from.
 *
 * The service's steady-state advice is to download a lineup only when its
 * `modified` is newer than your copy's — so this is that stamp per lineup, with
 * two things beside it that would also make the stored list wrong: **which**
 * lineups are being taken (a config naming a different one must not match), and
 * the mapping fingerprint (a changed `channelId` builds different channels out
 * of the same answer).
 */
function stampsOf(
  lineups: string[],
  onAccount: { lineup?: string | undefined; modified?: string }[],
  fingerprint: string,
): Record<string, string> {
  const modified = new Map(onAccount.map((one) => [one.lineup, one.modified]));

  return Object.fromEntries([
    ['fingerprint', fingerprint],
    ...lineups.map((id) => [id, modified.get(id) ?? '']),
  ]);
}

/** Whether what a previous run stored says exactly what this one would. */
function sameStamps(stored: unknown, stamps: Record<string, string>): boolean {
  if (stored === null || typeof stored !== 'object') {
    return false;
  }

  const was = stored as Record<string, unknown>;
  const keys = Object.keys(stamps);

  // A stamp that is missing on either side is a difference: an unknown
  // `modified` must not read as "the same unknown".
  return (
    keys.length === Object.keys(was).length &&
    keys.every((key) => stamps[key] !== '' && was[key] === stamps[key])
  );
}

/**
 * Say what the account and the service have to say, and stop where asked to.
 *
 * `Offline` is the one that throws. It is the service's own instruction — "all
 * further processing will be rejected at the server", and a client should wait
 * rather than reconnect — so carrying on would be a run that fails call by call
 * with worse messages than this one. Anything else unexpected is a warning:
 * the service names no other state, and a guess at what `Degraded` means is not
 * worth failing someone's guide over.
 */
function sayAboutAccount(
  status: Awaited<ReturnType<SchedulesDirectClient['status']>>,
  warn: ChannelsContext['warn'],
  now: number,
  site: string,
): void {
  for (const trouble of status.systemStatus ?? []) {
    if (trouble.status === undefined || trouble.status === 'Online') {
      continue;
    }

    if (trouble.status === 'Offline') {
      throw new GrabberError(
        `${site}: Schedules Direct is offline — ${trouble.message ?? 'no detail given'}. It asks clients to wait at least half an hour before trying again`,
      );
    }

    // Not a state the service documents, so it is news rather than a verdict —
    // the difference between "the guide is short today" and "the guide is short
    // today and it is not your configuration".
    warn(`Schedules Direct is ${trouble.status}: ${trouble.message ?? 'no detail given'}`);
  }

  for (const message of status.account?.messages ?? []) {
    if (message.message !== undefined && message.message !== '') {
      warn(`Schedules Direct says: ${message.message}`);
    }
  }

  const expires =
    status.account?.expires === undefined ? Number.NaN : Date.parse(status.account.expires);

  if (Number.isNaN(expires)) {
    return;
  }

  const days = Math.ceil(Math.abs(expires - now) / 86_400_000);

  // The failure that otherwise looks like the guide mysteriously emptying one
  // morning, which is why the Xtream adapter warns a week ahead too.
  if (expires < now) {
    warn(`the Schedules Direct account expired ${String(days)} ${days === 1 ? 'day' : 'days'} ago`);
  } else if (days <= 7) {
    warn(`the Schedules Direct account expires in ${String(days)} ${days === 1 ? 'day' : 'days'}`);
  }
}

/**
 * How long to wait before asking again for a programme the service is writing.
 *
 * `6001` means queued for generation, so asking again straight away gets the
 * same answer — which is why the reference grabber sleeps `min(30, 10 × try)`
 * between attempts and gives up after three. These are those waits, and a
 * config that would rather not hold a run up sets `queuedWaits: []` and lets
 * the next run pick the programme up instead.
 */
const QUEUED_WAITS_MS: readonly number[] = [10_000, 20_000, 30_000];

/** Append to the list under `key`, starting one where there is none. */
function push<K, V>(into: Map<K, V[]>, key: K, value: V): void {
  const held = into.get(key);

  if (held === undefined) {
    into.set(key, [value]);
  } else {
    // In place: rebuilding the list per entry is a copy per airing, and a
    // station-day is forty of them.
    held.push(value);
  }
}

/** The map under `key`, starting one where there is none. */
function under<K, V>(into: Map<K, Map<string, V>>, key: K): Map<string, V> {
  const held = into.get(key);

  if (held !== undefined) {
    return held;
  }

  const fresh = new Map<string, V>();

  into.set(key, fresh);

  return fresh;
}

/** One airing, with the instant it starts already read. */
interface Airing {
  programID: string;
  at: number;
  wire: WireAiring;
}

/** The airings of one station's answer, less the ones nothing can be done with. */
function airingsOf(programs: WireAiring[] | undefined): Airing[] {
  return (programs ?? []).flatMap((wire) => {
    const at = wire.airDateTime === undefined ? Number.NaN : Date.parse(wire.airDateTime);

    return wire.programID === undefined || Number.isNaN(at)
      ? []
      : [{ programID: wire.programID, at, wire }];
  });
}

/**
 * Cut the station-days to fetch into requests of a bounded size.
 *
 * By station-*days* rather than by stations: a hundred stations over a fortnight
 * and fourteen hundred over a day are the same amount of answer, and it is the
 * answer that has to fit in memory.
 */
function chunkStationDays(
  fetching: ReadonlyMap<string, ReadonlyMap<string, unknown>>,
  size: number,
): StationDays[][] {
  const width = Math.max(1, size);
  const batches: StationDays[][] = [];
  let batch: StationDays[] = [];
  let held = 0;

  for (const [stationID, days] of fetching) {
    for (const date of chunk([...days.keys()], width)) {
      if (held + date.length > width && batch.length > 0) {
        batches.push(batch);
        batch = [];
        held = 0;
      }

      batch.push({ stationID, date });
      held += date.length;
    }
  }

  if (batch.length > 0) {
    batches.push(batch);
  }

  return batches;
}

/**
 * A site that grabs one Schedules Direct account.
 *
 * ```ts
 * defineSchedulesDirectSite({
 *   site: 'schedulesdirect',
 *   username: process.env.SD_USERNAME!,
 *   password: process.env.SD_PASSWORD!,
 *   lineup: 'USA-OTA-90210',
 * })
 * ```
 */
export function defineSchedulesDirectSite(
  options: SchedulesDirectSiteOptions,
): StreamSiteConfig<SchedulesDirectStation> {
  const {
    username,
    password,
    passwordSha1,
    lineup,
    url,
    stationDaysPerRequest = 500,
    programmesPerRequest = 500,
    queuedWaits = QUEUED_WAITS_MS,
    persistToken = true,
    // Everything the mapping reads, kept together so it can be handed on whole.
    language,
    channelId,
    programmeExtras,
    channelExtras,
    ...site
  } = options;

  if (password === undefined && passwordSha1 === undefined) {
    throw new TypeError(
      `Site "${site.site}" must define password or passwordSha1: Schedules Direct authenticates with an account`,
    );
  }

  const hashed = passwordSha1 ?? passwordHash(password!);
  const configured = lineup === undefined ? undefined : [lineup].flat();
  const mapping: SchedulesDirectMapOptions = {
    ...(language === undefined ? {} : { language }),
    ...(channelId === undefined ? {} : { channelId }),
    ...(programmeExtras === undefined ? {} : { programmeExtras }),
    ...(channelExtras === undefined ? {} : { channelExtras }),
  };

  // One stamp for the whole site: what this config would write, which both the
  // channel list and the cached days are only valid for.
  const fingerprint = mappingFingerprint(options);

  /** One client for one context, sharing the token through the site's own bag. */
  const clientFor = (context: {
    http: ChannelsContext['http'];
    state: ChannelsContext['state'];
    paced?: StreamContext<SchedulesDirectStation>['paced'];
  }): SchedulesDirectClient =>
    createSchedulesDirectClient({
      http: context.http,
      username,
      passwordSha1: hashed,
      site: site.site,
      ...(url === undefined ? {} : { url }),
      ...(context.paced === undefined ? {} : { paced: context.paced }),
      // A `SiteState` is a `Map`, which is already everything a session is.
      ...(persistToken ? { session: context.state } : {}),
    });

  return defineStreamSiteConfig<SchedulesDirectStation>({
    // A lineup changes rarely and its list costs two calls — but not never: the
    // account and lineup checks below live in `channels`, and a cached list
    // skips them, so a day is as long as this may go unverified.
    cacheChannels: { maxAgeDays: 1 },
    ...site,
    ky: { ...site.ky, hooks: schedulesDirectHooks(site.ky?.hooks) },

    /**
     * The station's own extras, composed with a caller's `channelInfo` rather
     * than replacing it — the same shape the Xtream adapter uses, and the reason
     * the station's url and ids reach the guide at all.
     */
    channelInfo(channel, element) {
      const withExtras: ChannelElement = (displayName) => {
        const built = element(displayName);

        if (channelExtras !== false && channel.data !== undefined) {
          (channelExtras ?? schedulesDirectChannelExtras)(built, channel.data);
        }

        return built;
      };

      return site.channelInfo ? site.channelInfo(channel, withExtras) : withExtras();
    },

    channels:
      options.channels ??
      (async (context: ChannelsContext): Promise<GrabberChannel<SchedulesDirectStation>[]> => {
        const client = clientFor(context);
        const status = await client.status();

        sayAboutAccount(status, context.warn, Date.now(), site.site);

        const onAccount = (status.lineups ?? [])
          .map((one) => ({ ...one, lineup: lineupIdOf(one) }))
          .filter((one) => one.lineup !== undefined);

        for (const dead of onAccount.filter((one) => one.isDeleted === true)) {
          // It still answers, with nothing new in it, so the guide thins out
          // rather than failing — which is why the service asks that this be
          // said out loud.
          context.warn(
            `the Schedules Direct lineup ${dead.lineup!} has been deleted at the headend and will stop being updated. Pick another at schedulesdirect.org`,
          );
        }

        // A deleted one is not part of "every lineup on the account": taking it
        // would be grabbing a list that is on its way to empty.
        const live = onAccount.filter((one) => one.isDeleted !== true);
        const held = live.map((one) => one.lineup!);
        const missing = configured?.filter((one) => !held.includes(one)) ?? [];

        if (missing.length > 0) {
          // Nothing here adds one, so this is where a run stops — and the
          // message has to be enough to act on, which means naming what the
          // account does have, the way a person would recognise them.
          const names = live
            .map((one) => (one.name === undefined ? one.lineup! : `${one.lineup!} (${one.name})`))
            .join(', ');

          throw new GrabberError(
            `${site.site}: the Schedules Direct account has no lineup ${missing.join(', ')} — it has ${held.length === 0 ? 'none at all' : names}. Add it at schedulesdirect.org`,
          );
        }

        const lineups = configured ?? held;

        if (lineups.length === 0) {
          throw new GrabberError(
            `${site.site}: the Schedules Direct account has no lineup on it. Add one at schedulesdirect.org`,
          );
        }

        if (configured === undefined) {
          // Said out loud because it is implicit: a lineup added to the account
          // tomorrow becomes part of this guide without the config changing.
          context.log(`grabbing every lineup on the account: ${lineups.join(', ')}`);
        }

        // What the account says about these lineups now, which is the whole of
        // what the list is built from — so a list built from the same answer is
        // still the same list.
        const stamps = stampsOf(lineups, onAccount, fingerprint);

        if (context.cached !== undefined && sameStamps(context.state.get(LINEUP_STAMPS), stamps)) {
          // The service's own advice, and it costs nothing to take: `/status`
          // carries each lineup's `modified`, so a lineup that has not moved
          // need not be downloaded again — 223 KiB and a request, for one
          // account with one lineup.
          context.log('the lineups have not changed since the last run; keeping the channel list');

          return context.cached.channels as GrabberChannel<SchedulesDirectStation>[];
        }

        const channels: GrabberChannel<SchedulesDirectStation>[] = [];
        const seen = new Set<string>();

        for (const id of lineups) {
          const answer = await client.lineup(id);
          const numbers = new Map(
            (answer.map ?? []).map((entry) => [entry.stationID, entry.channel]),
          );

          for (const wire of answer.stations ?? []) {
            // With the lineup it came from, which is what decides whose content
            // rating its viewers want — and which travels with the channel
            // through `cacheChannels` rather than needing to be learnt again.
            const channel = schedulesDirectStation(wire, numbers.get(wire.stationID), mapping, id);

            // A station in two lineups is one channel: the cache is keyed by
            // `(site, channel, day)`, so a second one would append to the first
            // and every programme would appear twice.
            if (channel === undefined || seen.has(channel.xmltvId)) {
              continue;
            }

            seen.add(channel.xmltvId);
            channels.push(channel);
          }
        }

        if (channels.length === 0) {
          throw new GrabberError(
            `${site.site}: the Schedules Direct lineup ${lineups.join(', ')} listed no stations`,
          );
        }

        // Written only now: a list that failed to build is not one whose
        // stamps should say "nothing to do" on the next run.
        context.state.set(LINEUP_STAMPS, stamps);

        return channels;
      }),

    async *stream(
      context: StreamContext<SchedulesDirectStation>,
    ): AsyncGenerator<StreamedChannelDay<SchedulesDirectStation>> {
      const { channelDays, days, state, warn, signal } = context;
      const client = clientFor(context);
      const remapped = state.get(MAPPING) !== fingerprint;

      if (!remapped) {
        // Only what has left the window, which the run has already pruned from
        // the cache — an md5 with no entry behind it is the one thing this must
        // not keep.
        pruneMd5(state, days[0] ?? toDayString(new Date()));
      } else {
        // What this site writes has changed, so what is cached is not what it
        // would write now. Every md5 still matches, which is exactly how a new
        // option becomes a no-op for a fortnight — so they all go, and pruning
        // what is already gone would be a second walk for nothing.
        forgetMd5(state);
        state.set(MAPPING, fingerprint);
      }

      /** Every channel-day asked about, by station and then by day. */
      const asked = new Map<string, Map<string, ChannelDay<SchedulesDirectStation>[]>>();

      for (const pair of channelDays) {
        push(under(asked, pair.channel.siteId), pair.day, pair);
      }

      /** The station-days worth asking for, and the md5 each will be stored under. */
      const fetching = new Map<string, Map<string, string | undefined>>();

      // One md5 pass for the whole site, which is the point of the adapter: a
      // run where nothing moved makes this request and no other. Each batch is
      // read as it lands rather than gathered first — the answers say nothing
      // about each other, so holding them all would be memory spent to arrive
      // at the same verdicts later, and a batch that fails after an earlier one
      // succeeded leaves those channel-days already settled.
      for (const batch of chunkStationDays(asked, MD5S_PER_REQUEST)) {
        const md5s = await client.schedulesMd5(batch);

        for (const { stationID, date } of batch) {
          for (const day of date ?? []) {
            const pairs = asked.get(stationID)?.get(day) ?? [];
            const wire = md5s[stationID]?.[day];
            const stored = storedMd5(state, stationID, day);
            let wanted = false;

            for (const pair of pairs) {
              // Per pair rather than per station-day: two lineups can carry one
              // station, and what is cached for one of them says nothing about
              // the other.
              const decision = decideMd5(stored, wire, pair.cached);
              // Dropping the md5s is not enough on its own to make a changed
              // mapping take effect: with none stored, the decision falls back to
              // comparing when the service last changed the day against when we
              // grabbed it — and that says "keep", which is true about the content
              // and beside the point when it is the *writing* that changed. Only
              // `keep` is overridden: a day the service has nothing for is still a
              // day there is nothing to fetch.
              const verdict = remapped && decision.verdict === 'keep' ? 'fetch' : decision.verdict;

              if (verdict === 'keep') {
                yield { channel: pair.channel, day, unchanged: true };

                if (decision.md5 !== undefined) {
                  // The first time included, where the verdict came from
                  // comparing clocks rather than content: what is cached
                  // matches this md5, so writing it down turns every run after
                  // it into the exact comparison instead of the approximate
                  // one. An md5 that is already stored re-sets to the same
                  // string, which `TrackedMap` does not count as a change.
                  rememberMd5(state, stationID, day, decision.md5);
                }
              } else if (verdict === 'empty') {
                warn(`${stationID} on ${day}: ${decision.reason ?? 'nothing published'}`);
                yield { channel: pair.channel, day, programmes: [] };

                if (decision.md5 !== undefined) {
                  rememberMd5(state, stationID, day, decision.md5);
                }
              } else if (verdict === 'unknown') {
                warn(`${stationID} on ${day}: ${decision.reason ?? 'no answer'}`);
                // Kept rather than cached empty: the service did not say there is
                // nothing on, it said it could not answer. One with nothing cached
                // is reported as a failed channel-day by the run, which is the
                // truth — and is what writing it empty would hide.
                yield { channel: pair.channel, day, unchanged: true };
              } else {
                wanted = true;
              }
            }

            if (wanted) {
              under(fetching, stationID).set(day, wire?.md5);
            }
          }
        }
      }

      /** How many stations had nothing for a day, by day — see the warning below. */
      const beyond = new Map<string, number>();
      /** The furthest day any of them said it does have. */
      let furthest = '';
      /**
       * Programmes the service says it will never have.
       *
       * Unbounded, unlike `known`, and deliberately: it holds ids rather than
       * payloads, and a run that found thousands of them has a bigger problem
       * than the memory.
       */
      const gone = new Set<string>();

      /** Programmes already in hand, across the chunks of this pass. */
      const known = new Map<string, WireProgram>();

      for (const batch of chunkStationDays(fetching, stationDaysPerRequest)) {
        // Between chunks, which is where this pass is interruptible: the calls
        // themselves abort on the run's signal through the site's client.
        signal?.throwIfAborted();

        const airings = new Map<string, Map<string, Airing[]>>();
        const missing = new Set<string>();
        /**
         * The md5 each answer carried, by station and day.
         *
         * The service answers **one entry per station-day**, each with the
         * md5 of the very listings in it — which is not necessarily the one the
         * md5 pass saw a moment earlier, since it refreshes several times a day
         * and a large grab is not instant. Storing what came with the content
         * is what stops the next run refetching a day it already has.
         */
        const written = new Map<string, string>();

        for (const schedule of await client.schedules(batch)) {
          const stationID = schedule.stationID;

          if (stationID === undefined) {
            continue;
          }

          const code = schedule.code ?? SD_OK;

          if (code !== SD_OK) {
            // In-band, at HTTP 200: one station's refusal is not the request's
            // — and, where it names a day, not the station's other days either.
            // A station asked about two days with one outside its range answers
            // with **two entries**: the good day's programmes, and this. Taking
            // it for the station's verdict would cache a day that has listings
            // as empty.
            const refused =
              schedule.requestedDate === undefined
                ? [...(fetching.get(stationID)?.keys() ?? [])]
                : [schedule.requestedDate];

            for (const day of refused) {
              for (const pair of asked.get(stationID)?.get(day) ?? []) {
                if (code === SD_DATE_OUT_OF_RANGE) {
                  yield { channel: pair.channel, day, programmes: [] };
                } else {
                  yield { channel: pair.channel, day, unchanged: true };
                }
              }

              // Only the days this entry answered for: another entry in the
              // same answer may still be carrying the rest of this station.
              fetching.get(stationID)?.delete(day);
            }

            if (code === SD_DATE_OUT_OF_RANGE) {
              // Counted rather than said one by one: a window reaching a few
              // days past what the service publishes is every station at once,
              // which is one fact and several hundred lines.
              for (const day of refused) {
                beyond.set(day, (beyond.get(day) ?? 0) + 1);
              }

              if (schedule.maxDate !== undefined && schedule.maxDate > furthest) {
                // Each refusal names the days that station does have, so the
                // window that would have fitted is in the answer rather than
                // something anyone has to work out.
                furthest = schedule.maxDate;
              }
            } else {
              warn(`${stationID}: the service answered code ${String(code)}`);
            }

            continue;
          }

          if (schedule.metadata?.startDate !== undefined && schedule.metadata.md5 !== undefined) {
            written.set(`${stationID}|${schedule.metadata.startDate}`, schedule.metadata.md5);
          }

          const byDay = under(airings, stationID);

          for (const airing of airingsOf(schedule.programs)) {
            // The UTC day, which is the day its md5 is keyed under — see the
            // note at the top about why there is no zone option here.
            push(byDay, toDayString(new Date(airing.at)), airing);

            if (!known.has(airing.programID)) {
              missing.add(airing.programID);
            }
          }
        }

        /** Programmes the service is still writing, to ask about again. */
        const queued = new Set<string>();

        /** The detail, once per programme however many airings carry it. */
        const detail = async (ids: string[]): Promise<void> => {
          for (const batch of chunk(ids, programmesPerRequest)) {
            for (const program of await client.programs(batch)) {
              if (program.programID === undefined) {
                continue;
              }

              const code = program.code ?? SD_OK;

              if (code === SD_PROGRAM_INVALID) {
                // The service will never have this one — `6000`, in-band at
                // HTTP 200. Written down as such, because the difference
                // between "not yet" and "never" is the difference between
                // asking again and asking for ever: a day is kept back until it
                // is complete, and one waiting on a programme that does not
                // exist would never be complete.
                gone.add(program.programID);
                queued.delete(program.programID);
                continue;
              }

              if (code === SD_PROGRAM_QUEUED) {
                // Being generated: worth asking again, after a wait.
                queued.add(program.programID);
                continue;
              }

              if (code !== SD_OK) {
                // Something new. Not stored, so the airing has nothing to build
                // from and its day is asked for again on the next run.
                continue;
              }

              queued.delete(program.programID);
              known.set(program.programID, program);
            }
          }
        };

        await detail([...missing]);

        for (const pause of queuedWaits) {
          if (queued.size === 0) {
            break;
          }

          context.log(
            `${String(queued.size)} programme(s) still being generated: asking again in ${String(Math.round(pause / 1000))}s`,
          );

          await wait(pause, undefined, { ...(signal === undefined ? {} : { signal }) });
          await detail([...queued]);
        }

        if (queued.size > 0) {
          // Their days are written without them and marked unfinished, so the
          // next run asks again — which is where this ends up anyway once the
          // waits run out.
          warn(
            `${String(queued.size)} programme(s) are still being generated; their days will be asked for again`,
          );
        }

        for (const [stationID, byDay] of airings) {
          for (const [day, md5] of fetching.get(stationID) ?? []) {
            const pairs = asked.get(stationID)?.get(day) ?? [];
            let complete = true;

            const programmes = (byDay.get(day) ?? []).flatMap((airing) => {
              const normalised = schedulesDirectProgramme(
                airing.wire,
                known.get(airing.programID),
                pairs[0]?.channel.data,
                mapping,
              );

              if (normalised === undefined) {
                // No title, which the DTD requires. The day is written without
                // it either way; what differs is whether it counts as finished.
                // A programme the service says it will never have does not hold
                // the day back — nothing would ever change — while one it has
                // yet to write does, so the next run asks again.
                if (!gone.has(airing.programID)) {
                  complete = false;
                }

                return [];
              }

              return [normalised];
            });

            for (const pair of pairs) {
              yield {
                channel: pair.channel,
                day,
                programmes: programmes.map((programme) =>
                  buildProgramme(pair.channel.xmltvId, programme, mapping),
                ),
              };
            }

            if (complete) {
              // What the answer itself said, where it said anything — see
              // `written` above — and what the md5 pass said otherwise.
              const hash = written.get(`${stationID}|${day}`) ?? md5;

              if (hash !== undefined) {
                rememberMd5(state, stationID, day, hash);
              }
            } else {
              // Written down as unfinished rather than left unsaid: with
              // nothing stored the next run falls back to comparing clocks,
              // which says "keep" and leaves the hole where it is.
              rememberMd5(state, stationID, day, MD5_INCOMPLETE);
            }
          }
        }

        // Bounded rather than every programme of the window: this is what not
        // asking for the same morning block on every chunk costs.
        for (const key of known.keys()) {
          if (known.size <= PROGRAMME_MEMORY) {
            break;
          }

          known.delete(key);
        }
      }

      if (beyond.size > 0) {
        // One line for the whole window rather than one per station-day: the
        // days past what the service publishes are the same days for everyone,
        // and they are cached empty, so the next run says nothing at all.
        const short = [...beyond.keys()].sort();
        const most = Math.max(...beyond.values());
        const window = short.length === 1 ? short[0]! : `${short[0]!} to ${short.at(-1)!}`;
        // What would have fitted, counted from **this window's own start** —
        // `days[0]`, not the first day that came up short — so the answer to
        // "then what should `days` be?" is in the line that raises the question.
        const fits =
          furthest === '' || days[0] === undefined
            ? undefined
            : Math.round(
                (Date.parse(`${furthest}T00:00:00Z`) - Date.parse(`${days[0]}T00:00:00Z`)) /
                  86_400_000,
              ) + 1;

        warn(
          `the service has no listings yet for ${window} on up to ${String(most)} station(s): those days are past what it publishes${
            fits === undefined || fits <= 0
              ? ''
              : ` — it goes as far as ${furthest}, which is days: ${String(fits)}`
          }`,
        );
      }
    },
  });
}

/**
 * What a call outside a grab needs to reach the account.
 *
 * {@link schedulesDirectAccount} is for a person working out what to put in a
 * config, not for a run. Nothing it does is written down — no state bag, so no
 * token is kept — because a one-off is not where a day-long credential should
 * start living.
 */
export interface SchedulesDirectAccountOptions {
  username: string;
  /** Hashed here and not kept. Or hash it yourself — see {@link passwordHash}. */
  password?: string;
  passwordSha1?: string;
  /** The service, for a mirror or a stand-in. */
  url?: string;
  /** A client of your own, for a proxy, a timeout or a signal. */
  http?: KyInstance;
}

/** One lineup, as the account lists it. */
export interface SchedulesDirectLineup {
  /** What a site's `lineup` takes — `GBR-1000014-DEFAULT`. */
  lineup: string;
  /** What a person calls it — `Freeview`. */
  name?: string;
  /** When the lineup last changed, which is not when its schedules did. */
  modified?: string;
  /**
   * The headend stopped carrying it.
   *
   * It stays on the account and keeps answering with what it last had, so
   * nothing fails — the guide just stops gaining days. A site takes every
   * lineup on the account *except* these.
   */
  deleted?: boolean;
}

/** One headend of a region, and the lineups it offers. */
export interface SchedulesDirectHeadend {
  headend: string;
  /** `Antenna`, `Cable`, `Satellite`, `DVB-T`, `IPTV`. */
  transport?: string;
  location?: string;
  lineups: { lineup: string; name?: string }[];
}

/** How the account stands, and what the service has to say. */
export interface SchedulesDirectAccountStatus {
  /** When the subscription runs out. */
  expires?: string;
  lineups: SchedulesDirectLineup[];
  /** Notices meant for the person whose account it is. */
  messages: { message: string; date?: string }[];
  /** What the service says about itself: `Online`, or why not. */
  system: { status?: string; message?: string; date?: string }[];
}

/** What changing the account answered — and how many changes are left today. */
export interface SchedulesDirectLineupChange {
  message?: string;
  /** Of six in 24 hours. A string on the wire as often as a number. */
  changesRemaining?: number;
}

/**
 * The account itself: what is on it, what could be, and what is in a lineup.
 *
 * One object rather than a function each because the service **rate-limits
 * authentication** and a token is good for a day: asking two questions through
 * one of these authenticates once, where two standalone calls would each earn a
 * token of their own. Nothing here is needed to grab — a site takes every
 * lineup on the account unless told otherwise — so this is the shortest path
 * from an account to a config that names one.
 */
export interface SchedulesDirectAccount {
  status: () => Promise<SchedulesDirectAccountStatus>;
  /** The lineups already on the account, which is what a site's `lineup` names. */
  lineups: () => Promise<SchedulesDirectLineup[]>;
  /**
   * What a region *offers*, which is a different question from what is on the
   * account.
   *
   * Not a lineup preview: `GET /lineups/preview/{id}` only answers for a lineup
   * already subscribed to, so it cannot tell anyone what they would be getting.
   */
  headends: (where: { country: string; postalCode: string }) => Promise<SchedulesDirectHeadend[]>;
  /** What is in one lineup, as channels — for writing a `channels` list by hand. */
  stations: (lineup: string) => Promise<GrabberChannel<SchedulesDirectStation>[]>;
  /**
   * Put a lineup on the account, or take it off.
   *
   * Deliberate and by name, which is the whole reason these exist here and
   * nowhere near a grab: **six adds in 24 hours** with no cheap way back, so a
   * run that quietly subscribed on someone's behalf would be a bad surprise.
   * The answer says how many changes are left.
   */
  addLineup: (lineup: string) => Promise<SchedulesDirectLineupChange>;
  removeLineup: (lineup: string) => Promise<SchedulesDirectLineupChange>;
}

/** What a lineup is called, under either of the two names the service uses. */
function lineupIdOf(wire: WireAccountLineup): string | undefined {
  const id = wire.lineup ?? wire.ID;

  return id === undefined || id === '' ? undefined : id;
}

/** A lineup as the account lists it, or nothing where it has no id. */
function accountLineup(wire: WireAccountLineup): SchedulesDirectLineup[] {
  const id = lineupIdOf(wire);

  return id === undefined
    ? []
    : [
        {
          lineup: id,
          ...(wire.name === undefined ? {} : { name: wire.name }),
          ...(wire.modified === undefined ? {} : { modified: wire.modified }),
          ...(wire.isDeleted === undefined ? {} : { deleted: wire.isDeleted }),
        },
      ];
}

/** What a change answered, with its count read however it was written. */
function lineupChange(wire: WireLineupChange): SchedulesDirectLineupChange {
  const left = Number(wire.changesRemaining);

  return {
    ...(wire.message === undefined ? {} : { message: wire.message }),
    ...(Number.isFinite(left) && wire.changesRemaining !== undefined
      ? { changesRemaining: left }
      : {}),
  };
}

/**
 * Reach an account, for the questions that come before a config.
 *
 * ```ts
 * const account = schedulesDirectAccount({ username, password });
 *
 * for (const one of await account.lineups()) {
 *   console.log(one.lineup, one.name);
 * }
 * ```
 */
export function schedulesDirectAccount(
  options: SchedulesDirectAccountOptions,
): SchedulesDirectAccount {
  if (options.password === undefined && options.passwordSha1 === undefined) {
    throw new TypeError(
      'schedulesDirectAccount must be given password or passwordSha1: Schedules Direct authenticates with an account',
    );
  }

  const client = createSchedulesDirectClient({
    // The caller's client, or a plain one — either way carrying the hooks that
    // keep the password and the token out of any error it raises.
    http: (options.http ?? ky).extend({ hooks: schedulesDirectHooks({}) }),
    username: options.username,
    passwordSha1: options.passwordSha1 ?? passwordHash(options.password!),
    ...(options.url === undefined ? {} : { url: options.url }),
  });

  return {
    status: async () => {
      const wire = await client.status();

      return {
        ...(wire.account?.expires === undefined ? {} : { expires: wire.account.expires }),
        lineups: (wire.lineups ?? []).flatMap(accountLineup),
        messages: (wire.account?.messages ?? []).flatMap((one) =>
          one.message === undefined
            ? []
            : [{ message: one.message, ...(one.date === undefined ? {} : { date: one.date }) }],
        ),
        system: wire.systemStatus ?? [],
      };
    },
    lineups: async () => (await client.status()).lineups?.flatMap(accountLineup) ?? [],
    headends: async (where) =>
      (await client.headends(where)).flatMap((wire) =>
        wire.headend === undefined || wire.headend === ''
          ? []
          : [
              {
                headend: wire.headend,
                ...(wire.transport === undefined ? {} : { transport: wire.transport }),
                ...(wire.location === undefined ? {} : { location: wire.location }),
                lineups: (wire.lineups ?? []).flatMap((one) =>
                  one.lineup === undefined || one.lineup === ''
                    ? []
                    : [
                        {
                          lineup: one.lineup,
                          ...(one.name === undefined ? {} : { name: one.name }),
                        },
                      ],
                ),
              },
            ],
      ),
    stations: async (lineup) => {
      const answer = await client.lineup(lineup);
      const numbers = new Map((answer.map ?? []).map((entry) => [entry.stationID, entry.channel]));

      return (answer.stations ?? []).flatMap((wire) => {
        const channel = schedulesDirectStation(wire, numbers.get(wire.stationID), {}, lineup);

        return channel === undefined ? [] : [channel];
      });
    },
    addLineup: async (lineup) => lineupChange(await client.addLineup(lineup)),
    removeLineup: async (lineup) => lineupChange(await client.removeLineup(lineup)),
  };
}

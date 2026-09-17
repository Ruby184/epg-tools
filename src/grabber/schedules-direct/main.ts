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
 * The window is reckoned in **UTC**, and there is deliberately no `dayZone`
 * option as the other two adapters have. The service keys its md5s by
 * `(stationID, UTC date)`; filing a programme under any other day would store an
 * md5 against a day that never held it, and the guide would quietly stop
 * updating around midnight.
 */

import { createHash } from 'node:crypto';
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
import { decideMd5, forgetMd5, pruneMd5, rememberMd5, storedMd5 } from './md5.js';
import { SD_DATE_OUT_OF_RANGE, SD_OK, type WireAiring, type WireProgram } from './wire.js';

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

/** How many station entries one schedule call may carry — the service's own cap. */
const STATIONS_PER_REQUEST = 5000;

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

/** Warn about anything the account itself has to say. */
function sayAboutAccount(
  status: Awaited<ReturnType<SchedulesDirectClient['status']>>,
  warn: ChannelsContext['warn'],
  now: number,
): void {
  for (const trouble of status.systemStatus ?? []) {
    // The service asks clients to read this, and it is the difference between
    // "the guide is short today" and "the guide is short today and it is not
    // your configuration".
    if (trouble.status !== undefined && trouble.status !== 'Online') {
      warn(`Schedules Direct is ${trouble.status}: ${trouble.message ?? 'no detail given'}`);
    }
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
  fetching: Map<string, Map<string, string | undefined>>,
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

        sayAboutAccount(status, context.warn, Date.now());

        const onAccount = (status.lineups ?? []).filter((one) => one.lineup !== undefined);
        const held = onAccount.map((one) => one.lineup!);
        const missing = configured?.filter((one) => !held.includes(one)) ?? [];

        if (missing.length > 0) {
          // Nothing here adds one, so this is where a run stops — and the
          // message has to be enough to act on, which means naming what the
          // account does have, the way a person would recognise them.
          const names = onAccount
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

        return channels;
      }),

    async *stream(
      context: StreamContext<SchedulesDirectStation>,
    ): AsyncGenerator<StreamedChannelDay<SchedulesDirectStation>> {
      const { channelDays, days, state, warn, signal } = context;
      const client = clientFor(context);
      const fingerprint = mappingFingerprint(options);
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

      // One md5 pass for the whole site, which is the point of the adapter: a
      // run where nothing moved makes this request and no other.
      const md5s: Awaited<ReturnType<SchedulesDirectClient['schedulesMd5']>> = {};

      for (const batch of chunk([...asked], STATIONS_PER_REQUEST)) {
        Object.assign(
          md5s,
          await client.schedulesMd5(
            batch.map(([stationID, byDay]): StationDays => ({
              stationID,
              date: [...byDay.keys()],
            })),
          ),
        );
      }

      /** The station-days worth asking for, and the md5 each will be stored under. */
      const fetching = new Map<string, Map<string, string | undefined>>();

      for (const [stationID, byDay] of asked) {
        for (const [day, pairs] of byDay) {
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

      /** Programmes already in hand, across the chunks of this pass. */
      const known = new Map<string, WireProgram>();

      for (const batch of chunkStationDays(fetching, stationDaysPerRequest)) {
        // Between chunks, which is where this pass is interruptible: the calls
        // themselves abort on the run's signal through the site's client.
        signal?.throwIfAborted();

        const airings = new Map<string, Map<string, Airing[]>>();
        const missing = new Set<string>();

        for (const schedule of await client.schedules(batch)) {
          const stationID = schedule.stationID;

          if (stationID === undefined) {
            continue;
          }

          const code = schedule.code ?? SD_OK;

          if (code !== SD_OK) {
            // In-band, at HTTP 200: one station's refusal is not the request's.
            for (const day of fetching.get(stationID)?.keys() ?? []) {
              for (const pair of asked.get(stationID)?.get(day) ?? []) {
                if (code === SD_DATE_OUT_OF_RANGE) {
                  yield { channel: pair.channel, day, programmes: [] };
                } else {
                  yield { channel: pair.channel, day, unchanged: true };
                }
              }
            }

            warn(
              code === SD_DATE_OUT_OF_RANGE
                ? `${stationID}: asked for days outside the ones it has`
                : `${stationID}: the service answered code ${String(code)}`,
            );
            fetching.delete(stationID);
            continue;
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

        // The detail, once per programme however many airings carry it.
        for (const ids of chunk([...missing], programmesPerRequest)) {
          for (const program of await client.programs(ids)) {
            if (program.programID !== undefined) {
              known.set(program.programID, program);
            }
          }
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
                // No title, which the DTD requires — usually a programme the
                // service could not describe. The day is written without it, and
                // its md5 is not kept, so the next run asks again.
                complete = false;

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

            if (complete && md5 !== undefined) {
              rememberMd5(state, stationID, day, md5);
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
    },
  });
}

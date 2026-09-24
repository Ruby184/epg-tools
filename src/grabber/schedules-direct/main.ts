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
import { GrabberError } from '../../core/error.js';
import type { LineupConfig, LineupEntry, LineupType } from '../../tv-grab/lineups.js';
import {
  defineStreamSiteConfig,
  type ChannelElement,
  type ChannelsAnswer,
  type ChannelsContext,
  type GrabberChannel,
  type StreamContext,
  type StreamSiteConfig,
} from '../types.js';
import {
  createSchedulesDirectClient,
  passwordHash,
  schedulesDirectHooks,
  type SchedulesDirectClient,
} from './client.js';
import {
  schedulesDirectChannelExtras,
  schedulesDirectStation,
  type SchedulesDirectMapOptions,
  type SchedulesDirectStation,
} from './map.js';
import { schedulesDirectPass } from './stream.js';
import type { WireAccountLineup, WireLineupChange } from './wire.js';

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
    // Baked into the cached day, unlike `channelExtras`, which is written onto
    // the channel at output time and so needs nothing invalidated. Without it
    // here, turning the extensions off is a no-op for a fortnight.
    programmeExtras:
      typeof options.programmeExtras === 'function'
        ? String(options.programmeExtras)
        : (options.programmeExtras ?? null),
  });

  return createHash('sha1').update(shape).digest('hex').slice(0, 16);
}

/**
 * The service's `transport` as the lineups schema's `type`.
 *
 * The same mapping the reference grabber makes — `tv_grab_zz_sdjson_sqlite`'s
 * `mapTransport` — because a consumer choosing between lineups should see the
 * same kind named the same way whichever grabber offered them: a raw multiplex
 * is `DTV`, an operator's channel map is the `STB` most people watch it
 * through, and `IPTV` is the schema's own word for what the service calls the
 * same.
 *
 * One divergence, deliberate: a transport neither of us knows is `List` — a
 * plain list of channels, which is exactly what is left when nothing is known
 * about how they arrive. The reference writes `Unknown` there, which is not one
 * of the five the schema allows.
 */
function lineupTypeOf(transport: string | undefined): LineupType {
  switch (transport) {
    case 'Antenna':
    case 'DVB-T':
    case 'DVB-C':
    case 'DVB-S':
    case 'QAM':
      return 'DTV';
    case 'Cable':
    case 'Satellite':
      return 'STB';
    case 'IPTV':
      // The reference says `STB` here, its comment calling the service's IPTV
      // "STB-like". The schema has the word the service itself uses.
      return 'IPTV';
    default:
      return 'List';
  }
}

/**
 * What a chooser shows for a lineup: `Astra FTA (Satellite National)`.
 *
 * The reference grabber's own format, and for its reason — an account can hold
 * two lineups both called `Local Broadcast Listings`, and the only thing that
 * tells them apart is where each is for.
 */
function lineupNameOf(id: string, about: AboutLineup | undefined): string {
  const said = [about?.transport, about?.location].filter((one) => one !== undefined).join(' ');
  const name = about?.name;

  if (name === undefined) {
    return said === '' ? id : `${id} (${said})`;
  }

  return said === '' ? name : `${name} (${said})`;
}

/** What one lineup is called, how it is received, and where it is for. */
interface AboutLineup {
  name?: string;
  transport?: string;
  location?: string;
}

/**
 * What the account said about the lineups a channel list was built from.
 *
 * Kept with the list — one name and one transport per lineup, where a channel
 * carries only the id of the lineup it came from — so `lineups` below is as good
 * on a run that fetched nothing as on the one that built the list. The name
 * comes from `/status` and the transport from the lineup itself, which is the
 * only place the service says how it is received.
 */
interface SchedulesDirectChannelsMetadata {
  lineups?: Record<string, AboutLineup>;
}

/** What a stored channel list of this site's says about its lineups. */
function aboutLineups(metadata: unknown): Record<string, AboutLineup> {
  const held =
    metadata === null || typeof metadata !== 'object'
      ? undefined
      : (metadata as SchedulesDirectChannelsMetadata).lineups;

  return held === null || typeof held !== 'object' ? {} : held;
}

/** One placement of a station: a lineup, and the number it sits at on it. */
function placementOf(
  lineup: string | undefined,
  channel: string | undefined,
): { lineup: string; channel?: string } {
  return {
    // Never undefined in practice — the list is built lineup by lineup — and
    // a station with no lineup behind it is one no platform can offer.
    lineup: lineup ?? '',
    ...(channel === undefined ? {} : { channel }),
  };
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
 * How long to wait before asking again for something the service is writing.
 *
 * `7100` for a schedule and `6001` for a programme both mean queued for
 * generation, so asking again straight away gets the same answer — which is why
 * the reference grabber sleeps `min(30, 10 × try)` between attempts and gives
 * up after three. These are those waits, and a config that would rather not
 * hold a run up sets `queuedWaits: []` and lets the next run pick things up.
 */
const QUEUED_WAITS_MS: readonly number[] = [10_000, 20_000, 30_000];

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

    /**
     * The account's own lineups, as platforms a `tv_grab_*` can offer.
     *
     * One per lineup on the account rather than one for the site, which is what
     * they are: somebody subscribed to each of them, and choosing between them
     * is the choice a consumer wants to make. Built from the channel list alone
     * — every placement is already on the channels — so `--list-lineups` costs
     * what the channel list costs and nothing more.
     *
     * The type is what the lineup itself says it is — `transport`, which comes
     * with the lineup rather than with the account — and `List` where this run
     * has not asked, since a list read back from the cache carries the channels
     * and not the platform they arrived on.
     */
    lineups(channels, metadata): LineupConfig[] {
      const about = aboutLineups(metadata);
      const byLineup = new Map<string, LineupEntry[]>();

      for (const channel of channels) {
        const data = channel.data;

        if (data === undefined) {
          continue;
        }

        const type = (lineup: string) => lineupTypeOf(about[lineup]?.transport);

        for (const placement of data.on ?? [placementOf(data.lineup, data.channel)]) {
          if (placement.lineup === '') {
            // A `channels` list of somebody's own, which says nothing about
            // platforms — then there are no lineups here to offer.
            continue;
          }

          const held = byLineup.get(placement.lineup) ?? [];

          held.push({
            ...(placement.channel === undefined ? {} : { preset: placement.channel }),
            // The number again, as what a box is tuned by — which is what the
            // reference grabber writes for a lineup watched through one, and
            // only where the service's number really is a number.
            ...(type(placement.lineup) === 'STB' &&
            placement.channel !== undefined &&
            /^\d+$/.test(placement.channel)
              ? { stb: [{ preset: placement.channel }] }
              : {}),
            station: {
              xmltvId: channel.xmltvId,
              name: data.name,
              ...(data.callsign === undefined ? {} : { shortName: data.callsign }),
              ...(data.broadcastLanguage === undefined ? {} : { lang: data.broadcastLanguage }),
              ...(data.logos.length === 0
                ? {}
                : { logo: data.logos.map((one) => ({ url: one.url })) }),
              type: data.isRadioStation === true ? 'Radio' : 'TV',
              ...(data.isCommercialFree === undefined
                ? {}
                : { commercialFree: data.isCommercialFree }),
            },
          });
          byLineup.set(placement.lineup, held);
        }
      }

      return [...byLineup].map(([id, entries]) => ({
        id,
        type: lineupTypeOf(about[id]?.transport),
        // What the account calls it and where it is for, which is what a person
        // choosing between them recognises — the id stands in where a list was
        // stored before there was anywhere to keep that.
        displayName: [{ value: lineupNameOf(id, about[id]) }],
        entries,
      }));
    },

    channels:
      options.channels ??
      (async (
        context: ChannelsContext,
      ): Promise<
        GrabberChannel<SchedulesDirectStation>[] | ChannelsAnswer<SchedulesDirectStation>
      > => {
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
        // Against everything on the account, deleted or not: one named in the
        // config is *there*, and still answers with what it last had. Telling
        // its owner to add a lineup they can see on their account — and
        // stopping the guide to say it — is the wrong end of the warning above.
        const missing =
          configured?.filter((one) => !onAccount.some((two) => two.lineup === one)) ?? [];

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

          // Answered as a list alone, so what the list was stored with stands:
          // the lineups it describes are the lineups it was built from.
          return context.cached.channels as GrabberChannel<SchedulesDirectStation>[];
        }

        const channels: GrabberChannel<SchedulesDirectStation>[] = [];
        const seen = new Map<string, GrabberChannel<SchedulesDirectStation>>();
        /** What each of them is called, how it arrives and where it is for. */
        const about: Record<string, AboutLineup> = {};
        // One call for all of them, and the only one that says how a lineup is
        // received and where it is for — `/status` gives a name and a stamp.
        // Asked here rather than beside the account check, because a run that
        // keeps the channel list keeps what was stored with it and asks nothing.
        const platforms = new Map(
          ((await client.lineups()).lineups ?? []).map((one) => [one.lineup, one]),
        );

        for (const id of lineups) {
          const answer = await client.lineup(id);
          const platform = platforms.get(id);

          about[id] = {
            ...(platform?.name === undefined ? {} : { name: platform.name }),
            ...(platform?.transport === undefined ? {} : { transport: platform.transport }),
            ...(platform?.location === undefined ? {} : { location: platform.location }),
          };

          const numbers = new Map(
            (answer.map ?? []).map((entry) => [entry.stationID, entry.channel]),
          );

          for (const wire of answer.stations ?? []) {
            // With the lineup it came from, which is what decides whose content
            // rating its viewers want — and which travels with the channel
            // through `cacheChannels` rather than needing to be learnt again.
            const channel = schedulesDirectStation(wire, numbers.get(wire.stationID), mapping, id);

            if (channel === undefined) {
              continue;
            }

            const already = seen.get(channel.xmltvId);

            if (already?.data !== undefined) {
              // A station in two lineups is one channel: the cache is keyed by
              // `(site, channel, day)`, so a second one would append to the
              // first and every programme would appear twice. Where it sits on
              // each is kept, since that is a fact about the platforms rather
              // than about the channel — see `SchedulesDirectStation.on`.
              already.data.on ??= [placementOf(already.data.lineup, already.data.channel)];
              already.data.on.push(placementOf(id, channel.data?.channel));

              continue;
            }

            seen.set(channel.xmltvId, channel);
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

        // The list, and what the account said about the lineups it came from —
        // one entry in the cache, so a run that fetches nothing still knows what
        // to call each platform and how it is received.
        return { channels, metadata: { lineups: about } satisfies SchedulesDirectChannelsMetadata };
      }),

    stream: (context) =>
      schedulesDirectPass(context, {
        client: clientFor(context),
        mapping,
        fingerprint,
        stationDaysPerRequest,
        programmesPerRequest,
        queuedWaits,
      }),
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

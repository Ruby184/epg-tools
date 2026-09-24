/**
 * One grab of a Schedules Direct account: the pass, and nothing else.
 *
 * Apart from the site for the reason the client is: it is the longest thing
 * here and the only part that talks to three endpoints in a row, while the file
 * beside it is options, an account and a channel list. What it does, in order:
 * ask which station-days moved, wait for any the service is still writing, ask
 * for those that did, fill in the programmes they name, and write each day out
 * with the md5 it came with.
 */

import { chunk } from '../../core/chunk.js';
import { toDayString } from '../../core/days.js';
import { setTimeout as wait } from 'node:timers/promises';
import {
  buildProgramme,
  schedulesDirectProgramme,
  type SchedulesDirectMapOptions,
  type SchedulesDirectStation,
} from './map.js';
import { decideMd5, forgetMd5, MD5_INCOMPLETE, pruneMd5, rememberMd5, storedMd5 } from './md5.js';
import type { ChannelDay, StreamContext, StreamedChannelDay } from '../types.js';
import type { SchedulesDirectClient, StationDays } from './client.js';
import {
  SD_DATE_OUT_OF_RANGE,
  SD_OK,
  SD_PROGRAM_INVALID,
  SD_PROGRAM_QUEUED,
  SD_SCHEDULE_QUEUED,
  type WireAiring,
  type WireMd5,
  type WireProgram,
} from './wire.js';

/** Where the shape of the mapping is recorded, so a change to it can be noticed. */
export const MAPPING = 'mapping';

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
 * How many programmes to keep in hand across the chunks of one pass.
 *
 * A network's morning block is the same programme on fifty stations, and asking
 * for it once per chunk is most of the `/programs` traffic a run makes. Bounded,
 * because the alternative is holding every programme of a fortnight: at a
 * kilobyte or two each that is the whole guide in memory to save some requests.
 */
const PROGRAMME_MEMORY = 20_000;

/** What the pass needs of the site it belongs to. */
export interface SchedulesDirectPassDeps {
  client: SchedulesDirectClient;
  mapping: SchedulesDirectMapOptions;
  /** What this site would write, so a change to it can invalidate the md5s. */
  fingerprint: string;
  stationDaysPerRequest: number;
  programmesPerRequest: number;
  /** See `queuedWaits` on the site's options. */
  queuedWaits: readonly number[];
}

/** One airing, with the instant it starts already read. */
interface Airing {
  programID: string;
  at: number;
  wire: WireAiring;
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

export async function* schedulesDirectPass(
  context: StreamContext<SchedulesDirectStation>,
  deps: SchedulesDirectPassDeps,
): AsyncGenerator<StreamedChannelDay<SchedulesDirectStation>> {
  const { channelDays, days, state, warn, signal } = context;
  const { client, mapping, fingerprint, stationDaysPerRequest, programmesPerRequest, queuedWaits } =
    deps;
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

  /** Station-days the service said it is still writing, to ask about again. */
  let writing = new Map<string, Map<string, ChannelDay<SchedulesDirectStation>[]>>();

  /**
   * What to do about one station-day, said out loud.
   *
   * A generator because the answer is up to one emission per channel-day,
   * and it is reached from two places: the pass over the whole site, and
   * the pass over whatever the service was still writing at the time.
   */
  const settle = function* (
    stationID: string,
    day: string,
    pairs: ChannelDay<SchedulesDirectStation>[],
    wire: WireMd5 | undefined,
    mayWait: boolean,
  ): Generator<StreamedChannelDay<SchedulesDirectStation>> {
    if (mayWait && (wire?.code ?? SD_OK) === SD_SCHEDULE_QUEUED) {
      // `7100`: the service is generating this schedule, which is not the
      // same as not having it. Asking again is the answer — after a wait,
      // since it is not done yet — and saying anything now would be saying
      // the wrong thing: an uncached day reported unchanged is a failure.
      under(writing, stationID).set(day, pairs);

      return;
    }

    const stored = storedMd5(state, stationID, day);
    let wanted = false;

    for (const pair of pairs) {
      // Per pair rather than per station-day: two lineups can carry one
      // station, and what is cached for one of them says nothing about the
      // other.
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
          // The first time included, where the verdict came from comparing
          // clocks rather than content: what is cached matches this md5, so
          // writing it down turns every run after it into the exact
          // comparison instead of the approximate one. An md5 that is
          // already stored re-sets to the same string, which `TrackedMap`
          // does not count as a change.
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
  };

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
        yield* settle(
          stationID,
          day,
          asked.get(stationID)?.get(day) ?? [],
          md5s[stationID]?.[day],
          queuedWaits.length > 0,
        );
      }
    }
  }

  for (const [at, pause] of queuedWaits.entries()) {
    if (writing.size === 0) {
      break;
    }

    const owed = writing;
    const count = [...owed.values()].reduce((sum, days) => sum + days.size, 0);

    writing = new Map();
    context.log(
      `${String(count)} station-day(s) still being generated: asking again in ${String(Math.round(pause / 1000))}s`,
    );

    await wait(pause, undefined, { ...(signal === undefined ? {} : { signal }) });

    // The last wait settles whatever comes back, however it comes back:
    // another `7100` there is one for the next run rather than this one.
    const last = at === queuedWaits.length - 1;

    for (const batch of chunkStationDays(owed, MD5S_PER_REQUEST)) {
      const md5s = await client.schedulesMd5(batch);

      for (const { stationID, date } of batch) {
        for (const day of date ?? []) {
          yield* settle(
            stationID,
            day,
            owed.get(stationID)?.get(day) ?? [],
            md5s[stationID]?.[day],
            !last,
          );
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
            (Date.parse(`${furthest}T00:00:00Z`) - Date.parse(`${days[0]}T00:00:00Z`)) / 86_400_000,
          ) + 1;

    warn(
      `the service has no listings yet for ${window} on up to ${String(most)} station(s): those days are past what it publishes${
        fits === undefined || fits <= 0
          ? ''
          : ` — it goes as far as ${furthest}, which is days: ${String(fits)}`
      }`,
    );
  }
}

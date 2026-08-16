import ky from 'ky';
import PQueue from 'p-queue';
import { DEFAULT_STALENESS, isStale } from '../cache/main.js';
import type { ChannelDayKey, StalenessPolicy } from '../cache/types.js';
import { dayRange, dayToDate, toDayString } from '../core/days.js';
import type { GrabberChannel, GrabOptions, GrabSummary, GrabTaskError, SiteConfig } from './types.js';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function grab(configs: SiteConfig<any>[], options: GrabOptions): Promise<GrabSummary> {
  const now = options.now ?? new Date();
  const startDay = options.startDay ?? toDayString(now);
  const log = options.logger ?? (() => {});
  const { cache, signal } = options;

  let fetched = 0;
  let fromCache = 0;
  const failed: GrabTaskError[] = [];

  const runSite = async (config: SiteConfig<any>): Promise<void> => {
    const channels = typeof config.channels === 'function' ? await config.channels() : config.channels;
    const http = ky.create(config.ky ?? {});
    const days = config.days ?? options.days ?? 7;
    const policy: StalenessPolicy = { ...DEFAULT_STALENESS, ...options.staleness, ...config.staleness };
    const grabbedAt = now.toISOString();

    const inner = new PQueue({
      concurrency: config.concurrency ?? 1,
      ...(config.delayMs !== undefined && config.delayMs > 0
        ? { interval: config.delayMs, intervalCap: 1 }
        : {}),
    });

    // Parse one channel's slice out of `data` and cache it for the day.
    const store = async (channel: GrabberChannel, date: Date, day: string, data: unknown): Promise<void> => {
      const parsed = await config.parseDay({ channel, date, day, data });
      const programmes = parsed
        .map((programme) => ({ ...programme, channel: channel.xmltvId }))
        .sort((a, b) => a.start.getTime() - b.start.getTime());

      await cache.write({ site: config.site, channelId: channel.xmltvId, day }, programmes, { grabbedAt });
      fetched++;
      log(`[${config.site}] ${channel.xmltvId} ${day}: ${programmes.length} programmes`);
    };

    // Split a day's channels into those needing a refetch (stale) vs served
    // from cache. The meta reads are local, so they run off the request queue.
    const partitionStale = async (day: string): Promise<GrabberChannel[]> => {
      const stale: GrabberChannel[] = [];

      await Promise.all(channels.map(async (channel) => {
        const meta = await cache.getMeta({ site: config.site, channelId: channel.xmltvId, day });

        if (isStale(day, meta, policy, now)) {
          stale.push(channel);
        } else {
          fromCache++;
          log(`[${config.site}] ${channel.xmltvId} ${day}: fresh in cache, skipping`);
        }
      }));

      return stale;
    };

    if (config.fetchDayBatch) {
      const fetchDayBatch = config.fetchDayBatch;
      const batchSize = config.batchSize && config.batchSize > 0 ? config.batchSize : Number.POSITIVE_INFINITY;

      for (const day of dayRange(startDay, days)) {
        const stale = await partitionStale(day);
        const date = dayToDate(day);

        for (let i = 0; i < stale.length; i += batchSize) {
          const group = stale.slice(i, i + batchSize);

          void inner.add(async () => {
            let data: unknown;

            try {
              if (signal?.aborted) {
                throw signal.reason;
              }

              data = await fetchDayBatch({ channels: group, date, day, http, ...(signal ? { signal } : {}) });
            } catch (error) {
              // A failed batch request fails every channel-day it covered.
              for (const channel of group) {
                failed.push({ site: config.site, channelId: channel.xmltvId, day, error });
              }

              log(`[${config.site}] batch ${day} (${group.length} channels): ${errorMessage(error)}`);
              return;
            }

            // Parsing/caching is per channel, so one bad channel doesn't sink the batch.
            await Promise.all(group.map(async (channel) => {
              try {
                await store(channel, date, day, data);
              } catch (error) {
                failed.push({ site: config.site, channelId: channel.xmltvId, day, error });
                log(`[${config.site}] ${channel.xmltvId} ${day}: ${errorMessage(error)}`);
              }
            }));
          });
        }
      }

      await inner.onIdle();
      return;
    }

    const fetchDay = config.fetchDay;

    if (!fetchDay) {
      throw new Error(`Site "${config.site}" must define fetchDay or fetchDayBatch`);
    }

    for (const channel of channels) {
      for (const day of dayRange(startDay, days)) {
        void inner.add(async () => {
          try {
            if (signal?.aborted) {
              throw signal.reason;
            }

            const key: ChannelDayKey = { site: config.site, channelId: channel.xmltvId, day };
            const meta = await cache.getMeta(key);

            if (!isStale(day, meta, policy, now)) {
              fromCache++;
              log(`[${config.site}] ${channel.xmltvId} ${day}: fresh in cache, skipping`);
              return;
            }

            const date = dayToDate(day);
            const data = await fetchDay({ channel, date, day, http, ...(signal ? { signal } : {}) });
            await store(channel, date, day, data);
          } catch (error) {
            failed.push({ site: config.site, channelId: channel.xmltvId, day, error });
            log(`[${config.site}] ${channel.xmltvId} ${day}: ${errorMessage(error)}`);
          }
        });
      }
    }

    await inner.onIdle();
  };

  const outer = new PQueue({ concurrency: Math.max(1, options.siteConcurrency ?? configs.length) });

  await Promise.all(
    configs.map((config) =>
      outer.add(async () => {
        try {
          await runSite(config);
        } catch (error) {
          failed.push({ site: config.site, channelId: '*', day: '*', error });
          log(`[${config.site}] site failed: ${errorMessage(error)}`);
        }
      }),
    ),
  );

  return { fetched, fromCache, failed };
}

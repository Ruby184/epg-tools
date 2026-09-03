/**
 * `epg try` — one site, one channel, one day, with the working shown.
 *
 * What a site author actually needs while writing one: the request that went
 * out, the bytes that came back, and the programmes those bytes parsed to. A
 * grab shows none of it. `--verbose` says a request was made and how long it
 * took, and the framework genuinely does not know more than that — a site
 * builds its own url inside its own `request`, through the client it was given,
 * so nothing above it ever sees one.
 *
 * Which is why the client is what gets instrumented. Hooks on the site's own ky
 * instance are the only place a url exists, and they are composed the way
 * `revalidationHooks` composes: ours around the site's, never instead of them.
 *
 * Nothing is written, and no cache is opened at all. Trying a site cannot
 * poison the guide a run would build — and, just as important, cannot make the
 * next run think the day is already done. A site that keeps its channel list
 * between runs is asked for it afresh here, which is what trying it means.
 */

import type { KyInstance, KyRequest, Options as KyOptions } from 'ky';
import type { Writable } from 'node:stream';
import { resolveConfigSource, type ConfigSource } from '../config.js';
import { toDayString } from '../core/days.js';
import { GrabberError } from '../core/error.js';
import { writeFlushed } from '../core/streams.js';
import { resolveChannels, siteHttp } from '../grabber/channels.js';
import { parseContext, requestContext, streamContext } from '../grabber/context.js';
import { planRequests } from '../grabber/planner.js';
import { resolveSite } from '../grabber/site.js';
import type { AnySiteConfig, GrabberChannel, ParsedProgramme } from '../grabber/types.js';
import { ProgrammeBuilder } from '../xmltv/builder.js';
import { serializeProgramme } from '../xmltv/serialize.js';
import type { XmltvProgramme } from '../xmltv/types.js';

/** How much of a payload is shown when nothing says otherwise. */
const PAYLOAD_PREVIEW = 2000;

export interface TryOptions {
  /** The day, as `YYYY-MM-DD`. Defaults to today. */
  day?: string;
  /** Show the payload whole, however long it is. */
  raw?: boolean;
  signal?: AbortSignal;
}

/** One request as it happened, which only the client can say. */
interface Attempt {
  method: string;
  url: string;
  status?: number;
  ms: number;
  bytes?: number;
  type?: string;
}

/** The site named, or a message naming the ones there are. */
function siteNamed(sites: AnySiteConfig[], name: string): AnySiteConfig {
  const found = sites.find((site) => site.site === name);

  if (found !== undefined) {
    return found;
  }

  const known = sites.map((site) => site.site).join(', ');

  throw new GrabberError(
    `No site "${name}" in the config${known === '' ? '' : ` (it has: ${known})`}`,
  );
}

/**
 * The channel named, by either of its two ids.
 *
 * Both, because a site author holds both and should not have to remember which
 * one this command wants — `xmltvId` is what the guide calls it and `siteId` is
 * what the source does.
 */
function channelNamed(channels: GrabberChannel[], name: string): GrabberChannel {
  const found = channels.find((channel) => channel.xmltvId === name || channel.siteId === name);

  if (found !== undefined) {
    return found;
  }

  const known = channels
    .slice(0, 10)
    .map((channel) => channel.xmltvId)
    .join(', ');

  throw new GrabberError(
    `No channel "${name}" on this site (${channels.length} known${known === '' ? '' : `: ${known}${channels.length > 10 ? ', …' : ''}`})`,
  );
}

/**
 * Hooks that record what went out and what came back, around the site's own.
 *
 * Ours first on the way out and last on the way back, so a site's own hooks see
 * a request before we have described it and a response before we have measured
 * it — the same ordering `revalidationHooks` keeps, and for the same reason:
 * what is reported should be what the site actually sent and received.
 */
function recordingHooks(
  hooks: KyOptions['hooks'],
  into: Attempt[],
): NonNullable<KyOptions['hooks']> {
  const started = new WeakMap<KyRequest, number>();

  return {
    ...hooks,
    beforeRequest: [
      ({ request }) => {
        started.set(request, Date.now());
        into.push({ method: request.method, url: request.url, ms: 0 });
      },
      ...(hooks?.beforeRequest ?? []),
    ],
    afterResponse: [
      ...(hooks?.afterResponse ?? []),
      async ({ request, response }) => {
        const attempt = into.findLast((candidate) => candidate.url === request.url);

        if (attempt !== undefined) {
          attempt.ms = Date.now() - (started.get(request) ?? Date.now());
          attempt.status = response.status;

          const type = response.headers.get('content-type');

          if (type !== null) {
            attempt.type = type;
          }

          // The clone ky hands this hook is what makes reading it safe: the
          // site still gets an unread body, which is the whole point of being
          // given a clone rather than the response.
          const length = response.headers.get('content-length');

          attempt.bytes =
            length !== null ? Number(length) : (await response.clone().arrayBuffer()).byteLength;
        }

        return response;
      },
    ],
  };
}

function bytes(value: number | undefined): string {
  if (value === undefined) {
    return '';
  }

  return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(1)} KB`;
}

/** Whatever a payload is, as something a person can look at. */
function shown(payload: unknown, raw: boolean): string {
  const text =
    typeof payload === 'string'
      ? payload
      : (JSON.stringify(payload, undefined, 2) ?? String(payload));

  if (raw || text.length <= PAYLOAD_PREVIEW) {
    return text;
  }

  return `${text.slice(0, PAYLOAD_PREVIEW)}\n… ${text.length - PAYLOAD_PREVIEW} more characters (--raw for all of it)`;
}

function indent(text: string, pad = '    '): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? line : `${pad}${line}`))
    .join('\n');
}

/** What a parse produced, as the guide would carry it. */
function built(parsed: ParsedProgramme[]): XmltvProgramme[] {
  return parsed
    .map((entry) => (entry instanceof ProgrammeBuilder ? entry.build() : entry))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * Put one channel-day of one site through the whole path, and say what happened
 * at every step.
 */
export async function tryChannelDay(
  source: ConfigSource,
  siteName: string,
  channelName: string,
  stdout: Writable,
  options: TryOptions = {},
): Promise<number> {
  const config = await resolveConfigSource(source);
  const day = options.day ?? toDayString(new Date());
  const site = siteNamed(config.sites, siteName);

  // The same reading a run makes, so a site that a run would refuse is refused
  // here in the same words — one day of window, since that is what this is.
  const resolved = resolveSite(site, { days: 1 }, day);

  const attempts: Attempt[] = [];
  const http: KyInstance = siteHttp(
    { ...site, ky: { ...site.ky, hooks: recordingHooks(site.ky?.hooks, attempts) } },
    options.signal,
  );

  const lines: string[] = [];
  const says = {
    log: (message: string) => lines.push(`    [log]  ${message}`),
    warn: (message: string) => lines.push(`    [warn] ${message}`),
  };

  const channels = await resolveChannels(site, {
    http,
    says,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const channel = channelNamed(channels, channelName);

  await writeFlushed(stdout, `${site.site} → ${channel.xmltvId} on ${day}\n`);

  // Through the planner, so batching behaves exactly as it would in a run — a
  // site that asks for a week at a time is asked for a week here too, and what
  // it does with one day of it is the thing being tried.
  const [request] = planRequests({
    channels: [channel],
    window: [day],
    stale: [{ channel, day }],
    batching: resolved.batching,
  });

  if (request === undefined) {
    throw new GrabberError(`Nothing to ask for ${channel.xmltvId} on ${day}`);
  }

  const deps = {
    http,
    state: new Map<string, unknown>(),
    says,
    ...(options.signal ? { signal: options.signal } : {}),
  };

  const began = Date.now();
  let parsed: ParsedProgramme[];
  let payload: unknown;

  if (resolved.isStreaming) {
    const wanted: ParsedProgramme[] = [];

    for await (const emission of resolved.config.stream(streamContext(request, deps))) {
      if (emission.channel.xmltvId !== channel.xmltvId || emission.day !== day) {
        continue;
      }

      if (emission.unchanged === true) {
        // Which a try cannot honour: there is nothing cached to keep, because
        // nothing here has a cache worth the name.
        says.warn('the pass said this channel-day is unchanged, so it sent no programmes');
        continue;
      }

      wanted.push(...emission.programmes);
    }

    parsed = wanted;
    payload = `(a stream site: ${wanted.length} programmes came out of the pass)`;
  } else {
    payload = await resolved.config.request(requestContext(request, resolved.batching, deps));
    parsed = await resolved.config.parseDay(
      // A request made from inside a parse simply runs: there is no queue to
      // pace it against, since this is the only thing happening.
      parseContext(channel, day, payload, { ...deps, paced: (task) => task({}) }),
    );
  }

  const programmes = built(parsed);
  const out: string[] = [''];

  for (const attempt of attempts) {
    const said = [
      attempt.status === undefined ? 'no response' : String(attempt.status),
      `${attempt.ms}ms`,
      bytes(attempt.bytes),
      attempt.type,
    ]
      .filter((part) => part !== undefined && part !== '')
      .join(', ');

    out.push(`  ${attempt.method} ${attempt.url}`, `    → ${said}`);
  }

  if (attempts.length === 0) {
    // Which is not a failure: a site may answer from something it already has.
    out.push('  (no request was made)');
  }

  out.push('', '  payload', indent(shown(payload, options.raw === true)), '');
  out.push(...lines);

  if (lines.length > 0) {
    out.push('');
  }

  out.push(
    `  ${programmes.length} programme${programmes.length === 1 ? '' : 's'} in ${Date.now() - began}ms`,
  );

  for (const programme of programmes) {
    out.push(indent(serializeProgramme(programme, { indent: 2 }).trimEnd(), '  '));
  }

  await writeFlushed(stdout, `${out.join('\n')}\n`);

  // A day that parsed to nothing is the commonest thing a site author is here
  // to look at, and it is not an error — but it is not a success either, and a
  // shell loop over channels should be able to tell.
  return programmes.length > 0 ? 0 : 1;
}

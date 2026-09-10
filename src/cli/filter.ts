/**
 * `epg filter` — keep some channels of a guide that already exists.
 *
 * The other half of `--channels`. That one narrows a run, which needs a config
 * and produces a guide of your own; this takes a guide somebody else wrote and
 * hands back the part of it you wanted, needing no project at all.
 *
 * Constant memory throughout, which is the whole reason it is here: `tv_grep`,
 * the Perl equivalent, holds the document. A 90 MiB guide should not need 400
 * MiB of heap to have most of it thrown away.
 */

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Writable } from 'node:stream';
import { guideBytes, writeOutput, type OutputTarget } from '../core/output.js';
import { parseXmltvStream } from '../xmltv/parse.js';
import { outputOptions, XmltvSerializeStream } from '../xmltv/serialize.js';
import type { SerializeOptions } from '../xmltv/serialize.js';
import type { XmltvParseEvent } from '../xmltv/types.js';

export interface FilterOptions {
  /**
   * Keep only these channels. Omit to keep every one, which is only useful
   * alongside something that reshapes the guide instead — a profile, an
   * extension policy, an indent.
   */
  channels?: ReadonlySet<string>;
  /** Where it goes. */
  output: OutputTarget;
  /** Which provider extensions survive — `--extensions` / `--no-extensions`. */
  extensions?: SerializeOptions['extensions'];
  /** Pretty-print with this indentation. Compact by default. */
  indent?: string | number;
  /**
   * Shape the guide for one consumer — see {@link SerializeOptions.profile}.
   *
   * Never inherited from a config here, unlike everywhere else: on a guide
   * somebody else wrote, and which this rewrites in place or to one output,
   * reshaping is a thing to ask for each time rather than a setting to forget.
   */
  profile?: SerializeOptions['profile'];
  /** Where a parse warning and the shortfall are said. */
  stderr?: Writable;
  signal?: AbortSignal;
}

/** What a filtered guide turned out to hold. */
export interface FilterReport {
  /** Channels kept, of those asked for. */
  kept: number;
  /** Programmes kept. */
  programmes: number;
  /** Asked for and not in this guide at all. */
  missing: string[];
}

/**
 * Keep the wanted channels of `file`, and everything on them.
 *
 * Returns what it did, so a caller can decide whether an id the guide never
 * mentioned is worth an exit code.
 */
export async function filterGuide(file: string, options: FilterOptions): Promise<FilterReport> {
  const { channels: wanted, signal } = options;
  const seen = new Set<string>();
  let programmes = 0;

  /** Everything the guide says, minus the channels nobody asked for. */
  async function* kept(): AsyncGenerator<XmltvParseEvent> {
    const source = parseXmltvStream(guideBytes(file), ...(signal ? [{ signal }] : []));

    for await (const event of source) {
      if (event.type === 'channel') {
        if (wanted !== undefined && !wanted.has(event.value.id)) {
          continue;
        }

        seen.add(event.value.id);
      } else if (event.type === 'programme') {
        // By the channel it names, not by what was kept above: a guide is not
        // obliged to describe a channel before it schedules one, and dropping a
        // programme for arriving early would silently lose a day of it.
        if (wanted !== undefined && !wanted.has(event.value.channel)) {
          continue;
        }

        programmes++;
      }

      yield event;
    }
  }

  const serializer = new XmltvSerializeStream({
    ...outputOptions(options),
    ...(signal ? { signal } : {}),
  });

  // A foreign guide is exactly where these matter — it is the one document this
  // package did not write — so they are said rather than swallowed.
  serializer.on('warning', (warning: { line: number; message: string }) => {
    options.stderr?.write(`guide line ${warning.line}: ${warning.message}\n`);
  });

  // So `writeOutput` is handed text rather than buffers to re-decode.
  serializer.setEncoding('utf8');

  // `pipeline` for the pump and `Promise.all` to read it at the same time,
  // rather than `.pipe`: a bare pipe swallows the read side's errors, and a
  // truncated guide would then look exactly like a short one.
  const pumped = pipeline(Readable.from(kept(), { objectMode: true }), serializer);

  await Promise.all([
    writeOutput(options.output, serializer, {
      ...(signal ? { signal } : {}),
    }),
    pumped,
  ]);

  return {
    kept: seen.size,
    programmes,
    // Nothing was asked for, so nothing can be missing.
    missing: wanted === undefined ? [] : [...wanted].filter((id) => !seen.has(id)),
  };
}

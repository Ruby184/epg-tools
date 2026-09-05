/**
 * `epg validate` — read a guide and say what is wrong with it.
 *
 * The finding itself is [`validateXmltv`](../xmltv/validate.ts)'s; this is what
 * a command adds to it: where the document is, what to decompress it with, and
 * the two shapes the answer comes in.
 *
 * `--format` is the shape of *this command's* output, which is a different
 * question from `--reporter` — how a run narrates itself as it goes, a stream
 * of events with no end until the run has one. A report is the opposite: one
 * document, written once, about a file that already exists, and what a CI step
 * wants is that — an `ok` to branch on and a list to print, not a log to parse.
 *
 * The flag was `--report` first, one letter from `--reporter` and asking to be
 * confused with it.
 */

import { createReadStream } from 'node:fs';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { compressionFromName, decompressor } from '../core/output.js';
import type { CompressionFormat } from '../core/output.js';
import { validateXmltv, type ValidationReport } from '../xmltv/validate.js';

/** How the report is written. */
export const REPORT_FORMATS = ['text', 'json'] as const;

export type ReportFormat = (typeof REPORT_FORMATS)[number];

export interface ValidateFileOptions {
  strict?: boolean;
  signal?: AbortSignal;
  /**
   * What the bytes are compressed with, when the caller knows better than the
   * name does — `false` for a plain document whatever it is called.
   *
   * The mirror of `compress` on the writing side, which outranks the extension
   * in both directions: a config that wrote gzip to `guide.xml` has to be read
   * back as gzip, and one that wrote plain XML to `guide.xml.gz` must not be
   * gunzipped.
   */
  compression?: CompressionFormat | false;
}

/**
 * Validate the document at `file`, decompressing it when its name says to.
 *
 * The name, because it is usually all there is to go on and it is what the
 * writing side promised — `epg build -o guide.xml.gz` wrote gzip, so validating
 * the same path has to undo it rather than reporting that a guide of compressed
 * bytes is not XML. A caller holding the config that wrote the file knows
 * better, and says so with `compression`.
 */
export async function validateFile(
  file: string,
  options: ValidateFileOptions = {},
): Promise<ValidationReport> {
  // `false` is an answer, not an absence: it says the file is plain whatever it
  // is called, so it must not fall through to the name.
  const compression =
    options.compression === undefined
      ? compressionFromName(file)
      : options.compression === false
        ? undefined
        : options.compression;
  const bytes = createReadStream(file);
  const parseOptions = {
    ...(options.strict === undefined ? {} : { strict: options.strict }),
    ...(options.signal ? { signal: options.signal } : {}),
  };

  if (compression === undefined) {
    return validateXmltv(bytes, parseOptions);
  }

  // `pipeline`, not `pipe`: a missing file or a truncated archive fails on the
  // read side, and a bare `pipe` forwards none of that — the error would go
  // uncaught while the reader waited on a stream that had already given up.
  const source = new PassThrough();
  const pumped = pipeline(bytes, decompressor(compression), source);
  const [report] = await Promise.all([validateXmltv(source, parseOptions), pumped]);

  return report;
}

/** `1204` as `1,204` — a count worth reading at a glance. */
function grouped(value: number): string {
  return value.toLocaleString('en-US');
}

function plural(value: number, noun: string): string {
  return `${grouped(value)} ${noun}${value === 1 ? '' : 's'}`;
}

/**
 * The report as text: what was read, then a block per rule, then the totals.
 *
 * Rules rather than occurrences, which is what the report holds — a guide where
 * every programme carries an extension is one line and a count, not a hundred
 * thousand lines.
 */
function asText(report: ValidationReport, file: string): string {
  const head = `${file} — ${plural(report.channels, 'channel')}, ${plural(report.programmes, 'programme')}`;

  if (report.findings.length === 0) {
    return `${head}: nothing to report`;
  }

  const blocks = report.findings.map((finding) => {
    const label = finding.severity === 'error' ? 'error  ' : 'warning';
    // The count is what says how often; the lines under it are examples, and
    // deliberately not "and N more" — they are deduplicated, so the remainder
    // is a number of *occurrences*, which would read as undisclosed examples.
    const head = `  ${label} ${finding.code} (${grouped(finding.count)}): ${finding.message}`;

    return [head, ...finding.examples.map((example) => `      ${example}`)].join('\n');
  });

  const totals = [plural(report.errors, 'error'), plural(report.warnings, 'warning')].join(', ');

  return `${head}\n\n${blocks.join('\n')}\n\n${totals}`;
}

/** The report as one JSON document — an `ok` to branch on, and the findings. */
function asJson(report: ValidationReport, file: string): string {
  return JSON.stringify({ file, ...report }, undefined, 2);
}

export function renderReport(report: ValidationReport, file: string, format: ReportFormat): string {
  return format === 'json' ? asJson(report, file) : asText(report, file);
}

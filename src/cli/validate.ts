/**
 * `epg validate` — read a guide and say what is wrong with it.
 *
 * The finding itself is [`validateXmltv`](../xmltv/validate.ts)'s; this is what
 * a command adds to it: where the document is, what to decompress it with, and
 * the two shapes the answer comes in.
 *
 * **`--report` is not `--reporter`.** They sound alike and are for different
 * readers, which is worth being blunt about: `--reporter` is how a *run* says
 * what it is doing as it does it, a stream of events with no end until the run
 * has one. A report is the opposite — one document, written once, about a file
 * that already exists. A CI step wants the second: an `ok` to branch on and a
 * list to print, not a log to parse.
 */

import { createReadStream } from 'node:fs';
import { compressionFromName, decompressor } from '../core/output.js';
import { validateXmltv, type ValidationReport } from '../xmltv/validate.js';

/** How the report is written. */
export const REPORT_FORMATS = ['text', 'json'] as const;

export type ReportFormat = (typeof REPORT_FORMATS)[number];

export interface ValidateFileOptions {
  strict?: boolean;
  signal?: AbortSignal;
}

/**
 * Validate the document at `file`, decompressing it when its name says to.
 *
 * The name, because that is all there is to go on and it is what the writing
 * side promised — `epg build -o guide.xml.gz` wrote gzip, so validating the
 * same path has to undo it rather than reporting that a guide of compressed
 * bytes is not XML.
 */
export async function validateFile(
  file: string,
  options: ValidateFileOptions = {},
): Promise<ValidationReport> {
  const compression = compressionFromName(file);
  const bytes = createReadStream(file);
  const source = compression === undefined ? bytes : bytes.pipe(decompressor(compression));

  return validateXmltv(source, {
    ...(options.strict === undefined ? {} : { strict: options.strict }),
    ...(options.signal ? { signal: options.signal } : {}),
  });
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
    return `${head}: nothing to report\n`;
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

  return `${head}\n\n${blocks.join('\n')}\n\n${totals}\n`;
}

/** The report as one JSON document — an `ok` to branch on, and the findings. */
function asJson(report: ValidationReport, file: string): string {
  return `${JSON.stringify({ file, ...report }, undefined, 2)}\n`;
}

export function renderReport(report: ValidationReport, file: string, format: ReportFormat): string {
  return format === 'json' ? asJson(report, file) : asText(report, file);
}

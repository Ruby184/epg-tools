/**
 * What is wrong with a guide, in a form a person and a CI step can both read.
 *
 * Two sources, and the difference between them is worth keeping straight:
 *
 * - **What the parser said.** It already reports every construct it could not
 *   read — a bad attribute value, a duplicated element, a `<channel>` with no
 *   id — with a line and a column. Those are collected here rather than
 *   re-derived.
 * - **What only the whole document shows.** A `<programme>` whose channel no
 *   `<channel>` describes is invisible to a parser reading one element at a
 *   time, and is the defect a consumer most often breaks on.
 *
 * Findings are **grouped by rule, not listed per occurrence**. A guide with a
 * hundred thousand programmes has a hundred thousand extensions, and a report
 * that named each would be larger than the guide — the same reason a run emits
 * one `request:failed` rather than one per channel-day. So what is retained is
 * flat in the size of the guide: one entry per rule, a count, and a few
 * examples.
 */

import { parseXmltvStream, type ParseStreamOptions } from './parse.js';
import type { XmltvChannel, XmltvExtraElement, XmltvProgramme, XmltvWarning } from './types.js';

/** What a finding is about. */
export type FindingCode =
  // From the parser, keeping its own vocabulary.
  | XmltvWarning['code']
  // From reading the document as a whole.
  | 'programme-without-title'
  | 'channel-without-display-name'
  | 'unknown-channel'
  | 'duplicate-channel'
  | 'stop-before-start'
  | 'extensions';

/**
 * How much a finding matters.
 *
 * `error` is a document that parsed but is wrong — something no reader can make
 * sense of, or a rule the DTD states. `warning` is something the parser found
 * and coped with: the guide is poorer for it, but it is a guide.
 *
 * The one parser warning that is an error is `truncated-input`, and for a
 * reason worth stating: it means this is not the whole document, so every other
 * finding — above all the counts, and anything about a channel not being
 * described — is about a fragment.
 */
export type FindingSeverity = 'error' | 'warning';

export interface ValidationFinding {
  code: FindingCode;
  severity: FindingSeverity;
  /** The rule, in one line. The same for every occurrence. */
  message: string;
  /** How many times it occurred, however many are named in {@link examples}. */
  count: number;
  /** A few of them, named — a channel id, an extension, a parser's own line. */
  examples: string[];
}

export interface ValidationReport {
  /** No errors — and no warnings either, when validating `strict`. */
  ok: boolean;
  channels: number;
  programmes: number;
  errors: number;
  warnings: number;
  /** Errors first, then by how often each happened. */
  findings: ValidationFinding[];
}

export interface ValidateOptions extends ParseStreamOptions {
  /** Count warnings against {@link ValidationReport.ok} too. Defaults to false. */
  strict?: boolean;
  /**
   * How many examples a finding names. Defaults to 5.
   *
   * The cap is what keeps a report flat in the size of the guide: a document
   * where every programme trips the same rule is one finding with a large
   * `count`, not a list as long as the guide.
   */
  maxExamples?: number;
}

const DEFAULT_MAX_EXAMPLES = 5;

/**
 * How many distinct undeclared channel ids are remembered while reading.
 *
 * They cannot be reported as they are found — a `<channel>` may yet describe
 * one, and the DTD's order is a convention a real guide sometimes breaks — so
 * they are held to the end. Held, and therefore capped: this is the one thing
 * here that grows with what is *wrong* rather than with the guide, and a
 * document that names ten thousand undeclared channels has made its point after
 * a thousand.
 */
const MAX_PENDING_CHANNELS = 1000;

/**
 * Every rule: how bad it is, and what it says.
 *
 * One reviewable table rather than a severity worked out at each call site —
 * the same reason `EVENT_KINDS` is a table. What a report fails CI over is
 * decided by reading this, and nowhere else.
 *
 * The parser's own six are warnings, because it found each one and carried on;
 * `truncated-input` is the exception, since it means this is not the whole
 * document and every other finding is therefore about a fragment.
 */
const RULES: Record<FindingCode, { severity: FindingSeverity; message: string }> = {
  'truncated-input': {
    severity: 'error',
    message: 'the document ends mid-element, so this is not all of it',
  },
  'malformed-markup': { severity: 'warning', message: 'markup the parser had to skip' },
  'invalid-programme': { severity: 'warning', message: 'a <programme> was dropped' },
  'invalid-element': { severity: 'warning', message: 'an element was dropped or ignored' },
  'invalid-attribute': { severity: 'warning', message: 'an attribute value was dropped' },
  'unknown-element': { severity: 'warning', message: 'an element outside the DTD was ignored' },
  'programme-without-title': {
    severity: 'error',
    message: 'a <programme> has no <title>, which the DTD requires',
  },
  'channel-without-display-name': {
    severity: 'error',
    message: 'a <channel> has no <display-name>, which the DTD requires',
  },
  'unknown-channel': {
    severity: 'error',
    message: 'a <programme> names a channel no <channel> describes',
  },
  'duplicate-channel': { severity: 'error', message: 'two <channel> elements share an id' },
  'stop-before-start': { severity: 'error', message: 'a <programme> stops before it starts' },
  extensions: {
    severity: 'warning',
    message: 'a provider extension, which no DTD describes — extensions: false removes them',
  },
};

/** One entry per rule, counting and keeping a few examples of each. */
class Findings {
  readonly #byCode = new Map<FindingCode, { count: number; examples: string[] }>();

  constructor(private readonly maxExamples: number) {}

  add(code: FindingCode, example: string): void {
    let entry = this.#byCode.get(code);

    if (entry === undefined) {
      entry = { count: 0, examples: [] };
      this.#byCode.set(code, entry);
    }

    entry.count++;

    // Kept only while there is room, and only when it is something not already
    // named: a thousand programmes missing a title are one finding, and naming
    // the same extension five times says less than naming five.
    if (entry.examples.length < this.maxExamples && !entry.examples.includes(example)) {
      entry.examples.push(example);
    }
  }

  list(): ValidationFinding[] {
    return [...this.#byCode]
      .map(([code, { count, examples }]) => ({ code, ...RULES[code], count, examples }))
      .sort(
        (a, b) =>
          Number(b.severity === 'error') - Number(a.severity === 'error') || b.count - a.count,
      );
  }
}

/** Where an extension is, said the way the option that removes it reads. */
function extensionExample(kind: 'attribute' | 'element', name: string, on: string): string {
  return `${kind} ${name} on <${on}>`;
}

/** Every extension an element carries, named for the report. */
function extensionsOf(
  findings: Findings,
  on: string,
  element: { extraAttributes?: Record<string, string>; extra?: XmltvExtraElement[] },
): void {
  for (const name of Object.keys(element.extraAttributes ?? {})) {
    findings.add('extensions', extensionExample('attribute', name, on));
  }

  for (const extra of element.extra ?? []) {
    findings.add('extensions', extensionExample('element', extra.name, on));
  }
}

/** A parser warning, keeping the position it took the trouble to work out. */
function warningExample(warning: XmltvWarning): string {
  return `line ${warning.line}:${warning.col} — ${warning.message}`;
}

/**
 * Read a guide and say what is wrong with it.
 *
 * Streams: nothing of the document is retained but the channel ids it declares
 * and the findings themselves, so a guide of any size validates in the memory a
 * parse already needs.
 */
export async function validateXmltv(
  source: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>,
  options: ValidateOptions = {},
): Promise<ValidationReport> {
  const { strict = false, maxExamples = DEFAULT_MAX_EXAMPLES, ...parseOptions } = options;
  const findings = new Findings(Math.max(1, maxExamples));

  const declared = new Set<string>();
  /** Channels named by a programme before any `<channel>` described them. */
  const pending = new Map<string, number>();
  let pendingDropped = 0;
  let channels = 0;
  let programmes = 0;

  const channelSeen = (channel: XmltvChannel): void => {
    channels++;

    if (declared.has(channel.id)) {
      findings.add('duplicate-channel', channel.id);
    }

    declared.add(channel.id);
    // Whatever named it earlier was right after all: a guide is allowed to put
    // its channels anywhere, whatever the DTD's order suggests.
    pending.delete(channel.id);

    if ((channel.displayName ?? []).length === 0) {
      findings.add('channel-without-display-name', channel.id);
    }

    extensionsOf(findings, 'channel', channel);

    for (const icon of channel.icon ?? []) {
      extensionsOf(findings, 'icon', icon);
    }

    for (const name of channel.displayName ?? []) {
      extensionsOf(findings, 'display-name', name);
    }
  };

  const programmeSeen = (programme: XmltvProgramme): void => {
    programmes++;

    if ((programme.title ?? []).length === 0) {
      findings.add(
        'programme-without-title',
        `${programme.channel} ${programme.start.toISOString()}`,
      );
    }

    if (programme.stop !== undefined && programme.stop.getTime() < programme.start.getTime()) {
      findings.add(
        'stop-before-start',
        `${programme.channel} ${programme.start.toISOString()} → ${programme.stop.toISOString()}`,
      );
    }

    if (!declared.has(programme.channel) && pending.size < MAX_PENDING_CHANNELS) {
      pending.set(programme.channel, (pending.get(programme.channel) ?? 0) + 1);
    } else if (!declared.has(programme.channel)) {
      pendingDropped++;
    }

    extensionsOf(findings, 'programme', programme);

    if (programme.credits) {
      extensionsOf(findings, 'credits', programme.credits);
    }

    if (programme.video) {
      extensionsOf(findings, 'video', programme.video);
    }

    if (programme.audio) {
      extensionsOf(findings, 'audio', programme.audio);
    }

    for (const rating of [...(programme.rating ?? []), ...(programme.starRating ?? [])]) {
      extensionsOf(findings, 'rating', rating);
    }
  };

  for await (const event of parseXmltvStream(source, parseOptions)) {
    switch (event.type) {
      case 'channel':
        channelSeen(event.value);
        break;
      case 'programme':
        programmeSeen(event.value);
        break;
      case 'warning':
        findings.add(event.value.code, warningExample(event.value));
        break;
      case 'meta':
        extensionsOf(findings, 'tv', event.value);
        break;
      default:
        // A processing instruction is well-formed XML that no DTD constrains,
        // so there is nothing to say about one.
        break;
    }
  }

  // Now that every `<channel>` has had its chance to describe them.
  for (const [id, count] of pending) {
    for (let i = 0; i < count; i++) {
      findings.add('unknown-channel', id);
    }
  }

  if (pendingDropped > 0) {
    findings.add(
      'unknown-channel',
      `and ${pendingDropped} more past the first ${MAX_PENDING_CHANNELS}`,
    );
  }

  const list = findings.list();
  const errors = list.reduce((sum, f) => sum + (f.severity === 'error' ? f.count : 0), 0);
  const warnings = list.reduce((sum, f) => sum + (f.severity === 'warning' ? f.count : 0), 0);

  return {
    ok: errors === 0 && (!strict || warnings === 0),
    channels,
    programmes,
    errors,
    warnings,
    findings: list,
  };
}

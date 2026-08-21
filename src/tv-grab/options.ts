/**
 * The XMLTV grabber command line.
 *
 * Only two groups live here: the information options every grabber must
 * answer, and `baseline` — the options the framework itself consumes. Every
 * other option belongs to a capability and travels with it, so the accepted
 * set is derived from what the grabber advertises, the way `%cap_options`
 * does in the reference.
 */

import { parseOptions, type OptionSpec, type ParsedValues } from '../core/options.js';
import {
  capabilityNames,
  definedCapabilities,
  type CapabilityEntry,
  type CapabilityUsage,
} from './capability.js';

/** Capability names the framework itself recognizes. */
export const KNOWN_CAPABILITIES = ['baseline'] as const;

/**
 * Always accepted, whatever the grabber claims — every grabber must answer
 * these, and they must work with no configuration and no network.
 *
 * `-v` is ours: the reference gives a short alias to `--help` only, but an
 * extra one is invisible to callers that use the long forms, and `--debug`
 * covers verbosity so nothing else wants the letter.
 */
const ALWAYS = {
  help: { type: 'boolean', short: 'h', description: 'Print this help.' },
  version: {
    type: 'boolean',
    short: 'v',
    description: "Print the XMLTV module version and the grabber's own.",
  },
  capabilities: {
    type: 'boolean',
    description: 'List what this grabber supports, one capability per line.',
  },
  description: { type: 'boolean', description: 'Print one line saying what it covers.' },
} as const;

const BASELINE = {
  'config-file': {
    type: 'string',
    placeholder: 'FILE',
    description: 'Where the configuration is kept. Defaults to ~/.xmltv/<grabber>.conf.',
  },
  days: {
    type: 'number',
    min: 1,
    description: 'How many days to grab. Defaults to what the configuration asks for.',
  },
  offset: {
    type: 'number',
    default: 0,
    description: 'Start N days from today, negative for the past. Defaults to 0.',
  },
  output: { type: 'string', placeholder: 'FILE', description: 'Write to FILE, not to stdout.' },
  quiet: { type: 'boolean', default: false, description: 'Say nothing but errors.' },
  debug: { type: 'boolean', default: false, description: 'Report every channel and day grabbed.' },
} as const;

// Both groups are declared in the order they are printed, so the synopsis
// forms are just their keys.
const INFO_FORM = Object.keys(ALWAYS);
const BASELINE_FORM = Object.keys(BASELINE);

/** Where a form wraps onto the next line, indented under the grabber's name. */
const WIDTH = 76;

/** Where a description starts, and wraps back to. */
const DESCRIPTION_COLUMN = 32;

/** Where a description wraps. Wider than a synopsis form, having less to say. */
const HELP_WIDTH = 88;

const CORE_OPTIONS = { ...ALWAYS, ...BASELINE } as const;

export type GrabberValues = ParsedValues<typeof CORE_OPTIONS>;

/** The options a grabber advertising `capabilities` accepts. */
function specsFor(capabilities: readonly CapabilityEntry[]): typeof CORE_OPTIONS {
  const names = new Set(capabilityNames(capabilities));

  const specs: Record<string, OptionSpec> = {
    ...ALWAYS,
    ...(names.has('baseline') ? BASELINE : {}),
  };

  const seen = new Set<string>();

  for (const capability of definedCapabilities(capabilities)) {
    if ((KNOWN_CAPABILITIES as readonly string[]).includes(capability.name)) {
      throw new TypeError(`Capability "${capability.name}" is built in and cannot be redefined`);
    }

    if (seen.has(capability.name)) {
      throw new TypeError(`Capability "${capability.name}" is declared twice`);
    }

    seen.add(capability.name);

    const options: Record<string, OptionSpec> = capability.options ?? {};

    for (const [name, spec] of Object.entries(options)) {
      // Shadowing an existing option would silently change what a standard
      // flag means, so a collision is a startup error rather than a surprise.
      if (name in specs) {
        throw new TypeError(`Capability "${capability.name}" redefines the option --${name}`);
      }

      specs[name] = spec;
    }
  }

  return specs as typeof CORE_OPTIONS;
}

/**
 * Parse a grabber command line. Throws `OptionError` for anything the caller
 * can fix, including an option outside the advertised capabilities.
 */
export function parseGrabberOptions(
  argv: string[],
  capabilities: readonly CapabilityEntry[],
): GrabberValues & Record<string, unknown> {
  // Positionals are never valid: a grabber takes options only.
  return parseOptions(argv, specsFor(capabilities)).values;
}

/** The spec a usage form names, or a startup error saying it does not exist. */
function specFor(specs: Record<string, OptionSpec>, name: string): OptionSpec {
  const spec = specs[name];

  if (spec === undefined) {
    // A form naming an option nobody declared would print a flag that does not
    // exist, which is worse than not starting.
    throw new TypeError(`The usage synopsis names an unknown option --${name}`);
  }

  return spec;
}

/**
 * How one option is written, from its spec and nowhere else: whether it takes
 * a value, what that value is called, and whether it can be switched off.
 */
function optionSyntax(name: string, spec: OptionSpec, short = false): string {
  const alias = short && spec.short !== undefined ? `-${spec.short}, ` : '';
  const negated = spec.negatable === true ? ` | --no-${name}` : '';

  if (spec.type === 'boolean') {
    return `${alias}--${name}${negated}`;
  }

  const value = spec.placeholder ?? (spec.type === 'number' ? 'N' : 'VALUE');
  const optional = spec.type === 'string' && spec.optionalValue !== undefined;

  return `${alias}--${name} ${optional ? `[${value}]` : value}${negated}`;
}

/** One `  --flag VALUE    description` row, wrapped under the description column. */
function optionRow(name: string, spec: OptionSpec): string {
  const flags = `  ${optionSyntax(name, spec, true)}`;

  if (spec.description === undefined) {
    return `${flags}\n`;
  }

  const indent = ' '.repeat(DESCRIPTION_COLUMN);
  const lines: string[] = [];

  for (const word of spec.description.split(' ')) {
    const line = lines.length === 0 ? undefined : lines[lines.length - 1];

    if (line === undefined || `${line} ${word}`.length + DESCRIPTION_COLUMN > HELP_WIDTH) {
      lines.push(word);
    } else {
      lines[lines.length - 1] = `${line} ${word}`;
    }
  }

  // A flag too long for its column takes a line of its own.
  const first =
    flags.length < DESCRIPTION_COLUMN
      ? `${flags.padEnd(DESCRIPTION_COLUMN)}${lines[0]}\n`
      : `${flags}\n${indent}${lines[0]}\n`;

  return (
    first +
    lines
      .slice(1)
      .map((line) => `${indent}${line}\n`)
      .join('')
  );
}

/**
 * The usage synopsis, in the shape `XMLTV::Options::PrintUsage` prints.
 *
 * Only the forms the framework itself owns are written here; every other line
 * comes from the capability that owns the options it names, so advertising a
 * capability is all it takes for its forms to appear.
 */
export function usage(grabberName: string, capabilities: readonly CapabilityEntry[]): string {
  const names = new Set(capabilityNames(capabilities));
  const specs: Record<string, OptionSpec> = specsFor(capabilities);
  const contributions = definedCapabilities(capabilities)
    .map((capability) => capability.usage)
    .filter((entry): entry is CapabilityUsage => entry !== undefined);

  const describe = (name: string): string => optionSyntax(name, specFor(specs, name));

  /**
   * One invocation: the grabber's name, its mode option, then the rest in
   * brackets, wrapped under the name.
   */
  const form = (options: readonly string[], mode = false): string => {
    const pad = ' '.repeat(grabberName.length);
    const parts = options.map((name, index) =>
      mode && index === 0 ? describe(name) : `[${describe(name)}]`,
    );

    const lines: string[] = [];

    for (const part of parts) {
      const line = lines.length === 0 ? undefined : lines[lines.length - 1];

      if (line === undefined || `${line} ${part}`.length + pad.length + 1 > WIDTH) {
        lines.push(part);
      } else {
        lines[lines.length - 1] = `${line} ${part}`;
      }
    }

    return lines.map((line, index) => `${index === 0 ? grabberName : pad} ${line}\n`).join('');
  };

  let out = INFO_FORM.concat(contributions.flatMap((entry) => entry.info ?? []))
    .map((name) => form([name], true))
    .join('');

  if (names.has('baseline')) {
    out += `\n${form([...BASELINE_FORM, ...contributions.flatMap((entry) => entry.grab ?? [])])}`;
  }

  for (const mode of contributions.flatMap((entry) => entry.modes ?? [])) {
    out += `\n${form(mode, true)}`;
  }

  return out;
}

/**
 * The synopsis, then what every option does — what `--help` prints.
 *
 * Options are grouped by what declares them, so the list doubles as an answer
 * to "which of these do I get if I advertise that capability?". An option
 * error prints {@link usage} alone: the caller mistyped a flag, and does not
 * need every other one explained.
 */
export function help(grabberName: string, capabilities: readonly CapabilityEntry[]): string {
  const names = new Set(capabilityNames(capabilities));
  const specs: Record<string, OptionSpec> = specsFor(capabilities);

  const group = (title: string, options: readonly string[]): string =>
    options.length === 0
      ? ''
      : `\n${title}:\n${options.map((name) => optionRow(name, specFor(specs, name))).join('')}`;

  let out = `${usage(grabberName, capabilities)}\n${group('Options', INFO_FORM).slice(1)}`;

  if (names.has('baseline')) {
    out += group('Grabbing', BASELINE_FORM);
  }

  for (const capability of definedCapabilities(capabilities)) {
    out += group(capability.name, Object.keys(capability.options ?? {}));
  }

  return out;
}

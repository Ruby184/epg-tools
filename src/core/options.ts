/**
 * A thin, typed layer over `node:util` `parseArgs`.
 *
 * `parseArgs` in strict mode rejects two command lines that XMLTV grabbers are
 * routinely called with: `--offset -1` (a value that looks like an option) and
 * a bare `--cache` (XMLTV's `opt:s` form, where the value is optional). Both
 * throw *before* returning, so neither can be handled after the fact.
 *
 * Rather than rewriting argv to sneak past those checks, this parses in
 * non-strict mode with `tokens: true`: argv is read exactly as typed, and the
 * tokens drive strictness — unknown options, missing values, unwanted
 * positionals — here, where a negative number can be told apart from a flag.
 * `parseArgs` still produces the values, including `multiple` and `default`.
 * On top it adds numbers with range checks and a per-option `transform`.
 */

import { parseArgs } from 'node:util';

/** A bad command line: unknown option, missing or invalid value. */
export class OptionError extends Error {
  override readonly name = 'OptionError';
}

/** What every option declares, whatever its type. */
export interface SpecBase {
  /** Single-letter alias. */
  short?: string;
  /** One line saying what the option does, for `--help`. */
  description?: string;
}

export interface BooleanSpec extends SpecBase {
  type: 'boolean';
  default?: boolean;
  /** Accept `--no-x`, which yields `false`. */
  negatable?: boolean;
}

export interface StringSpec<T = string> extends SpecBase {
  type: 'string';
  /** What the value is called in the usage synopsis, e.g. `FILE`. */
  placeholder?: string;
  /** Collect every occurrence instead of keeping the last one. */
  multiple?: boolean;
  /** Used when the flag is **absent**. */
  default?: string | string[];
  /**
   * Used when the flag is **present without a value** — which makes the value
   * optional (`--cache` as well as `--cache <dir>`), XMLTV's `opt:s` form.
   *
   * Deliberately not folded into {@link default}: a default applies when the
   * flag is absent, so reusing it here would erase the difference between
   * "not given" and "given bare". Set both to tell those apart, or only this
   * one to keep absent as `undefined`.
   *
   * Such an option claims the word after it when that word is not itself an
   * option, matching Getopt::Long. Two limits fall out of how it is
   * tokenized: the concatenated short form (`-Cdir`) is not available — use
   * `-C dir` or `--cache=dir` — and `multiple` is not supported.
   */
  optionalValue?: string;
  /**
   * Accept `--no-x`, which yields `null` — a third state next to "absent"
   * (`undefined`) and "given" (a string), for an option that can be switched
   * off rather than merely left unset.
   */
  negatable?: boolean;
  /** Map and/or check the raw string, `default` included. Throw {@link OptionError} to reject. */
  transform?: (raw: string, flag: string) => T;
}

export interface NumberSpec extends SpecBase {
  type: 'number';
  /** What the value is called in the usage synopsis. Defaults to `N`. */
  placeholder?: string;
  default?: number;
  /** Accept `--no-x`, which yields `null`. */
  negatable?: boolean;
  /** Reject values with a fractional part. Defaults to true. */
  integer?: boolean;
  min?: number;
  max?: number;
}

export type OptionSpec = BooleanSpec | StringSpec<any> | NumberSpec;

type BaseValue<S> = S extends { type: 'boolean' }
  ? boolean
  : S extends { type: 'number' }
    ? number
    : S extends { type: 'string'; transform: (raw: string, flag: string) => infer R }
      ? S extends { multiple: true }
        ? R[]
        : R
      : S extends { type: 'string' }
        ? S extends { multiple: true }
          ? string[]
          : string
        : never;

/** `--no-x` yields `false` for a flag, and `null` for anything with a value. */
type SpecValue<S> = S extends { negatable: true }
  ? S extends { type: 'boolean' }
    ? boolean
    : BaseValue<S> | null
  : BaseValue<S>;

type Flatten<T> = { [K in keyof T]: T[K] } & {};

/**
 * A defaulted option is always present; every other one may be `undefined`
 * (including one with only an `optionalValue`, which applies to a bare flag
 * and so cannot make the key always present).
 */
export type ParsedValues<S extends Record<string, OptionSpec>> = Flatten<
  { [K in keyof S as S[K] extends { default: unknown } ? K : never]: SpecValue<S[K]> } & {
    [K in keyof S as S[K] extends { default: unknown } ? never : K]?: SpecValue<S[K]>;
  }
>;

export interface ParseOptionsResult<S extends Record<string, OptionSpec>> {
  values: ParsedValues<S>;
  positionals: string[];
}

/** An option's value is optional when a fallback for the bare flag is given. */
function hasOptionalValue(spec: OptionSpec): spec is StringSpec<any> & { optionalValue: string } {
  return spec.type === 'string' && spec.optionalValue !== undefined;
}

/**
 * Would `value` have been read as a flag rather than a value?
 *
 * This is the check strict mode makes, minus its one wrong answer: a negative
 * number is a value. Only number options get that exemption, so a stray
 * `--output --quiet` is still reported.
 */
function looksLikeOption(value: string, spec: OptionSpec): boolean {
  if (!value.startsWith('-')) {
    return false;
  }

  return !(spec.type === 'number' && /^-\d/.test(value));
}

function toNumber(raw: string, flag: string, spec: NumberSpec): number {
  // Number() rather than parseInt() so "7.5" and "7x" are rejected outright
  // instead of being silently truncated to 7.
  const trimmed = raw.trim();
  const value = trimmed === '' ? Number.NaN : Number(trimmed);

  if (!Number.isFinite(value)) {
    throw new OptionError(`Invalid ${flag} value: ${raw} (expected a number)`);
  }

  if (spec.integer !== false && !Number.isInteger(value)) {
    throw new OptionError(`Invalid ${flag} value: ${raw} (expected a whole number)`);
  }

  if (spec.min !== undefined && value < spec.min) {
    throw new OptionError(`Invalid ${flag} value: ${raw} (must be at least ${spec.min})`);
  }

  if (spec.max !== undefined && value > spec.max) {
    throw new OptionError(`Invalid ${flag} value: ${raw} (must be at most ${spec.max})`);
  }

  return value;
}

/**
 * Parse `args` against `specs`.
 *
 * Throws {@link OptionError} for anything the user can fix on the command
 * line — unknown option, missing value, unparseable number, failed range
 * check, unexpected argument — so a caller can print usage and exit non-zero
 * for all of them.
 */
export function parseOptions<S extends Record<string, OptionSpec>>(
  args: string[],
  specs: S,
  options: { allowPositionals?: boolean } = {},
): ParseOptionsResult<S> {
  const entries = Object.entries(specs) as [string, OptionSpec][];
  const parseArgsOptions: Record<
    string,
    {
      type: 'string' | 'boolean';
      short?: string;
      multiple?: boolean;
      default?: boolean | string | string[];
    }
  > = {};

  for (const [name, spec] of entries) {
    const optionalValue = hasOptionalValue(spec);

    parseArgsOptions[name] = {
      // An option with an optional value is declared boolean so the tokenizer
      // never swallows the word after it — that decision is made below, where
      // a following flag is still visible as its own token. Numbers are
      // declared as strings and converted afterwards, so their default has to
      // be stringified to match and then flows through the same conversion.
      type: spec.type === 'boolean' || optionalValue ? 'boolean' : 'string',
      ...(spec.short !== undefined ? { short: spec.short } : {}),
      ...(spec.type === 'string' && spec.multiple && !optionalValue ? { multiple: true } : {}),
      // A boolean-declared option cannot carry a string default, so for
      // optional-value options the default is applied further down instead.
      ...(spec.default !== undefined && !optionalValue
        ? { default: spec.type === 'number' ? String(spec.default) : spec.default }
        : {}),
    };
  }

  // Non-strict never throws on user input; every check below is ours.
  // `allowNegative` makes `--no-x` resolve to the `x` token (with `--no-x` kept
  // as its rawName) instead of an option literally called `no-x`; which specs
  // actually accept that is decided below.
  const parsed = parseArgs({
    args,
    options: parseArgsOptions,
    strict: false,
    allowNegative: true,
    tokens: true,
    allowPositionals: true,
  });

  const values: Record<string, unknown> = { ...parsed.values };
  const positionals: string[] = [];
  // Positional tokens consumed as the value of an optional-value option.
  const claimed = new Set<number>();

  for (let i = 0; i < parsed.tokens.length; i++) {
    const token = parsed.tokens[i] as (typeof parsed.tokens)[number];

    if (token.kind === 'positional') {
      if (!claimed.has(i)) {
        positionals.push(token.value);
      }

      continue;
    }

    if (token.kind !== 'option') {
      continue;
    }

    const spec = specs[token.name];

    if (spec === undefined) {
      throw new OptionError(`Unknown option '${token.rawName}'`);
    }

    if (token.rawName.startsWith('--no-')) {
      if (!spec.negatable) {
        throw new OptionError(`Unknown option '${token.rawName}'`);
      }

      // A flag switches off; anything carrying a value is switched off with
      // `null`, which stays distinct from "absent" and survives the defaults.
      values[token.name] = spec.type === 'boolean' ? false : null;
      continue;
    }

    if (hasOptionalValue(spec)) {
      const next = parsed.tokens[i + 1];

      if (token.value !== undefined) {
        values[token.name] = token.value;
      } else if (next?.kind === 'positional' && next.index === token.index + 1) {
        values[token.name] = next.value;
        claimed.add(i + 1);
      } else {
        values[token.name] = spec.optionalValue;
      }
    } else if (spec.type !== 'boolean') {
      if (token.value === undefined || (!token.inlineValue && looksLikeOption(token.value, spec))) {
        throw new OptionError(`Option '${token.rawName}' requires a value`);
      }
    }
  }

  if (positionals.length > 0 && !options.allowPositionals) {
    throw new OptionError(`Unexpected argument '${positionals[0]}'`);
  }

  for (const [name, spec] of entries) {
    if (values[name] === undefined && spec.default !== undefined) {
      // Only optional-value options reach here still unset — every other
      // default was applied by parseArgs.
      values[name] = spec.default;
    }

    const value = values[name];

    // `undefined` is absent and `null` is switched off; neither is convertible.
    if (value === undefined || value === null) {
      continue;
    }

    const flag = `--${name}`;

    if (spec.type === 'number') {
      values[name] = toNumber(String(value), flag, spec);
    } else if (spec.type === 'string' && spec.transform) {
      const transform = spec.transform;

      values[name] = Array.isArray(value)
        ? value.map((item) => transform(String(item), flag))
        : transform(String(value), flag);
    }
  }

  return { values: values as ParsedValues<S>, positionals };
}

/**
 * `--configure`: the terminal renderer of the stage model in `stages.ts`.
 *
 * Follows `XMLTV::Configure::Configure` — walk stages from `start` until one
 * names `select-channels`, feeding each stage's answers forward, then offer the
 * channels and write the file atomically.
 *
 * Every prompt goes to stderr: stdout belongs to the XMLTV document alone.
 */

import { createInterface } from 'node:readline/promises';
import { Writable, type Readable } from 'node:stream';
import type { GrabberConf } from './config-file.js';
import { END, findStage, SELECT_CHANNELS, type ConfigField, type ConfigStage } from './stages.js';

export interface Prompter {
  /** Ask a question and return the answer, `''` once the input has ended. */
  ask(question: string): Promise<string>;
  /** Ask without echoing the answer. */
  askSecret(question: string): Promise<string>;
  close(): void;
  /** False when input cannot be prompted for, e.g. a pipe. */
  readonly interactive: boolean;
}

/**
 * A pass-through that can be silenced.
 *
 * readline echoes keystrokes by writing them to its `output`, so handing it
 * one of these — rather than the real stream — is enough to hide a password,
 * with no reach into readline's internals.
 */
class MutableOutput extends Writable {
  muted = false;

  constructor(private readonly target: Writable) {
    super();
  }

  override _write(chunk: Buffer | string, _encoding: string, done: () => void): void {
    if (!this.muted) {
      this.target.write(chunk);
    }

    done();
  }
}

function isTty(stream: Readable): boolean {
  return (stream as Readable & { isTTY?: boolean }).isTTY === true;
}

/** A prompter over a stream pair, hiding echo for secrets. */
export function createPrompter(input: Readable, output: Writable): Prompter {
  const terminal = isTty(input);
  const echo = new MutableOutput(output);
  const rl = createInterface({ input, output: echo, terminal });
  let closed = false;

  rl.once('close', () => {
    closed = true;
  });

  // At end-of-input `question()` never settles, so race it against the close.
  const question = async (text: string): Promise<string> => {
    if (closed) {
      return '';
    }

    return Promise.race([
      rl.question(text),
      new Promise<string>((resolve) => rl.once('close', () => resolve(''))),
    ]);
  };

  return {
    interactive: terminal,
    ask: question,
    async askSecret(text: string): Promise<string> {
      // The prompt goes straight to the real stream so muting cannot eat it.
      output.write(text);
      echo.muted = true;

      try {
        return await question('');
      } finally {
        echo.muted = false;
        output.write('\n');
      }
    },
    close(): void {
      rl.close();
    },
  };
}

function record(conf: GrabberConf, key: string, value: string): void {
  (conf[key] ??= []).push(value);
}

async function askField(
  field: ConfigField,
  conf: GrabberConf,
  prompter: Prompter,
  out: Writable,
): Promise<void> {
  if ((field.type === 'string' || field.type === 'secretstring') && field.constant !== undefined) {
    // A constant is recorded without asking — and without announcing itself.
    record(conf, field.id, field.constant);
    return;
  }

  out.write(`${field.description}\n`);

  const label =
    field.default !== undefined && field.default !== ''
      ? `${field.title}: [${field.default}] `
      : `${field.title}: `;

  if (field.type === 'string' || field.type === 'secretstring') {
    const answer =
      field.type === 'secretstring' ? await prompter.askSecret(label) : await prompter.ask(label);

    record(conf, field.id, answer === '' ? (field.default ?? '') : answer);
    return;
  }

  if (field.type === 'selectone') {
    const [first] = field.options;

    if (first === undefined) {
      return;
    }

    for (const [index, option] of field.options.entries()) {
      out.write(`  ${index + 1}) ${option.text}\n`);
    }

    const fallback = field.options.find((option) => option.value === field.default) ?? first;
    let chosen: { value: string; text: string } | undefined;

    while (chosen === undefined) {
      const answer = (await prompter.ask(label)).trim();

      if (answer === '') {
        chosen = fallback;
        continue;
      }

      const choice = Number(answer);
      chosen = Number.isInteger(choice) ? field.options[choice - 1] : undefined;

      if (chosen === undefined) {
        out.write(`Enter a number between 1 and ${field.options.length}.\n`);
      }
    }

    record(conf, field.id, chosen.value);
    return;
  }

  if (field.type === 'selectmany') {
    await askMany(field.options, field.id, conf, prompter, out);
  }
}

/**
 * Parse a selection such as `1-5,8,12` into zero-based indices.
 *
 * `all` takes everything; `none` — or an empty line — nothing, matching
 * `ask_many_boolean(0, …)` in the reference, which defaults every item to
 * "no". Returns `undefined` when the input is not understood, so the caller
 * can say so and ask again.
 */
export function parseSelection(input: string, count: number): number[] | undefined {
  const text = input.trim().toLowerCase();

  if (text === '' || text === 'none') {
    return [];
  }

  if (text === 'all') {
    return [...Array(count).keys()];
  }

  const picked = new Set<number>();

  for (const token of text.split(/[\s,]+/).filter(Boolean)) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(token);

    if (!match) {
      return undefined;
    }

    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);

    if (from < 1 || to < 1 || from > count || to > count) {
      return undefined;
    }

    // A reversed range is taken as written rather than rejected.
    for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
      picked.add(i - 1);
    }
  }

  return [...picked].sort((a, b) => a - b);
}

/**
 * Offer a numbered list and take the whole selection in one answer.
 *
 * Rejections are recorded too (as `no_<id>`), so a later run can show what was
 * previously turned down. Asking once rather than once per option is a
 * deliberate departure from the reference's per-item yes/no, which is
 * unusable for a source carrying hundreds of channels.
 */
async function askMany(
  options: { value: string; text: string }[],
  id: string,
  conf: GrabberConf,
  prompter: Prompter,
  out: Writable,
): Promise<void> {
  for (const [index, option] of options.entries()) {
    out.write(`  ${index + 1}) ${option.text}\n`);
  }

  let picked: number[] | undefined;

  while (picked === undefined) {
    const answer = await prompter.ask(`Select [1-${options.length}, ranges like 2-7, all, none] `);

    picked = parseSelection(answer, options.length);

    if (picked === undefined) {
      out.write(`Enter numbers or ranges between 1 and ${options.length}, or all, or none.\n`);
    }
  }

  const chosen = new Set(picked);

  for (const [index, option] of options.entries()) {
    record(conf, chosen.has(index) ? id : `no_${id}`, option.value);
  }
}

export interface ConfigureOptions {
  stages: ConfigStage[];
  /**
   * The channels to offer, given the answers collected so far — which is how
   * the reference does it too (`$listsub` is called with the configuration
   * built by the stages). A grabber whose channel list needs a login has no
   * other way to fetch one during the very run that asks for the password.
   */
  channels: (conf: GrabberConf) => Promise<{ id: string; name?: string }[]>;
  prompter: Prompter;
  out: Writable;
}

/**
 * Walk the stages and return the configuration to save, or `undefined` if a
 * stage names a successor that does not exist.
 *
 * The walk ends one of two ways: at `select-channels`, where the channels are
 * offered, or at `end`, where a stage has already decided them — which is what
 * a configured lineup does.
 */
export async function runConfigure(options: ConfigureOptions): Promise<GrabberConf | undefined> {
  const { stages, prompter, out } = options;
  const conf: GrabberConf = {};

  let name = 'start';

  while (name !== SELECT_CHANNELS && name !== END) {
    const stage = findStage(stages, name);

    if (stage === undefined) {
      out.write(`Configuration stage "${name}" does not exist.\n`);
      return undefined;
    }

    for (const field of stage.fields) {
      await askField(field, conf, prompter, out);
    }

    name = stage.next;
  }

  if (name === END) {
    return conf;
  }

  const channels = await options.channels(conf);

  out.write('Select the channels that you want to receive data for.\n');

  if (!prompter.interactive) {
    // Nothing can be asked, so take everything rather than configure nothing.
    out.write('Input is not a terminal; selecting all channels.\n');

    for (const channel of channels) {
      record(conf, 'channel', channel.id);
    }

    return conf;
  }

  await askMany(
    channels.map((channel) => ({
      value: channel.id,
      text: channel.name === undefined ? channel.id : `${channel.id} — ${channel.name}`,
    })),
    'channel',
    conf,
    prompter,
    out,
  );

  return conf;
}

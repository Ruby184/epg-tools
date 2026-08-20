/**
 * The configuration model shared by `--configure` and `--configure-api`.
 *
 * In XMLTV these are not two features: `XMLTV::Configure::Configure` prompts by
 * *interpreting* the very same stage document that `--configure-api` prints
 * (see `configure_stage`, which walks `//xmltvconfiguration/*`). So the stages
 * are modelled once as data, with two renderers — the XML one here, and the
 * terminal one in `configure.ts`.
 */

import { escapeXml } from '../xmltv/escape.js';

export interface FieldBase {
  id: string;
  title: string;
  description: string;
  /** Offered as the answer when the user just presses enter. */
  default?: string;
}

export interface TextField extends FieldBase {
  /** `secretstring` is the same, but the answer is not echoed. */
  type: 'string' | 'secretstring';
  /** A fixed answer: recorded without asking. */
  constant?: string;
}

export interface SelectField extends FieldBase {
  /** `selectone` takes one of the options; `selectmany` takes any number. */
  type: 'selectone' | 'selectmany';
  options: { value: string; text: string }[];
}

export type ConfigField = TextField | SelectField;

export interface ConfigStage {
  /** The first stage must be called `start`. */
  name: string;
  fields: ConfigField[];
  /** The stage to run next; the last one names {@link SELECT_CHANNELS}. */
  next: string;
}

/** The stage that ends configuration by choosing channels. */
export const SELECT_CHANNELS = 'select-channels';

/**
 * The other way configuration ends: nothing more to ask, and no channels to
 * choose either — what a stage that has already decided them names. The
 * reference uses it for exactly that, ending its own channel-selection stage
 * with `$writer->end('end')`, and skipping the selection when a lineup has
 * been configured, since the lineup is what determines the channels.
 */
export const END = 'end';

/** Does this name finish the walk rather than lead to another stage? */
function isTerminal(name: string): boolean {
  return name === SELECT_CHANNELS || name === END;
}

/** With nothing else to ask, configuration is channel selection alone. */
export const DEFAULT_STAGES: ConfigStage[] = [
  { name: 'start', fields: [], next: SELECT_CHANNELS },
];

/**
 * Identity helper for type inference, as `defineConfig` is for a config.
 *
 * Worth using rather than a bare array: a plain literal widens `type: 'string'`
 * to `string`, so a misspelt field type is not a compile error and shows up as
 * a question that is silently never asked — no renderer has a branch for it.
 */
export function defineStages<S extends readonly ConfigStage[]>(stages: S): S {
  return stages;
}

/**
 * Add a stage that every path reaches just before it finishes — how a
 * capability asks a question of its own (`lineups` asks which lineup).
 *
 * Whatever finished before now leads here instead, so the new stage is last
 * whichever route the answers took, and it decides for itself how
 * configuration ends: `select-channels` to go on and choose channels, `end` if
 * its own answer settles them.
 *
 * Returns a new array, and rewires by copying: the stages passed in belong to
 * the grabber — {@link DEFAULT_STAGES} is shared by every run of every one —
 * so none of them may be written to.
 */
export function appendStage(stages: readonly ConfigStage[], stage: ConfigStage): ConfigStage[] {
  return [
    ...stages.map((existing) =>
      isTerminal(existing.next) ? { ...existing, next: stage.name } : existing),
    stage,
  ];
}

const LANG = 'en';

function attr(name: string, value: string | undefined): string {
  return value === undefined ? '' : ` ${name}="${escapeXml(value)}"`;
}

/** `<title lang="en">…</title>` — the form every label takes. */
function langTag(tag: string, text: string, indent: string): string {
  return `${indent}<${tag} lang="${LANG}">${escapeXml(text)}</${tag}>\n`;
}

function renderField(field: ConfigField): string {
  const common = attr('id', field.id)
    + attr('default', field.default)
    + (field.type === 'string' || field.type === 'secretstring' ? attr('constant', field.constant) : '');

  let out = `  <${field.type}${common}>\n`;

  out += langTag('title', field.title, '    ');
  out += langTag('description', field.description, '    ');

  if (field.type === 'selectone' || field.type === 'selectmany') {
    for (const option of field.options) {
      // Note the label element is <text>, not <title> as on the field itself.
      out += `    <option value="${escapeXml(option.value)}">\n`;
      out += langTag('text', option.text, '      ');
      out += `    </option>\n`;
    }
  }

  return `${out}  </${field.type}>\n`;
}

/**
 * Render one stage as an `xmltvconfiguration` document, the shape
 * `XMLTV::Configure::Writer` produces: two-space indented, with `<nextstage>`
 * last as an empty tag.
 */
export function renderStageXml(stage: ConfigStage, grabberName: string): string {
  let out = `<?xml version="1.0" encoding="UTF-8"?>\n`;

  out += `<xmltvconfiguration grabber="${escapeXml(grabberName)}">\n`;

  for (const field of stage.fields) {
    out += renderField(field);
  }

  out += `  <nextstage stage="${escapeXml(stage.next)}" />\n`;
  out += `</xmltvconfiguration>\n`;

  return out;
}

/**
 * The final stage: pick channels.
 *
 * Mirrors `XMLTV::Configure::SelectChannelsStage`, including its `end` as the
 * next stage — there is nothing after choosing channels.
 */
export function renderSelectChannelsStage(
  channels: { id: string; name?: string }[],
  grabberName: string,
): string {
  return renderStageXml({
    name: SELECT_CHANNELS,
    next: END,
    fields: [{
      type: 'selectmany',
      id: 'channel',
      title: 'Channels',
      description: 'Select the channels that you want to receive data for.',
      options: channels.map((channel) => ({ value: channel.id, text: channel.name ?? channel.id })),
    }],
  }, grabberName);
}

/** Look a stage up by name. */
export function findStage(stages: ConfigStage[], name: string): ConfigStage | undefined {
  return stages.find((stage) => stage.name === name);
}

/**
 * Keys the framework writes itself. A field sharing one would have its answers
 * mixed into the channel selection.
 */
const RESERVED_IDS = new Set(['channel']);

/**
 * A field id becomes the key in a `key=value` line, so anything the parser
 * cannot read back would make the whole configuration count as missing —
 * silently, since an unparseable line means "not configured".
 */
const FIELD_ID = /^[^\s=!#]+$/;

/**
 * The stages a grabber will configure with: its own, or channel selection
 * alone — checked, so that nothing which would only show up part way through
 * a `--configure` can get that far.
 *
 * Those are mistakes in the grabber rather than on the command line, so they
 * throw where the version does: at startup, with a stack, before any of it can
 * be half-done in front of a user.
 */
export function resolveStages(declared: ConfigStage[] | undefined): ConfigStage[] {
  const stages = declared ?? DEFAULT_STAGES;
  const byName = new Map<string, ConfigStage>();

  for (const stage of stages) {
    if (byName.has(stage.name)) {
      throw new TypeError(`Configuration stage "${stage.name}" is declared twice`);
    }

    if (isTerminal(stage.name)) {
      // Both names mean "configuration is over", so a stage called one of them
      // would be named by its predecessor and then never entered.
      throw new TypeError(`Configuration stage "${stage.name}" is named after the end of the walk`);
    }

    byName.set(stage.name, stage);

    const ids = new Set<string>();

    for (const field of stage.fields) {
      const where = `Field "${field.id}" of stage "${stage.name}"`;

      if (!FIELD_ID.test(field.id)) {
        throw new TypeError(`${where} is not a name a configuration file can hold`);
      }

      if (field.id.startsWith('no_')) {
        throw new TypeError(`${where} starts with "no_", which marks a declined answer`);
      }

      if (RESERVED_IDS.has(field.id)) {
        throw new TypeError(`${where} uses a name the grabber writes itself`);
      }

      if (ids.has(field.id)) {
        throw new TypeError(`${where} is asked twice in the same stage`);
      }

      ids.add(field.id);

      if ((field.type === 'selectone' || field.type === 'selectmany') && field.options.length === 0) {
        throw new TypeError(`${where} offers nothing to choose from`);
      }
    }
  }

  // Walk it as `--configure` will. A terminal is the only way out of this
  // loop, which is the rule: configuration ends either by choosing channels or
  // by a stage that has already settled them. A dead end or a loop is found
  // here rather than after the user has already answered three questions.
  const seen = new Set<string>();
  let name = 'start';

  while (!isTerminal(name)) {
    if (seen.has(name)) {
      throw new TypeError(
        `Configuration stages lead back to "${name}", so --configure would never finish`,
      );
    }

    seen.add(name);

    const stage = byName.get(name);

    if (stage === undefined) {
      throw new TypeError(
        name === 'start'
          ? 'Configuration needs a stage called "start", where it begins'
          : `No configuration stage is called "${name}"; the stage naming it as next must name`
            + ` a declared stage, "${SELECT_CHANNELS}" to finish by choosing channels,`
            + ` or "${END}" to finish without`,
      );
    }

    name = stage.next;
  }

  return stages;
}

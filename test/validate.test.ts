import { describe, expect, it } from 'vitest';
import { validateXmltv } from '../src/xmltv/validate.js';
import type { FindingCode, ValidationReport } from '../src/xmltv/validate.js';

/** A document from its inner markup, so a test says only what it is about. */
function guide(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE tv SYSTEM "xmltv.dtd">\n<tv>${inner}</tv>`;
}

function channel(id: string, name = 'Name'): string {
  return `<channel id="${id}"><display-name>${name}</display-name></channel>`;
}

function programme(channelId: string, start: string, inner = '<title>T</title>'): string {
  return `<programme start="${start}" channel="${channelId}">${inner}</programme>`;
}

/** Split into small chunks, so every test also crosses a chunk boundary. */
function* chunks(document: string, size = 13): Generator<string> {
  for (let i = 0; i < document.length; i += size) {
    yield document.slice(i, i + size);
  }
}

async function validate(
  document: string,
  options?: Parameters<typeof validateXmltv>[1],
): Promise<ValidationReport> {
  return validateXmltv(chunks(document), options);
}

/** The finding for one rule, or `undefined` when it did not fire. */
function finding(report: ValidationReport, code: FindingCode) {
  return report.findings.find((item) => item.code === code);
}

const START = '20260903060000 +0000';

describe('validateXmltv', () => {
  it('has nothing to say about a sound guide', async () => {
    const report = await validate(guide(channel('one') + programme('one', START)));

    expect(report).toEqual({
      ok: true,
      channels: 1,
      programmes: 1,
      errors: 0,
      warnings: 0,
      findings: [],
    });
  });

  it('reports a programme naming a channel nothing describes', async () => {
    const report = await validate(
      guide(channel('one') + programme('ghost', START) + programme('ghost', START)),
    );

    expect(finding(report, 'unknown-channel')).toMatchObject({
      severity: 'error',
      count: 2,
      // Deduplicated: two programmes, one channel that does not exist.
      examples: ['ghost'],
    });
    expect(report.ok).toBe(false);
  });

  it('does not mind a channel described after the programmes that name it', async () => {
    // The DTD puts every <channel> first, and a real guide sometimes does not.
    // Nothing can be said about an unknown channel until the document ends.
    const report = await validate(guide(programme('one', START) + channel('one')));

    expect(finding(report, 'unknown-channel')).toBeUndefined();
    expect(report.ok).toBe(true);
  });

  it('reports what the DTD requires and the document lacks', async () => {
    const report = await validate(
      guide(
        `<channel id="bare"></channel>` +
          channel('one') +
          channel('one') +
          programme('one', START, ''),
      ),
    );

    expect(finding(report, 'channel-without-display-name')).toMatchObject({
      severity: 'error',
      count: 1,
      examples: ['bare'],
    });
    expect(finding(report, 'duplicate-channel')).toMatchObject({ severity: 'error', count: 1 });
    expect(finding(report, 'programme-without-title')).toMatchObject({
      severity: 'error',
      count: 1,
    });
  });

  it('reports a programme that stops before it starts', async () => {
    const report = await validate(
      guide(
        channel('one') +
          `<programme start="${START}" stop="20260903050000 +0000" channel="one"><title>T</title></programme>`,
      ),
    );

    expect(finding(report, 'stop-before-start')).toMatchObject({ severity: 'error', count: 1 });
  });

  it('names provider extensions as warnings, not errors', async () => {
    // Deliberate, and the default this package writes — so a guide carrying
    // them is worth saying and not worth failing over. `--strict` is for a
    // consumer that has decided otherwise.
    const report = await validate(
      guide(
        `<channel id="one" data-src="acme"><display-name>N</display-name><lcn>101</lcn></channel>` +
          `<programme start="${START}" channel="one" uniqueID="a"><title>T</title></programme>`,
      ),
    );

    expect(report.errors).toBe(0);
    expect(report.ok).toBe(true);
    expect(finding(report, 'extensions')).toMatchObject({
      severity: 'warning',
      count: 3,
      examples: [
        'attribute data-src on <channel>',
        'element lcn on <channel>',
        'attribute uniqueID on <programme>',
      ],
    });
  });

  it('counts warnings against a strict run', async () => {
    const extension = guide(
      `<channel id="one" data-src="acme"><display-name>N</display-name></channel>`,
    );

    expect((await validate(extension)).ok).toBe(true);
    expect((await validate(extension, { strict: true })).ok).toBe(false);
  });

  it("collects the parser's own warnings, with where each was", async () => {
    const report = await validate(guide(channel('one') + '<mystery/>'));
    const unknown = finding(report, 'unknown-element');

    expect(unknown).toMatchObject({ severity: 'warning', count: 1 });
    expect(unknown?.examples[0]).toMatch(/^line \d+:\d+ — unknown top-level element <mystery>/);
  });

  it('treats a document that stops mid-element as an error, not a warning', async () => {
    // Every other finding would be about a fragment — including the counts, and
    // above all a channel that "nothing describes" because the rest is missing.
    const report = await validate(
      `<?xml version="1.0" encoding="UTF-8"?><tv>${channel('one')}<programme start="${START}" cha`,
    );

    expect(finding(report, 'truncated-input')).toMatchObject({ severity: 'error' });
    expect(report.ok).toBe(false);
  });

  it('stays one finding however many times a rule is broken', async () => {
    // The whole shape of the report: a guide where every programme is wrong is
    // one entry with a large count, not a list as long as the guide.
    const many = Array.from({ length: 2000 }, (_, i) =>
      programme(`ghost-${i % 7}`, START, ''),
    ).join('');
    const report = await validate(guide(channel('one') + many), { maxExamples: 3 });

    expect(report.findings).toHaveLength(2);
    expect(finding(report, 'programme-without-title')).toMatchObject({ count: 2000 });
    expect(finding(report, 'programme-without-title')?.examples).toHaveLength(3);
    // Seven distinct undeclared channels, named 2,000 times between them.
    expect(finding(report, 'unknown-channel')).toMatchObject({ count: 2000 });
    expect(finding(report, 'unknown-channel')?.examples).toHaveLength(3);
  });

  it('puts errors first, then whatever happened most', async () => {
    const report = await validate(
      guide(
        `<channel id="one" a="1" b="2"><display-name>N</display-name></channel>` +
          programme('ghost', START, ''),
      ),
    );

    expect(report.findings.map((item) => item.severity)).toEqual(['error', 'error', 'warning']);
    // Both errors happened once, so the order between them is stable but not
    // meaningful; what matters is that neither is behind the warning.
    expect(report.findings.at(-1)?.code).toBe('extensions');
  });
});

import { test } from 'vitest';
import { escapeXml, escapeXmlAttribute, escapeXmlText } from '../src/xmltv/main.js';
import { speedup, TIMEOUT, tracked } from './harness.js';

/**
 * What escaping costs, and what splitting it by context cost.
 *
 * It runs on every title, description and attribute of a guide — 90 MiB of them
 * on a real one — so the question the split raised is whether reaching the
 * right pattern is slower than having only one. `legacy` below is the single
 * pattern it replaced: the same function with `&<>"'` in one class.
 */
const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};
const ANY = /[&<>"']/;
const ALL = /[&<>"']/g;

/** What this package wrote before the split: everything, one pattern. */
function legacy(value: string): string {
  return ANY.test(value) ? value.replace(ALL, (char) => ESCAPES[char]!) : value;
}

/**
 * A guide's worth of text, in the proportions one really has.
 *
 * Most strings hold nothing to escape at all — that is the fast path both
 * before and after — and the ones that do are mostly apostrophes in titles,
 * which is the whole point of the change: they used to be rewritten and are now
 * returned untouched.
 */
const SAMPLE = Array.from({ length: 2000 }, (_, at) => {
  switch (at % 10) {
    case 0:
      return "Charlie's Angels";
    case 1:
      return 'Tom & Jerry';
    case 2:
      return 'A film about "quotes" and other punctuation, at some length.';
    case 3:
      return 'Der deutsche Botschafter in Israel arbeitet in einer Phase dramatischer Eskalation.';
    default:
      return `Episode ${String(at)}: a plain title with nothing to escape`;
  }
});

test(
  `escape XMLTV text (${SAMPLE.length} strings)`,
  { timeout: TIMEOUT },
  async ({ annotate, bench }) => {
    const results = await bench.compare(
      ...tracked(bench, 'escapeXmlText', () => {
        for (const value of SAMPLE) {
          escapeXmlText(value);
        }
      }),
      ...tracked(bench, 'escapeXmlAttribute', () => {
        for (const value of SAMPLE) {
          escapeXmlAttribute(value);
        }
      }),
      bench('escapeXml (the generic form, both quotes)', () => {
        for (const value of SAMPLE) {
          escapeXml(value);
        }
      }),
      bench('one pattern for everything (what it replaced)', () => {
        for (const value of SAMPLE) {
          legacy(value);
        }
      }),
    );

    await speedup(annotate, results, 'escapeXmlText', [
      'escapeXmlAttribute',
      'escapeXml (the generic form, both quotes)',
      'one pattern for everything (what it replaced)',
    ]);
  },
);

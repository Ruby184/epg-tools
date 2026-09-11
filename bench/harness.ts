import { existsSync } from 'node:fs';
import type { Bench, BenchFn, BenchRegistration, BenchResult } from 'vitest';

/**
 * Every arm of a comparison is sampled inside a single test, so one test here
 * carries what used to be a task apiece — well past the 60s a benchmark test
 * is given by default. Generous rather than tuned: the run is bounded by the
 * sampling, and this only has to be longer than that.
 */
export const TIMEOUT = 300_000;

/**
 * Where a tracked arm leaves its result for the next run to read. Gitignored:
 * a benchmark number is only comparable against one taken on the same machine,
 * so the baseline is whatever *you* measured last, not a figure from CI or from
 * whoever last touched the file.
 */
const DIR = 'bench/.baseline';
// The same directory as a URL, because `writeResult` and `bench.from()` resolve
// their paths against the project root while `existsSync` resolves against cwd.
const DIR_URL = new URL('./.baseline/', import.meta.url);

/** `epg-tools parseXmltvStream (whole string)` → `epg-tools-parsexmltvstream-whole-string` */
function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * An arm whose result is kept, so the next run can show the drift.
 *
 * Spread into `bench.compare()`: it registers the arm itself, writing its
 * result to `bench/.baseline/`, followed — from the second run on — by a
 * static row holding what the same arm measured last time. On the first run
 * there is nothing to read yet and only the live arm appears.
 */
export function tracked(bench: Bench, name: string, fn: BenchFn): BenchRegistration<string>[] {
  const file = `${slug(name)}.json`;
  const live = bench(name, { writeResult: `${DIR}/${file}` }, fn);

  // Read before the run, so the row shows the previous result rather than the
  // one this very arm is about to overwrite the file with.
  return existsSync(new URL(file, DIR_URL))
    ? [live, bench.from(`${name} — previous run`, `${DIR}/${file}`)]
    : [live];
}

/** What `bench.compare()` resolves to: the arms of one comparison, by name. */
interface Results {
  get: (name: string) => BenchResult;
}

/**
 * The `2.25× faster than` lines Vitest printed as a `BENCH Summary` until v5
 * retired it along with the standalone `bench()` task. They are the numbers the
 * README quotes, and reading them off a column of means by hand is how a claim
 * goes stale — so they are recomputed here from the same means the table above
 * shows, and attached to the test as annotations.
 *
 * `subject` is the arm the others are read against, and each ratio is stated
 * in whichever direction makes it a number above one.
 */
export function speedup(
  annotate: (message: string, type?: string) => Promise<unknown>,
  results: Results,
  subject: string,
  others: string[],
): Promise<unknown> {
  const mean = results.get(subject).latency.mean;

  const lines = others.map((name) => {
    const ratio = results.get(name).latency.mean / mean;

    return ratio >= 1
      ? `${ratio.toFixed(2)}× faster than ${name}`
      : `${(1 / ratio).toFixed(2)}× slower than ${name}`;
  });

  return annotate(`${subject} — ${lines.join(', ')}`, 'speedup');
}

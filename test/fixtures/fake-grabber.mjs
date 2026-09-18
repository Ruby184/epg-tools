#!/usr/bin/env node
/**
 * A stand-in for a program that writes XMLTV to stdout.
 *
 * One script rather than several, because the two adapters under test share a
 * code path and ought to be tested through the same thing: what differs between
 * them is the argv they build, which this echoes back on request.
 *
 * Flags, none of which a real grabber has except the last three:
 *
 * - `--truncate`     two channels and one programme, then half an element, then
 *                    exit 255 — which is what a Perl grabber dying mid-write
 *                    leaves behind, and the case the exit code exists to catch
 * - `--exit N`       finish the document properly, then exit N
 * - `--noise`        write some lines to stderr before the document
 * - `--hang`         write nothing and never exit
 * - `--echo-argv`    write the argv as a `<channel>` per argument, so a test can
 *                    assert what it was called with
 * - `--capabilities` print capabilities, one per line, as XMLTV's own do
 * - `--list-channels` a document of channels and no programmes
 * - `--days N`, `--offset N`, `--config-file F`, `--quiet` — read only so that
 *                    `--echo-argv` can report them
 */

import { argv, exit, stderr, stdout } from 'node:process';

const args = argv.slice(2);
const has = (name) => args.includes(name);
const value = (name) => {
  const at = args.indexOf(name);

  return at === -1 ? undefined : args[at + 1];
};

/** `YYYYMMDD000000 +0000`, the day `--offset` and `--days` are counted in. */
const at = (dayOffset, hour) => {
  const day = new Date(Date.UTC(2026, 8, 20 + dayOffset, hour));
  const pad = (number, width) => String(number).padStart(width, '0');

  return (
    `${String(day.getUTCFullYear())}${pad(day.getUTCMonth() + 1, 2)}${pad(day.getUTCDate(), 2)}` +
    `${pad(day.getUTCHours(), 2)}0000 +0000`
  );
};

const channel = (id, name) => `  <channel id="${id}">\n    <display-name>${name}</display-name>\n  </channel>\n`;
const programme = (id, dayOffset, hour, title) =>
  `  <programme start="${at(dayOffset, hour)}" stop="${at(dayOffset, hour + 1)}" channel="${id}">\n` +
  `    <title>${title}</title>\n  </programme>\n`;

if (has('--capabilities')) {
  // What a grabber advertises, one per line. `baseline` is the one that says
  // --days/--offset/--config-file exist.
  stdout.write(`${(value('--capabilities') ?? 'baseline\nmanualconfig').replaceAll('\\n', '\n')}\n`);
  exit(0);
}

if (has('--hang')) {
  // Nothing on stdout and no exit: the timeout and the abort both end here.
  setInterval(() => {}, 1000);
} else {
  if (has('--noise')) {
    stderr.write('fetching listings\nsomething looks odd on day 3\n');
  }

  stdout.write('<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n');

  if (has('--echo-argv')) {
    for (const [index, one] of args.entries()) {
      stdout.write(channel(`argv.${String(index)}`, one));
    }
  } else {
    stdout.write(channel('one.example', 'One'));
    stdout.write(channel('two.example', 'Two'));
  }

  if (!has('--list-channels')) {
    stdout.write(programme('one.example', 0, 10, 'First'));
    stdout.write(programme('two.example', 0, 11, 'Second'));

    if (has('--truncate')) {
      // Half an element and then death, which is the normal failure mode: a
      // child's stdout ends *cleanly* when the process dies, so nothing but the
      // exit code says this document is not finished.
      stdout.write('  <programme start="');
      exit(255);
    }

    stdout.write(programme('one.example', 1, 10, 'Tomorrow'));
  }

  stdout.write('</tv>\n');
  exit(Number(value('--exit') ?? 0));
}

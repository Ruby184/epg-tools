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
 * - `--capabilities` print what `FAKE_CAPABILITIES` says, one per line, as
 *                    XMLTV's own do — `baseline\napiconfig` by default — and
 *                    count the asking in `FAKE_TALLY`, where one is named
 * - `--list-channels` a document of channels and no programmes
 * - `--gzip`         the same document, gzipped, as a program may well write
 * - `--trap`         record the signal it is stopped with in `FAKE_TALLY`
 * - `--dribble`      write two channels' worth and then stay up, stdout open
 * - `--days N`, `--offset N`, `--config-file F`, `--quiet` — read only so that
 *                    `--echo-argv` can report them
 */

import { appendFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { argv, env, exit, stderr, stdout } from 'node:process';

const args = argv.slice(2);
const has = (name) => args.includes(name);
const value = (name) => {
  const at = args.indexOf(name);

  return at === -1 ? undefined : args[at + 1];
};

/**
 * `YYYYMMDD000000 +0000`, counted from **today** — or from `--from` where one
 * is given, which is how a test pins it.
 *
 * Relative rather than fixed, because that is what a grabber does: `--offset 0`
 * is its own today, and a fixture with a date written into it would stop
 * matching the window the day after it was written.
 */
const at = (dayOffset, hour) => {
  const from = value('--from');
  const [year, month, date] = (from ?? new Date().toISOString().slice(0, 10))
    .split('-')
    .map((part) => Number(part));
  const day = new Date(Date.UTC(year, month - 1, date + dayOffset, hour));
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
  if (env.FAKE_CAPABILITIES === 'fail') {
    // A program that cannot even say what it supports, which is the first
    // thing asked of it.
    stderr.write('cannot read my own configuration\n');
    exit(3);
  }

  if (env.FAKE_TALLY !== undefined) {
    // A line per asking, so a test can hold this layer to "once": nothing else
    // can see how many times a program was run.
    appendFileSync(env.FAKE_TALLY, 'asked\n');
  }

  // What a grabber advertises, one per line. `baseline` is the one that says
  // --days/--offset/--config-file exist; `apiconfig` is the one that says
  // --list-channels does. Taken from the environment because a real grabber
  // takes no argument here, and `env` is what a site can set.
  stdout.write(`${(env.FAKE_CAPABILITIES ?? 'baseline\napiconfig').replaceAll('\\n', '\n')}\n`);
  exit(0);
}

if (has('--trap')) {
  // Says so when it is asked to stop, which is the only way a test can see
  // that an abandoned pass took the program down with it.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (env.FAKE_TALLY !== undefined) {
        appendFileSync(env.FAKE_TALLY, `${signal}\n`);
      }

      exit(143);
    });
  }
}

if (has('--hang')) {
  // Nothing on stdout and no exit: the timeout and the abort both end here.
  setInterval(() => {}, 1000);
} else {
  if (has('--noise')) {
    stderr.write('fetching listings\nsomething looks odd on day 3\n');
  }

  const out = [];
  const write = has('--gzip') ? (text) => out.push(text) : (text) => stdout.write(text);

  write('<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n');

  if (has('--echo-argv')) {
    for (const [index, one] of args.entries()) {
      write(channel(`argv.${String(index)}`, one));
    }
  } else {
    write(channel('one.example', 'One'));
    write(channel('two.example', 'Two'));
  }

  if (!has('--list-channels')) {
    write(programme('one.example', 0, 10, 'First'));
    write(programme('two.example', 0, 11, 'Second'));

    if (has('--truncate')) {
      // Half an element and then death, which is the normal failure mode: a
      // child's stdout ends *cleanly* when the process dies, so nothing but the
      // exit code says this document is not finished.
      stdout.write(out.join('') + '  <programme start="');
      exit(255);
    }

    write(programme('one.example', 1, 10, 'Tomorrow'));
  }

  if (has('--dribble')) {
    // Two channels' worth written and then nothing, without closing stdout: a
    // pass reading this has a channel-day to hand over and a program still
    // running, which is what being let go of part way looks like.
    setInterval(() => {}, 1000);
  }

  if (has('--dribble')) {
    // Deliberately unclosed: the document is what it is until it is killed.
  } else {
    write('</tv>\n');
  }

  if (has('--gzip')) {
    // A program may write a compressed document as readily as a server serves
    // one; the reader sniffs either.
    stdout.write(gzipSync(Buffer.from(out.join(''), 'utf8')));
  }

  if (!has('--dribble')) {
    exit(Number(value('--exit') ?? 0));
  }
}

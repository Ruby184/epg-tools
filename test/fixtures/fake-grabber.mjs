#!/usr/bin/env node
/**
 * A stand-in for a program that writes XMLTV to stdout.
 *
 * **What it does is the test's to say.** Given `FAKE_CONTROL`, it reports every
 * invocation down that socket and does what comes back — see `control.ts`,
 * which is where a test decides what this program answers, when it fails, and
 * how many days it writes.
 *
 * What is left here is what a socket cannot express, and what a hand-run needs:
 *
 * - `--gzip`     the document gzipped, which JSON down a socket would not carry
 * - `--trap`     record the signal it is stopped with in `FAKE_TALLY`, which is
 *                the only way to see that a pass let go of took it down too
 * - `--dribble`  two channels' worth, then stay up with stdout open
 * - `--capabilities`, `--description`, `--preferredmethod`, `--list-channels`
 *                the interface's four questions, answered plainly, so this can
 *                be pointed at by hand or by an example config
 */

import { appendFileSync } from 'node:fs';
import { connect } from 'node:net';
import { gzipSync } from 'node:zlib';
import { argv, env, exit, stderr, stdout } from 'node:process';

const args = argv.slice(2);
const has = (name) => args.includes(name);

/**
 * Say what this invocation was called with, and wait to be told what to do.
 *
 * Resolves with the answer rather than on connect: connecting is not the thing
 * worth waiting for, the instruction is — and having it in hand makes what
 * follows straight-line code instead of a handler that exits from inside
 * itself.
 */
async function askWhatToDo(path) {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    let held = '';

    socket.on('error', reject);

    // Long enough that a busy machine is not the reason, short enough to fail a
    // test rather than hang it: a server that never answers is a mistake in the
    // test, and one that says so beats one that waits.
    const waited = setTimeout(() => reject(new Error('it never answered')), 10_000);

    socket.on('connect', () => socket.write(`${JSON.stringify({ argv: args })}\n`));
    socket.on('data', (chunk) => {
      held += chunk.toString('utf8');

      const end = held.indexOf('\n');

      if (end === -1) {
        return;
      }

      clearTimeout(waited);
      socket.end();
      resolve(JSON.parse(held.slice(0, end)));
    });
  });
}

if (env.FAKE_CONTROL !== undefined) {
  const told = await askWhatToDo(env.FAKE_CONTROL).catch((error) => {
    // Nobody listening where a test said there would be, or nobody answering.
    // Said plainly and exited distinctly, because the alternative is an
    // unhandled `error` event: a stack trace on stderr, an exit nobody chose,
    // and a test reading it as "the grabber failed".
    stderr.write(`no answer from the control socket at ${env.FAKE_CONTROL}: ${error.message}\n`);
    exit(98);
  });

  if (told.stderr !== undefined) {
    stderr.write(told.stderr.endsWith('\n') ? told.stderr : `${told.stderr}\n`);
  }

  if (told.write !== undefined) {
    stdout.write(told.write);
  }

  if (told.hang === true) {
    // A handle, and then nothing: Node exits 13 on an unsettled top-level await
    // with an empty event loop, which is a program that stopped rather than one
    // that is still going.
    setInterval(() => {}, 1000);
    await new Promise(() => {});
  }

  exit(told.exit ?? 0);
}

/** `YYYYMMDD000000 +0000`, counted from today, as a grabber counts. */
const at = (dayOffset, hour) => {
  const day = new Date(Date.now() + dayOffset * 86_400_000);
  const pad = (number) => String(number).padStart(2, '0');

  return (
    `${String(day.getUTCFullYear())}${pad(day.getUTCMonth() + 1)}${pad(day.getUTCDate())}` +
    `${pad(hour)}0000 +0000`
  );
};

const channel = (id, name) =>
  `  <channel id="${id}">\n    <display-name>${name}</display-name>\n  </channel>\n`;

const programme = (id, dayOffset, hour, title) =>
  `  <programme start="${at(dayOffset, hour)}" stop="${at(dayOffset, hour + 1)}" channel="${id}">\n` +
  `    <title>${title}</title>\n  </programme>\n`;

if (has('--capabilities')) {
  stdout.write('baseline\napiconfig\npreferredmethod\n');
  exit(0);
}

if (has('--description')) {
  stdout.write('Somewhere on television\n');
  exit(0);
}

if (has('--preferredmethod')) {
  // One word, as its own documentation has it.
  stdout.write('allatonce\n');
  exit(0);
}

if (has('--trap')) {
  // Says so when it is asked to stop, which is the only way to see that a pass
  // let go of part way took the program with it.
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      if (env.FAKE_TALLY !== undefined) {
        appendFileSync(env.FAKE_TALLY, `${signal}\n`);
      }

      exit(143);
    });
  }
}

const out = [];
const write = has('--gzip') ? (text) => out.push(text) : (text) => stdout.write(text);

write('<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n');
write(channel('one.example', 'One'));
write(channel('two.example', 'Two'));

if (!has('--list-channels')) {
  write(programme('one.example', 0, 10, 'First'));
  write(programme('two.example', 0, 11, 'Second'));
  write(programme('one.example', 1, 10, 'Tomorrow'));
}

if (has('--dribble')) {
  // Two channels' worth written and then nothing, stdout left open: a pass
  // reading this has a channel-day to hand over and a program still running,
  // which is what being let go of part way looks like.
  setInterval(() => {}, 1000);
} else {
  write('</tv>\n');

  if (has('--gzip')) {
    // A program may write a compressed document as readily as a server serves
    // one, and the reader sniffs either.
    stdout.write(gzipSync(Buffer.from(out.join(''), 'utf8')));
  }

  exit(0);
}

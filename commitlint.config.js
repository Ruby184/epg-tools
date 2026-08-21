/**
 * Conventional Commits, with this repo's module names as the allowed scopes.
 *
 * The changelog is generated from these messages by release-please, so the
 * type decides whether a commit shows up in it and how the version moves:
 * `feat` is a minor bump, `fix` a patch, and a `!` after the scope (or a
 * `BREAKING CHANGE:` footer) a major one.
 */

import { parser, toConventionalChangelogFormat } from '@conventional-commits/parser';

const BREAKING = ['BREAKING CHANGE', 'BREAKING-CHANGE'];

/**
 * The breaking-change note as written: everything from the keyword to the end
 * of its paragraph.
 */
function noteAsWritten(raw) {
  const lines = raw.split('\n');
  const start = lines.findIndex((line) => BREAKING.some((word) => line.startsWith(`${word}:`)));

  if (start === -1) {
    return undefined;
  }

  const note = [lines[start].slice(lines[start].indexOf(':') + 1)];

  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') {
      break;
    }

    note.push(line);
  }

  return note.join('\n');
}

/**
 * The same note as release-please will read it.
 *
 * Deliberately the very parser release-please uses, rather than a rule of our
 * own about what a footer may look like: the two cannot then drift apart, and
 * an upgrade that changes the parsing shows up here as a failing commit rather
 * than as a sentence that stops halfway in a published changelog.
 */
function noteAsParsed(raw) {
  try {
    return toConventionalChangelogFormat(parser(raw)).notes.find((note) =>
      BREAKING.includes(note.title),
    )?.text;
  } catch {
    // Not parseable as a conventional commit at all, which the rules that
    // config-conventional brings will say far better than this one could.
    return undefined;
  }
}

const flatten = (text) => text.replace(/\s+/g, ' ').trim();

/**
 * A `BREAKING CHANGE:` footer must survive the trip into the changelog whole.
 *
 * The parser ends a footer at the first line that looks like the start of
 * another one — `token:` or `Token #123`, backticks around it or not — so a
 * note whose second line opens with something like `rateLimit: { … }` is
 * published cut off mid-sentence, in the one place readers go to find out what
 * broke. It has happened here: v0.2.0's `delayMs` entry ends at "is now".
 */
function breakingNoteComplete(parsed) {
  const raw = parsed.raw ?? '';
  const written = noteAsWritten(raw);
  const read = noteAsParsed(raw);

  if (written === undefined || read === undefined) {
    return [true];
  }

  const lost = flatten(written).slice(flatten(read).length).trim();

  return [
    lost === '',
    `BREAKING CHANGE note is cut short — the changelog would lose ${JSON.stringify(lost)}. ` +
      `Reword so no line of the footer starts with something like "token:" or "Token #1".`,
  ];
}

/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  plugins: [{ rules: { 'breaking-note-complete': breakingNoteComplete } }],
  /**
   * release-please writes one commit of its own — `chore(main): release 0.2.0`,
   * where the scope is the release branch's component rather than anything in
   * this repo — and CI lints every commit a pull request contributes, the
   * release PR included. The rules below describe what a person may write, so
   * the bot's commit is exempt rather than the scope list widened to admit a
   * scope nobody should use.
   */
  ignores: [(message) => /^chore\(main\): release \d+\.\d+\.\d+/.test(message)],
  rules: {
    'scope-enum': [
      2,
      'always',
      [
        // One per module, matching the directory under src/.
        'xmltv',
        'grabber',
        'cache',
        'merge',
        'tv-grab',
        'cli',
        'core',
        // Not a module: the build, the toolchain, dependencies.
        'build',
        'deps',
      ],
    ],
    // A scope is optional — `docs:` and `test:` changes are rarely one module's.
    'scope-empty': [0],
    // The body explains why; give it room, and let a URL or a long identifier
    // overrun rather than forcing a wrap that breaks it.
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
    'breaking-note-complete': [2, 'always'],
  },
};

/**
 * Conventional Commits, with this repo's module names as the allowed scopes.
 *
 * The changelog is generated from these messages by release-please, so the
 * type decides whether a commit shows up in it and how the version moves:
 * `feat` is a minor bump, `fix` a patch, and a `!` after the scope (or a
 * `BREAKING CHANGE:` footer) a major one.
 */

/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
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
  },
};

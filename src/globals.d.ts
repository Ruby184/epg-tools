/**
 * This package's version, substituted at build time by tsup (and by vitest for
 * the test run) so nothing has to read `package.json` at runtime — the bundler
 * splits code into chunks at varying depths, which makes a relative read of it
 * unreliable.
 */
declare const __PKG_VERSION__: string;

/**
 * This package's name, substituted the same way — so a generated file imports
 * whatever this package is actually called rather than a name written down
 * somewhere that can go stale.
 */
declare const __PKG_NAME__: string;

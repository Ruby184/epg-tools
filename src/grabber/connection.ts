/**
 * A site's connection settings — a proxy, and TLS options for the handshake.
 *
 * Both are things `fetch` cannot be told per request, because they belong to
 * the *connection* rather than to the message sent over it. Node's answer is a
 * `dispatcher`, and Node does not export one: `ProxyAgent` and `Agent` live in
 * the `undici` package, while the copy of undici that Node's own `fetch` runs
 * on is built in. That is the whole difficulty this file exists for.
 *
 * It does not come with an undici of its own. A dispatcher built by one major
 * cannot drive a `fetch` from another — the handler interface changed, and the
 * failure is `TypeError: fetch failed` with a cause of `invalid onRequestStart
 * method`, which says nothing about versions to anyone who has not met it
 * before. So `undici` stays an optional peer the consumer installs, pinned to
 * the copy *their* Node bundles, and what this file adds is that the mismatch
 * is noticed here and explained in one line, with the install command in it,
 * rather than discovered one failed request at a time.
 */

import type { ConnectionOptions } from 'node:tls';
import { createRequire } from 'node:module';
import { GrabberError } from '../core/error.js';

/**
 * How a site's requests reach the network. See {@link SiteConfig.connection}.
 *
 * Needs the optional peer dependency `undici`, installed at the version
 * `process.versions.undici` reports — anything else is refused with a message
 * saying so.
 */
export interface SiteConnection {
  /**
   * Send this site's requests through a proxy.
   *
   * A url — `http://user:pass@proxy.local:3128`, or any scheme the installed
   * undici understands — or `true` to take it from the environment, reading
   * `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY` for this site only.
   *
   * The environment is never read unasked. `NODE_USE_ENV_PROXY=1` already does
   * that for the whole process if that is what you want, and a run that quietly
   * started tunnelling because a variable was exported in some shell is the
   * sort of thing nobody thinks to check.
   */
  proxy?: string | URL | boolean;
  /**
   * TLS options for this site's connections, as `tls.connect` takes them.
   *
   * The reason this is a site setting rather than a process one: a source whose
   * handshake Node refuses — `ERR_SSL_DH_KEY_TOO_SMALL`, a 1024-bit
   * Diffie-Hellman group — can be given `{ ciphers: 'DEFAULT:@SECLEVEL=0' }`
   * without lowering anything for the other sites in the run.
   *
   * Through a proxy these are the options for the connection to the *source*,
   * made inside the tunnel, not for the one to the proxy.
   */
  tls?: ConnectionOptions;
}

/**
 * An undici dispatcher, as far as this package is concerned.
 *
 * Deliberately opaque. Typing it properly would mean importing undici's types,
 * which would make an optional peer a compile-time one for everybody.
 */
export type SiteDispatcher = object;

/** The three constructors this uses, which is all it asks of undici. */
export interface UndiciModule {
  Agent: new (options: Record<string, unknown>) => SiteDispatcher;
  ProxyAgent: new (options: Record<string, unknown>) => SiteDispatcher;
  /** Added in undici 6.19. Missing on older ones, which `proxy: true` reports. */
  EnvHttpProxyAgent?: new (options: Record<string, unknown>) => SiteDispatcher;
}

/** Where undici comes from, and what version it says it is. */
export interface UndiciSource {
  module: UndiciModule;
  /** `undefined` when the package will not say, which skips the check. */
  version?: string | undefined;
}

/** How undici is found. A parameter so a test can hand over a fake one. */
export type LoadUndici = () => Promise<UndiciSource>;

/** Whether anything here asks for a dispatcher at all. */
export function connectionConfigured(connection: SiteConnection | undefined): boolean {
  return (
    connection !== undefined &&
    ((connection.proxy !== undefined && connection.proxy !== false) || connection.tls !== undefined)
  );
}

/**
 * The dispatcher this site's requests go out on, or `undefined` where it has
 * asked for nothing and the global one will do.
 *
 * Built once and on first use rather than when the site is configured: undici
 * is loaded with a dynamic import, and making this async would make every
 * caller of `siteHttp` async for a feature almost no site uses. The cost is
 * that a missing or mismatched undici is reported with the first request
 * instead of at startup — a message that names the problem either way.
 */
export function siteDispatcher(
  connection: SiteConnection | undefined,
  load: LoadUndici = loadUndici,
): (() => Promise<SiteDispatcher>) | undefined {
  if (!connectionConfigured(connection)) {
    return undefined;
  }

  let built: Promise<SiteDispatcher> | undefined;

  return () => (built ??= build(connection!, load));
}

async function build(connection: SiteConnection, load: LoadUndici): Promise<SiteDispatcher> {
  const { module, version } = await load();

  checkVersion(version);

  const { proxy, tls } = connection;

  if (proxy === true) {
    if (module.EnvHttpProxyAgent === undefined) {
      throw new GrabberError(
        `\`connection.proxy: true\` reads HTTP_PROXY, HTTPS_PROXY and NO_PROXY through undici's EnvHttpProxyAgent, which undici ${version ?? '(unknown)'} does not have — it arrived in 6.19. Name the proxy outright, or install ${pin()}.`,
      );
    }

    // Both spellings, because this one agent covers both cases: `requestTls`
    // reaches the source through the tunnel, and `connect` is for a host
    // NO_PROXY exempts, which is connected to directly.
    return new module.EnvHttpProxyAgent(tls === undefined ? {} : { requestTls: tls, connect: tls });
  }

  if (proxy !== undefined && proxy !== false) {
    return new module.ProxyAgent({
      uri: String(proxy),
      ...(tls === undefined ? {} : { requestTls: tls }),
    });
  }

  return new module.Agent({ connect: tls! });
}

/** The major of a version string, or `undefined` for something unreadable. */
function major(version: string | undefined): number | undefined {
  const parsed = Number.parseInt(version ?? '', 10);

  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Refuse an undici that cannot drive this Node's `fetch`.
 *
 * The major is what decides it, because that is where the dispatcher's handler
 * interface changes. Within one, a dispatcher built by a different patch or
 * minor works, and refusing it would be this package inventing a problem.
 */
function checkVersion(version: string | undefined): void {
  const installed = major(version);
  const bundled = major(process.versions.undici);

  if (installed === undefined || bundled === undefined || installed === bundled) {
    return;
  }

  throw new GrabberError(
    `undici ${version} cannot drive this Node's fetch — ${process.version} bundles undici ${process.versions.undici}, and a dispatcher from a different major fails every request with "invalid onRequestStart method". Install the matching one: ${pin()}.`,
  );
}

/** What to install, which is the only useful half of either message. */
function pin(): string {
  return `npm install undici@${process.versions.undici ?? 'latest'}`;
}

/** Node's own resolution, used for undici's version and nothing else. */
const required = createRequire(import.meta.url);

/**
 * Not written at the import, so that typechecking this package does not need a
 * package nothing here depends on. The point of an optional peer is that most
 * installations do not have it.
 */
const UNDICI = 'undici';

async function loadUndici(): Promise<UndiciSource> {
  let module: UndiciModule;

  try {
    module = (await import(UNDICI)) as UndiciModule;
  } catch {
    throw new GrabberError(
      `A site's \`connection\` settings need the \`undici\` package, which this one does not install for you: ${pin()} — the copy ${process.version} bundles, and the only one its fetch can be driven by.`,
    );
  }

  let version: string | undefined;

  try {
    // Its own package.json rather than anything undici exports, because undici
    // exports no version. A package that will not be read this way is simply
    // not checked — a wrong version says so loudly enough on its own.
    version = (required('undici/package.json') as { version?: string }).version;
  } catch {
    version = undefined;
  }

  return { module, version };
}

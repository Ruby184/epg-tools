#!/usr/bin/env node
/**
 * The `epg` bin: the only place that turns an exit code into process state, and
 * the only place that listens for a signal. Everything it does is in `run.ts`,
 * where it can be tested — import that, not this, which runs a command line the
 * moment it is loaded.
 */

import { runCli } from './run.js';

const controller = new AbortController();

/**
 * Ctrl-C, or a service manager stopping the job: stop asking sources for
 * anything more, keep what already reached the cache, and leave whatever guide
 * is in place alone rather than replacing it with half of one.
 *
 * A second signal is a different request — that it stop *now* — and by then the
 * exit code is the only thing still owed, so there is nothing worth finishing.
 * Handling these at all is what takes away the default of dying on the spot, so
 * that second press has to be answered here.
 */
const stop = (name: string) => (): void => {
  if (controller.signal.aborted) {
    process.exit(130);
  }

  controller.abort(new Error(`${name} received`));
};

process.on('SIGINT', stop('SIGINT'));
process.on('SIGTERM', stop('SIGTERM'));

/**
 * Where a reload goes, for whichever command can take one — `epg serve`, and so
 * far only it.
 *
 * `SIGHUP` means two different things depending on what is running. To a server
 * it is "read your configuration again", which here is the channel lists: send
 * one after adding a channel rather than waiting out `sitesMaxAgeMs` or
 * restarting. To anything that ends by itself it means the terminal went away,
 * and the default is to end with it.
 *
 * So the event is cancelable and the fallback is the default: a command that
 * took the reload says so by cancelling, and one that did not gets what
 * `SIGHUP` has always given it. 129 is 128 + SIGHUP, which is what a shell
 * reports for a process the signal killed — the same arithmetic as the 130 for
 * `SIGINT` above.
 */
const reloadOn = new EventTarget();

process.on('SIGHUP', () => {
  if (reloadOn.dispatchEvent(new Event('reload', { cancelable: true }))) {
    process.exit(129);
  }
});

process.exitCode = await runCli(process.argv.slice(2), {
  signal: controller.signal,
  reloadOn,
});

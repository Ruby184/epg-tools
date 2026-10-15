/**
 * A thread of a pool of sites — what `SiteThreads` starts, and nothing else.
 *
 * Each site arrives with a port of its own and runs here, beside whatever else
 * this thread was handed, until the main thread closes that port. A file of its
 * own and an entry of the build of its own, so a worker runs this and only
 * this: started by its URL rather than on whatever chunk a bundler put the
 * pool's code in.
 */

import { parentPort, type MessagePort } from 'node:worker_threads';
import PQueue from 'p-queue';
import { workSite, type SiteThreadData } from './thread.js';

if (parentPort === null) {
  throw new Error('thread-worker is started as a worker thread by a run, not imported');
}

/**
 * Parsing and writing, bounded for every site in this thread together — as a
 * run's are for every site in it. Sized by the run that sent the site, since a
 * thread outlives the run that started it.
 */
let localWork: PQueue | undefined;

parentPort.on('message', ({ data, port }: { data: SiteThreadData; port: MessagePort }) => {
  localWork ??= new PQueue({ concurrency: data.localConcurrency });
  localWork.concurrency = data.localConcurrency;

  void workSite(port, data, localWork);
});

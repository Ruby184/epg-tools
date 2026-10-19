/**
 * Run `work` over `items`, `limit` of them at a time.
 *
 * For thousands of small operations that only wait — on the disk, mostly:
 * doing them one after another spends the whole time waiting, while doing them
 * all at once is the file descriptor storm the rest of this package is careful
 * to avoid. Node's own file operations run on a threadpool of four by default,
 * so there is little to gain past a handful in flight.
 *
 * The items may come as they are made — a listing of a store, read a page at a
 * time — and are taken as a worker is free for one, so no more of them are held
 * than are being worked on.
 *
 * The first failure is the answer, and nothing more is started after it: the
 * rest would only go on in the background, for a caller that has stopped
 * waiting on them. Items still to come are not asked for, and their source is
 * told so.
 */
export async function inParallel<T>(
  items: Iterable<T> | AsyncIterable<T>,
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  // A limit of none would start no worker and resolve having run nothing,
  // which a caller would take for having run everything.
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`inParallel needs a limit of 1 or more (got ${limit})`);
  }

  const iterator =
    Symbol.asyncIterator in items ? items[Symbol.asyncIterator]() : items[Symbol.iterator]();
  let failed = false;

  const worker = async (): Promise<void> => {
    try {
      while (!failed) {
        const next = await iterator.next();

        if (next.done === true || failed) {
          return;
        }

        await work(next.value);
      }
    } catch (error) {
      failed = true;
      throw error;
    }
  };

  // No more workers than there are items, where that is known.
  const workers = Array.isArray(items) ? Math.min(limit, items.length) : limit;

  try {
    await Promise.all(Array.from({ length: workers }, worker));
  } catch (error) {
    // The failure is the answer, whatever closing the source says.
    try {
      await iterator.return?.();
    } catch {}

    throw error;
  }
}

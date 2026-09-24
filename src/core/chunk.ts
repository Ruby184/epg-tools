/**
 * Cutting a list into pieces of a bounded size.
 *
 * Two callers with the same need and different reasons for it: the planner cuts
 * a site's channels and days into requests that will fit one call, and an
 * adapter cuts a batch into what its service will accept. Neither cares how, and
 * having written it twice is reason enough for it to live here.
 */

/**
 * `items` in pieces of at most `size`, each a copy.
 *
 * **Always a copy**, even when the whole lot fits in one piece. A chunk becomes
 * the `channels` array a site is handed, and site code sorting that in place
 * must not reach back into the planner's own list.
 *
 * Nothing in, nothing out: an empty list is no pieces rather than one empty one,
 * so a caller looping over the result asks for nothing rather than asking for
 * nothing *once*.
 *
 * A `size` below one is taken as one rather than as a reason to fail: every
 * caller's size comes from a cap somewhere, and the loop a zero would make runs
 * for ever rather than saying so. `Infinity` is a size like any other, and is
 * what an uncapped axis resolves to.
 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const width = Math.max(1, size);

  if (items.length <= width) {
    return items.length > 0 ? [[...items]] : [];
  }

  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += width) {
    chunks.push(items.slice(index, index + width));
  }

  return chunks;
}

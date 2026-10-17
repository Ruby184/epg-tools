/**
 * Whether a value comes back from JSON as it went in.
 *
 * What the cache keeps is JSON, so anything handed to it to keep — a channel's
 * `data`, a remembered value — has to be a value JSON gives back unchanged, or a
 * run that wrote it and the run that reads it would see different things, and a
 * site would find out only on the second.
 */

/**
 * The first thing in a value that is not plain, named with where it is — or
 * nothing, when all of it is.
 *
 * Plain is what JSON gives back as it was given: strings, finite numbers,
 * booleans, `null`, arrays and plain objects. A property holding `undefined` is
 * fine, since leaving it out is all JSON does with it and reading it gives the
 * same. Anything else comes back as something else — a `Date` a string, a `Map`
 * an empty object, an instance of a class without its methods, `NaN` a `null` —
 * or not at all, as a function does.
 */
export function unplain(
  value: unknown,
  at: string,
  ancestors = new Set<object>(),
): string | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return undefined;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? undefined : `${String(value)} at ${at}`;
  }

  if (typeof value !== 'object') {
    return `${typeof value === 'undefined' ? 'undefined' : `a ${typeof value}`} at ${at}`;
  }

  // The objects above this one, not every one seen: the same object twice in
  // a list is fine — JSON writes it twice — and only one inside itself is not.
  if (ancestors.has(value)) {
    return `a circular reference at ${at}`;
  }

  const prototype: unknown = Object.getPrototypeOf(value);

  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    const name = (value as { constructor?: { name?: string } }).constructor?.name;

    return `${name ? `an instance of ${name}` : 'an object of a class'} at ${at}`;
  }

  ancestors.add(value);

  try {
    for (const [key, item] of Object.entries(value)) {
      const where = Array.isArray(value) ? `${at}[${key}]` : `${at}.${key}`;
      // `undefined` as a property is left out, which reads the same; in an
      // array it becomes `null`, which does not.
      const found =
        item === undefined && !Array.isArray(value) ? undefined : unplain(item, where, ancestors);

      if (found !== undefined) {
        return found;
      }
    }

    return undefined;
  } finally {
    ancestors.delete(value);
  }
}

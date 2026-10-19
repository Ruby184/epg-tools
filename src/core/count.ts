/**
 * A number and what it counts, in the plural where it is not one: `1 channel`,
 * `3 channel-days`, and `many` for a noun whose plural is not an `s` away.
 */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

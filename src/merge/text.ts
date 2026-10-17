/**
 * Comparing and combining the texts a programme or a channel carries — leaf
 * helpers, with nothing of the merge's own in them, so the merge's modules can
 * share them without depending on each other.
 */

import type { XmltvTextValue, XmltvUrlValue } from '../xmltv/types.js';

/** Union two optional arrays, keeping first occurrence per dedup key. */
export function unionBy<T>(
  base: T[] | undefined,
  extra: T[] | undefined,
  key: (item: T) => string,
): T[] {
  const result: T[] = [];
  const seen = new Set<string>();

  // Iterate the two sources directly rather than spreading them into a
  // throwaway concat array — this is the merge hot path.
  for (let s = 0; s < 2; s++) {
    const items = s === 0 ? base : extra;

    if (!items) {
      continue;
    }

    for (const item of items) {
      const k = key(item);

      if (!seen.has(k)) {
        seen.add(k);
        result.push(item);
      }
    }
  }

  return result;
}

export function textKey(item: XmltvTextValue): string {
  return `${item.lang ?? ''}|${item.value}`;
}

/** Dedup key for `<url>` values (string or object with `system`). */
export function urlKey(item: XmltvUrlValue): string {
  return typeof item === 'string' ? `|${item}` : `${item.system ?? ''}|${item.value}`;
}

/**
 * A title as it is compared: case folded, accents dropped and whitespace
 * collapsed, so `Správy  ` and `spravy` are one title.
 *
 * Accents go because the two sources being merged are very often one local
 * feed and one international one, and the international one is the one that
 * spells `Vecernicek` — while a source that drops accents rarely reinstates
 * them for a different programme. It is a comparison only: what a programme
 * carries is never rewritten.
 */
export function normalizeTitle(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A text as compared where its letters matter: in one Unicode form — a
 * precomposed `á` and a decomposed one are one letter — with case and spacing
 * aside. Accents stay, as {@link normalizeTitle} does not keep them.
 */
export function foldText(value: string): string {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

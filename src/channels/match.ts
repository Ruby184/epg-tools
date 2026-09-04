/**
 * Line one channel list up against another.
 *
 * This is the part that matters. Reading a `*.channels.xml` or a playlist is
 * bookkeeping; knowing that the `BBC One HD` in a playlist is the `bbcone.uk`
 * in a guide is the thing nobody has, and getting it wrong is worse than
 * getting nothing — a channel with no guide shows an empty grid, a channel with
 * the *wrong* guide shows a confident, plausible, incorrect schedule.
 *
 * So the rules here are asymmetric on purpose. An id match is certain and
 * applied. A name match is reported with a confidence and never written back
 * without being asked. A name that matches more than one candidate is reported
 * as ambiguous and matched to none of them.
 */

import type { ChannelMatch, ChannelMatchKind } from './types.js';

/** A channel to match, and whatever the caller wants handed back with it. */
export interface Candidate<T> {
  /** The id, if it has one — `xmltv_id`, `tvg-id`, a `<channel id>`. */
  id?: string;
  /** The display name. */
  name?: string;
  /** The caller's own object, returned untouched in the match. */
  value: T;
}

/**
 * Markers that describe the *picture* rather than the channel.
 *
 * Two feeds of one channel differing only by these are the same schedule, which
 * is what makes them safe to drop. Ordered longest-first so `FHD` is not left
 * as `F` by an earlier `HD`.
 */
const QUALITY = /\b(?:UHDTV|FHDTV|HDTV|UHD|FHD|QHD|HEVC|H265|H\.265|4K|8K|HD|SD)\b/gi;

/**
 * A timeshifted feed: `+1`, `+24`, `-1`, and the spelled-out forms.
 *
 * **Not** stripped, and the distinction is the point. `BBC One +1` is a
 * different channel from `BBC One` — it is the whole subject of derived
 * channels — so folding the two together would confidently assign a schedule
 * that is an hour out. Recognized instead, so a caller can be told that what it
 * wants is a *timeshift of* something available rather than missing entirely.
 */
const TIMESHIFT = /(?:^|\s)([+-])\s?(\d{1,2})\s*(?:h|hr|hrs|hour|hours)?(?=\s|$)/i;

/** Everything a name can differ by without being a different channel. */
function normalize(name: string): string {
  return (
    name
      .normalize('NFD')
      // Combining marks, so `Français` and `Francais` are one name.
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(QUALITY, ' ')
      .replace(/[^a-z0-9+]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ')
  );
}

/** The timeshift a name declares, in minutes, or `undefined`. */
export function timeshiftOf(name: string): { offset: number; base: string } | undefined {
  const found = TIMESHIFT.exec(name);

  if (found === null) {
    return undefined;
  }

  const hours = Number(found[2]);

  if (!Number.isFinite(hours) || hours === 0) {
    return undefined;
  }

  return {
    offset: (found[1] === '-' ? -hours : hours) * 60,
    base: (name.slice(0, found.index) + name.slice(found.index + found[0].length)).trim(),
  };
}

/**
 * What to call a channel that is another one shifted — the inverse of
 * {@link timeshiftOf}.
 *
 * `('Sky One', 60)` is `Sky One +1`, which is what a playlist calls it, so a
 * derived channel declared in a config lands on the name a viewer is looking
 * for and `matchChannels` places it by name even before an id is set. The two
 * functions are each other's opposite on purpose: whatever this writes,
 * `timeshiftOf` reads back.
 *
 * `undefined` when there is no name to build on, or when the offset is not a
 * whole number of hours — `+90 minutes` has no spelling the recognizer would
 * accept, and inventing one that reads back as something else is worse than
 * declining. A caller that gets `undefined` should keep the name it had.
 */
export function timeshiftName(base: string, offsetMinutes: number): string | undefined {
  const trimmed = base.trim();

  if (trimmed === '' || !Number.isInteger(offsetMinutes) || offsetMinutes % 60 !== 0) {
    return undefined;
  }

  const hours = offsetMinutes / 60;

  return hours === 0 ? undefined : `${trimmed} ${hours > 0 ? '+' : '-'}${Math.abs(hours)}`;
}

/** What {@link matchChannels} hands back for a channel it could place. */
export interface ChannelMatchResult<TWanted, TAvailable> extends ChannelMatch<TWanted, TAvailable> {
  /**
   * What this looks like a timeshifted copy of.
   *
   * Set when the wanted channel names an offset — `Sky One +1` — and something
   * available matches the name without it. The answer is not "here is your
   * channel" but "this is `Sky One` an hour later", which is a *derived*
   * channel rather than a mapping.
   */
  timeshiftOf?: { channel: TAvailable; offset: number };
}

/**
 * Match each wanted channel against what is available.
 *
 * Ids first: an id that matches is not a guess and needs no confidence. Then
 * names, normalized — case, accents, punctuation and picture-quality markers
 * removed, everything else kept.
 */
export function matchChannels<TWanted, TAvailable>(
  wanted: readonly Candidate<TWanted>[],
  available: readonly Candidate<TAvailable>[],
): ChannelMatchResult<TWanted, TAvailable>[] {
  const byId = new Map<string, Candidate<TAvailable>>();
  const byName = new Map<string, Candidate<TAvailable>[]>();

  for (const candidate of available) {
    if (candidate.id !== undefined && candidate.id !== '' && !byId.has(candidate.id)) {
      byId.set(candidate.id, candidate);
    }

    if (candidate.name !== undefined && candidate.name !== '') {
      const key = normalize(candidate.name);

      if (key !== '') {
        (byName.get(key) ?? byName.set(key, []).get(key)!).push(candidate);
      }
    }
  }

  return wanted.map((item) => {
    const exact = item.id === undefined || item.id === '' ? undefined : byId.get(item.id);

    if (exact !== undefined) {
      return { source: item.value, matched: exact.value, kind: 'id' as const, confidence: 1 };
    }

    const name = item.name ?? '';
    const rivals = name === '' ? undefined : byName.get(normalize(name));
    const one = rivals?.length === 1 ? rivals[0] : undefined;

    if (one !== undefined) {
      return { source: item.value, matched: one.value, kind: 'name' as const, confidence: 0.8 };
    }

    if (rivals !== undefined && rivals.length > 1) {
      // Reported, never applied: picking one of two channels that normalize the
      // same is how a grid ends up confidently wrong.
      return {
        source: item.value,
        kind: 'none' as const,
        confidence: 0,
        ambiguous: rivals.map((rival) => rival.value),
      };
    }

    // Nothing matched the name as written. If the name declares a timeshift,
    // what it is a shift *of* may well be here — which is an answer, just not
    // the one that was asked for.
    const shift = name === '' ? undefined : timeshiftOf(name);
    const base = shift === undefined ? undefined : byName.get(normalize(shift.base));

    if (shift !== undefined && base?.length === 1) {
      return {
        source: item.value,
        kind: 'none' as const,
        confidence: 0,
        timeshiftOf: { channel: base[0]!.value, offset: shift.offset },
      };
    }

    return { source: item.value, kind: 'none' as const satisfies ChannelMatchKind, confidence: 0 };
  });
}

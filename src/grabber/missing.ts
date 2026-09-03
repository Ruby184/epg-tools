/**
 * How much of a guide may be missing and the run still count as a success.
 *
 * A grab that lost a few channel-days out of thousands has produced a guide;
 * one that lost half of them has produced a hole. Both look the same to an exit
 * code that only asks whether anything failed, which is what leaves a nightly
 * build either crying wolf at one flaky channel or silently publishing a guide
 * with a fortnight missing.
 */

import { GrabberError } from '../core/error.js';
import type { GrabSummary } from './types.js';

/**
 * A number of channel-days (`20`), or a share of the ones the run accounted for
 * (`'5%'`). A string of digits is read as the number it is, so a value that
 * arrives from a command line or an environment variable needs no conversion.
 */
export type MissingAllowance = number | string;

/** The same, resolved: a count of channel-days, or a fraction of them. */
export interface ResolvedAllowance {
  of: 'days' | 'share';
  value: number;
}

/**
 * Read an allowance, or say why it is not one.
 *
 * `label` names it in the message — the flag, or the config field — since the
 * same value arrives from both and only the caller knows which.
 */
export function resolveAllowance(allowance: MissingAllowance, label: string): ResolvedAllowance {
  const raw = typeof allowance === 'number' ? String(allowance) : allowance.trim();
  const share = raw.endsWith('%');
  const value = Number(share ? raw.slice(0, -1) : raw);

  if (raw === '' || !Number.isFinite(value) || value < 0) {
    throw new GrabberError(
      `Invalid ${label} value: ${String(allowance)} (expected a number of channel-days, or a share like 5%)`,
    );
  }

  if (share) {
    if (value > 100) {
      throw new GrabberError(
        `Invalid ${label} value: ${String(allowance)} (a share cannot exceed 100%)`,
      );
    }

    return { of: 'share', value: value / 100 };
  }

  if (!Number.isInteger(value)) {
    throw new GrabberError(
      `Invalid ${label} value: ${String(allowance)} (a count must be whole — did you mean ${value}%?)`,
    );
  }

  return { of: 'days', value };
}

/**
 * Whether a run came up short of what it set out to grab.
 *
 * Two rules, and the second is the reason the first exists:
 *
 * - **A site that answered nothing is never within an allowance.** It has no
 *   channel list, so the channel-days it would have covered are not knowable,
 *   and weighing "one site" against a guide of thousands would score a source
 *   that is entirely down as a rounding error. That is a run to look at
 *   whatever the threshold says.
 * - **Otherwise the allowance is about scattered channel-days**: a count, or a
 *   share of the ones the run actually accounted for — fetched, taken from the
 *   cache, kept as unchanged, or lost. Days that came back *empty* are not
 *   missing; a channel with nothing on is an answer, and they are counted among
 *   the fetches they are part of.
 *
 * Exactly the allowance passes: `--allow-missing 5%` on a run that lost 5% is
 * a success, as the flag reads.
 */
export function fellShort(summary: GrabSummary, allowance?: MissingAllowance): boolean {
  if (summary.sitesFailed > 0) {
    return true;
  }

  if (summary.failed === 0) {
    return false;
  }

  if (allowance === undefined) {
    return true;
  }

  const limit = resolveAllowance(allowance, 'allowMissing');

  if (limit.of === 'days') {
    return summary.failed > limit.value;
  }

  // Everything the run has an answer about, one way or another. `empty` is left
  // out because it is already counted in `fetched`, and adding it would make a
  // quiet channel look like extra evidence that the run went well.
  const accounted = summary.fetched + summary.fromCache + summary.unchanged + summary.failed;

  return summary.failed > accounted * limit.value;
}

/**
 * A channel that is another channel, shifted.
 *
 * Two jobs, and they are separate on purpose. {@link resolveDerived} turns what
 * a config declared into registry entries, which is where every way a
 * declaration can be wrong gets answered — and the answers differ, because the
 * causes do: a cycle is a mistake in the config and fails the run, while a
 * `from` that names no channel may only mean a site's fetched list came back
 * short this once, which must not take down a server. {@link shiftProgrammes}
 * then does the arithmetic, on a copy, preserving what each date said about
 * itself.
 */

import { timeshiftName } from '../channels/match.js';
import { GrabberError } from '../core/error.js';
import type { Says } from '../core/events.js';
import { getXmltvOffset, getXmltvPrecision, xmltvDate } from '../xmltv/main.js';
import type { XmltvDate } from '../xmltv/main.js';
import type { XmltvChannel, XmltvProgramme } from '../xmltv/types.js';
import type { DerivedChannel } from './types.js';
import type { DerivedEntry, RegistryEntry } from './registry.js';

const MINUTE_MS = 60_000;

/**
 * How far a derivation may shift, exclusive, in minutes.
 *
 * Not a safety rail — the merge's correctness rests on it. A day is folded in
 * and held, and everything starting before that day's own midnight is emitted,
 * on the reasoning that no later day can still reach back that far. Real
 * payloads reach back about a day at most (a source whose day runs 06:00 to
 * 06:00, or one that repeats the programme spanning midnight), which is exactly
 * the margin the horizon leaves. A negative shift spends that margin; at a full
 * day it is gone, and a programme would be emitted before an earlier one had
 * arrived — out of order, and past the point where its duplicate could still be
 * recognized.
 *
 * A whole day's shift is also the same schedule again, so nothing is lost.
 */
const MAX_OFFSET_MINUTES = 1440;

/**
 * How many milliseconds a precision's last digit stands for — when it stands
 * for a fixed number of them.
 *
 * A date published to the year or the month says nothing of fixed length, so
 * there is no shift that leaves it meaning what it meant.
 */
function unitOf(precision: number): number | undefined {
  switch (precision) {
    case 14:
      return 1000;
    case 12:
      return MINUTE_MS;
    case 10:
      return 3_600_000;
    case 8:
      return 86_400_000;
    default:
      return undefined;
  }
}

/**
 * One date, moved — keeping what it said about itself.
 *
 * The **instant** moves, never the wall clock: a calendar add would be an hour
 * out on the two nights a year the clocks change, which would unsort the list
 * and stop a repeated programme being recognized as the one it repeats.
 *
 * The source offset is carried across, so a guide published in `+0200` stays in
 * `+0200` rather than drifting to UTC halfway down the document. Precision is
 * carried only when the shift is a whole multiple of what the last digit stands
 * for — a source that published `2026080720` means "the 20:00 hour", and a
 * thirty-minute shift of that has no honest spelling at that precision, so it
 * is said in full instead of rendering as the hour it was.
 */
function shift(date: XmltvDate, offsetMs: number): XmltvDate {
  const precision = getXmltvPrecision(date);
  const unit = unitOf(precision);

  return xmltvDate(new Date(date.getTime() + offsetMs), {
    offset: getXmltvOffset(date),
    ...(precision < 14 && unit !== undefined && offsetMs % unit === 0 ? { precision } : {}),
  });
}

/**
 * One channel-day's programmes as the derived channel has them.
 *
 * `channel` is rewritten, and that is the whole point of doing this here rather
 * than leaving it to the caller: a cache row carries the id of the channel it
 * was grabbed for, and the serializer writes what the row says. Shifted
 * programmes still claiming the source's id would put a second, hour-late copy
 * of the schedule on the source channel and leave the derived one empty.
 *
 * `start`, `stop` and the PDC/VPS starts move. Nothing else does: `date` is the
 * year the programme was made, and `previously-shown` describes a real earlier
 * airing on a real other channel.
 */
export function shiftProgrammes(
  list: readonly XmltvProgramme[],
  offsetMs: number,
  xmltvId: string,
): XmltvProgramme[] {
  return list.map((programme) => ({
    ...programme,
    channel: xmltvId,
    start: shift(programme.start, offsetMs),
    ...(programme.stop === undefined ? {} : { stop: shift(programme.stop, offsetMs) }),
    ...(programme.pdcStart === undefined ? {} : { pdcStart: shift(programme.pdcStart, offsetMs) }),
    ...(programme.vpsStart === undefined ? {} : { vpsStart: shift(programme.vpsStart, offsetMs) }),
  }));
}

/**
 * The `<channel>` element a derived channel publishes.
 *
 * The source's, with a new id and usually a new name — and without its
 * channel-level extensions. Those are the source's own facts about itself: an
 * `lcn` is the number *that* channel sits on, and handing a consumer two
 * channels claiming one number is a worse outcome than losing an extension.
 */
export function derivedChannelElement(
  inherited: XmltvChannel,
  entry: DerivedEntry,
  says: Says,
): XmltvChannel {
  const { declaration, offsetMs } = entry.derivedFrom;
  const { extra: _extra, extraAttributes: _extraAttributes, ...rest } = inherited;
  const first = inherited.displayName[0];
  const offsetMinutes = offsetMs / MINUTE_MS;
  const shifted = declaration.name ?? timeshiftName(first?.value ?? '', offsetMinutes);
  const lang = declaration.lang ?? first?.lang;

  if (shifted === undefined) {
    // Nothing to append the shift to, or an offset with no spelling the
    // recognizer would read back. Worth saying: a guide with two channels under
    // one name is one a consumer can map the wrong way round.
    says.warn(
      `${declaration.xmltvId} keeps the display name of ${declaration.from}: ` +
        `${offsetMinutes} minutes has no name to say it with`,
    );
  }

  const element: XmltvChannel = {
    ...rest,
    id: declaration.xmltvId,
    ...(shifted === undefined
      ? {}
      : { displayName: [{ value: shifted, ...(lang === undefined ? {} : { lang }) }] }),
    ...(declaration.logo === undefined ? {} : { icon: [{ src: declaration.logo }] }),
  };

  return declaration.channelInfo ? declaration.channelInfo(element) : element;
}

/** Say which declaration is at fault in a way that points at the config. */
function refuse(message: string): never {
  throw new GrabberError(`Derived channel ${message}`);
}

/**
 * What a declaration resolves to, or why it does not.
 *
 * `undefined` for a declaration to skip: its root is not in this guide, which is
 * about the data rather than about the config.
 */
function rootOf(
  declaration: DerivedChannel,
  declarations: ReadonlyMap<string, DerivedChannel>,
  produced: ReadonlySet<string>,
  says: Says | undefined,
): { rootId: string; offsetMinutes: number } | undefined {
  const seen = new Set<string>([declaration.xmltvId]);
  let offsetMinutes = 0;
  let step = declaration;

  for (;;) {
    offsetMinutes += step.offset;

    if (produced.has(step.from)) {
      // A real channel, so the walk ends. The offsets of every link add up
      // because a shift of a shift is one shift — which is why a chain needs no
      // second pass over anything.
      if (Math.abs(offsetMinutes) >= MAX_OFFSET_MINUTES) {
        refuse(
          `${declaration.xmltvId} shifts ${declaration.from} by ${offsetMinutes} minutes in all, ` +
            `which is a day or more`,
        );
      }

      return { rootId: step.from, offsetMinutes };
    }

    const next = declarations.get(step.from);

    if (next === undefined) {
      // Nothing produces the channel it shifts. A fetched channel list that came
      // back short does this, so the guide goes on without it rather than
      // failing — a running `epg serve` must not stop for one absent source.
      says?.warn(`${declaration.xmltvId} shifts ${declaration.from}, which no site produces`);

      return undefined;
    }

    if (seen.has(next.xmltvId)) {
      refuse(`${declaration.xmltvId} shifts itself, through ${[...seen].join(' -> ')}`);
    }

    seen.add(next.xmltvId);
    step = next;
  }
}

/** One declaration, resolved: what it shifts, and by how much in all. */
export interface ResolvedDerived {
  declaration: DerivedChannel;
  /** The `xmltvId` of the real channel at the end of the chain. */
  rootId: string;
  offsetMinutes: number;
}

/**
 * Every declaration a guide can honour, in declaration order — so a config
 * decides where its `+1` channels appear.
 *
 * The one resolver, shared by everything that needs to know what `derived`
 * means: the merge, which goes on to read and shift; the channels report, which
 * only needs the ids and names; and an XMLTV grabber's channel list. They agree
 * because they ask the same function.
 *
 * `produced` is what the guide already has, and `duplicated` the ids more than
 * one entry answers to — only possible under `channelStrategy: 'keep-all'`.
 */
export function resolveDeclarations(
  declarations: readonly DerivedChannel[],
  produced: ReadonlySet<string>,
  duplicated: ReadonlySet<string>,
  says?: Says,
): ResolvedDerived[] {
  const declared = new Map<string, DerivedChannel>();

  for (const declaration of declarations) {
    if (declaration.xmltvId === '') {
      refuse('declarations need an xmltvId');
    }

    if (declaration.xmltvId === declaration.from) {
      refuse(`${declaration.xmltvId} shifts itself`);
    }

    if (!Number.isInteger(declaration.offset) || declaration.offset === 0) {
      refuse(
        `${declaration.xmltvId} shifts by ${declaration.offset}, which is not a whole number of minutes`,
      );
    }

    if (Math.abs(declaration.offset) >= MAX_OFFSET_MINUTES) {
      refuse(
        `${declaration.xmltvId} shifts by ${declaration.offset} minutes, which is a day or more`,
      );
    }

    if (produced.has(declaration.xmltvId)) {
      refuse(`${declaration.xmltvId} is a channel a site already produces`);
    }

    if (declared.has(declaration.xmltvId)) {
      refuse(`${declaration.xmltvId} is declared twice`);
    }

    declared.set(declaration.xmltvId, declaration);
  }

  const resolved: ResolvedDerived[] = [];

  for (const declaration of declarations) {
    if (duplicated.has(declaration.from)) {
      // Several channels answer to that id, so there is no saying which one was
      // meant. Picking the first would be silently arbitrary and would change
      // the guide the day a site's fetched list came back in another order.
      refuse(
        `${declaration.xmltvId} shifts ${declaration.from}, which more than one site produces ` +
          `separately under channelStrategy 'keep-all'`,
      );
    }

    const root = rootOf(declaration, declared, produced, says);

    if (root !== undefined) {
      resolved.push({ declaration, ...root });
    }
  }

  return resolved;
}

/**
 * What each declaration would call itself, for the callers that need the list of
 * channels rather than their programmes — the channels report, and an XMLTV
 * grabber's `--list-channels`.
 *
 * `named` is every channel the guide has, and what it calls itself. The default
 * name is built from the *root's*, so a chain reads `Sky One +2` rather than
 * naming what it happens to shift.
 */
export function derivedChannelList(
  declarations: readonly DerivedChannel[],
  named: ReadonlyMap<string, string | undefined>,
): { xmltvId: string; name?: string }[] {
  const produced = new Set(named.keys());

  return resolveDeclarations(declarations, produced, new Set()).map(
    ({ declaration, rootId, offsetMinutes }) => {
      const name =
        declaration.name ??
        timeshiftName(named.get(rootId) ?? '', offsetMinutes) ??
        named.get(rootId);

      return { xmltvId: declaration.xmltvId, ...(name === undefined ? {} : { name }) };
    },
  );
}

/**
 * The registry entries a config's `derived` declarations add.
 *
 * Every entry returned has a root among `registry` and an offset the merge can
 * carry.
 */
export function resolveDerived(
  declarations: readonly DerivedChannel[],
  registry: readonly RegistryEntry[],
  says: Says,
): DerivedEntry[] {
  const byId = new Map<string, RegistryEntry>();
  const duplicated = new Set<string>();

  for (const entry of registry) {
    if (byId.has(entry.xmltvId)) {
      // Only `channelStrategy: 'keep-all'`, which keeps one entry per site and
      // channel rather than one per channel.
      duplicated.add(entry.xmltvId);
    } else {
      byId.set(entry.xmltvId, entry);
    }
  }

  const produced = new Set(byId.keys());

  for (const id of duplicated) {
    produced.add(id);
  }

  return resolveDeclarations(declarations, produced, duplicated, says).map(
    ({ declaration, rootId, offsetMinutes }) => ({
      xmltvId: declaration.xmltvId,
      sources: [],
      derivedFrom: {
        // Present: `rootId` came out of `produced`, which is `byId`'s keys.
        source: byId.get(rootId)!,
        offsetMs: offsetMinutes * MINUTE_MS,
        declaration,
      },
    }),
  );
}

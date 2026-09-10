/**
 * Reading and writing the `<episode-num>` systems the DTD predefines, plus the
 * one Schedules Direct made ubiquitous.
 *
 * The builder can already *write* `xmltv_ns` from season and episode numbers;
 * nothing could read one back. That is what an output profile needs in order to
 * give a consumer the system it understands when a source supplied another.
 *
 * Every parser here **fails closed**: an input it cannot read with certainty
 * yields `undefined` rather than a guess. A guide that confidently states the
 * wrong episode is worse than one that states none.
 */

/**
 * One field of an `xmltv_ns` value: a zero-based index, and the total the
 * source gave if it gave one.
 *
 * Both are optional because the DTD says so — `'0..'` is legal and means
 * "season 1, episode unknown, part unknown", and `'/13'` means "one of
 * thirteen, which one unsaid".
 */
export interface EpisodeField {
  /** Zero-based, exactly as the wire format has it. */
  index?: number;
  /** The `Y` of an `X/Y`. */
  total?: number;
}

/** An `xmltv_ns` value read back into numbers, all indices still zero-based. */
export interface EpisodeNumbers {
  season: EpisodeField;
  episode: EpisodeField;
  part: EpisodeField;
}

/**
 * The two-letter type a `dd_progid` starts with: `EP` (episode), `SH` (show),
 * `MV` (movie), `SP` (sports), `EV` (event). Open, because Gracenote's own
 * wording is that the prefix "generally" identifies the type.
 */
export type DdProgidType = 'EP' | 'SH' | 'MV' | 'SP' | 'EV' | (string & {});

/**
 * A `dd_progid` taken apart.
 *
 * The three fields partition the id — `` `${type}${rootId}.${discriminator}` ``
 * reassembles it — and the prefix is deliberately not part of `rootId`, because
 * it is not part of the show's identity: the same digits appear as
 * `EP01006886.0028` for an episode and `SH01006886.0000` for its series.
 */
export interface DdProgid {
  type: DdProgidType;
  /** The eight digits identifying the show — `'01006886'`, no prefix. */
  rootId: string;
  /**
   * The four-digit episode discriminator, absent when `'0000'`.
   *
   * Deliberately **not** called an episode number, because it is not one. It
   * tells episodes of a show apart but is not the broadcaster's ordinal: in real
   * Schedules Direct data, Seinfeld S9E17 carries `0196` and Judge Judy S20E213
   * carries `5668`. tvheadend reads it as an episode number and is wrong to;
   * nothing here derives numbering from it.
   */
  discriminator?: string;
}

/** A token of an `xmltv_ns` field: digits only, and short enough to stay exact. */
const DIGITS = /^\d{1,15}$/;

/**
 * One dot-separated field, which may be `X`, `X/Y`, `/Y` or empty.
 *
 * Spaces are legal anywhere in an `xmltv_ns` value — `'1 . 1 . 0/1'` and
 * `'0 . 12/13 . 0/3'` are both in the DTD's own sample — so each half is
 * trimmed. Trimmed rather than stripped, so `'1 2'` stays a rejection instead
 * of quietly reading as twelve.
 */
function fieldOf(raw: string): EpisodeField | undefined {
  const halves = raw.split('/');

  if (halves.length > 2) {
    return undefined;
  }

  // `split` always yields at least one element, and the defaults cover a value
  // with no `/` at all, so neither half is ever missing.
  const [index = '', total = ''] = halves.map((half) => half.trim());
  const field: EpisodeField = {};

  // Empty means *absent*, never zero. `Number('')` is `0`, which would read the
  // legal `'0..'` as "episode 1" — a confident lie about which episode this is.
  if (index !== '') {
    if (!DIGITS.test(index)) {
      return undefined;
    }

    field.index = Number(index);
  }

  if (total !== '') {
    if (!DIGITS.test(total)) {
      return undefined;
    }

    field.total = Number(total);
  }

  return field;
}

/**
 * Read an `xmltv_ns` value — `'1.0.0/1'`, `'0..'`, `'0 . 12/13 . 0/3'`.
 *
 * `undefined` for anything that is not one, including values this package's own
 * builder can emit: `episode('S2', 'two')` writes `NaN.NaN.0/1` and season `0`
 * writes a negative index, so a guide written here is among the inputs that
 * must not parse into nonsense.
 *
 * Also `undefined` for a value that carries no number at all — `''`, `'.'`,
 * `'..'` are structurally fine and say nothing.
 */
export function parseXmltvNsEpisodeNum(value: string): EpisodeNumbers | undefined {
  const parts = value.split('.');

  if (parts.length > 3) {
    return undefined;
  }

  const fields = parts.map(fieldOf);

  if (fields.includes(undefined)) {
    return undefined;
  }

  // Trailing fields are legal to omit, so a short value fills the rest in empty.
  const [season = {}, episode = {}, part = {}] = fields as EpisodeField[];

  // A total with no index still says something — `'./13.'` is "one of thirteen,
  // which one unsaid" — so the emptiness test is for any number at all, not for
  // an index.
  return [season, episode, part].some(
    (field) => field.index !== undefined || field.total !== undefined,
  )
    ? { season, episode, part }
    : undefined;
}

function dimension(field: EpisodeField): string {
  const index = field.index === undefined ? '' : String(field.index);

  return field.total === undefined ? index : `${index}/${field.total}`;
}

/** Write numbers back as `xmltv_ns`, in the canonical space-free form. */
export function formatXmltvNsEpisodeNum(numbers: EpisodeNumbers): string {
  return [numbers.season, numbers.episode, numbers.part].map(dimension).join('.');
}

/**
 * The one `onscreen` grammar worth reading, which is WebGrab+Plus's:
 * `[Sn[/St]] En[/Et] [Pn[/Pt]]` — letters required, spaces optional.
 *
 * It is a superset of everything attested. `S01E01`, padded or not, covers
 * essentially the entire real corpus: Pluto TV, Samsung TV Plus, the
 * Freeview-EPG project and iptv-org's own grabber all emit exactly that, and
 * Kodi and MediaPortal both parse it. `E12` and `Ep 5` are WebGrab+Plus's
 * documented episode-only output. The `P` group is the **only** attested way a
 * part is written anywhere.
 *
 * Anchored, and it deliberately does not read:
 *
 * - **`1x01`** — unattested as an `onscreen` value. No grabber emits it, it has
 *   no hits in tens of thousands of real values, and Kodi strips `x` before
 *   matching, so it could not read one either.
 * - **`(1/2)`** — a trailing `(n/m)` in the wild means episode *n* of *m*
 *   (`tv_grab_uk_freeview` writes `(7/10)` straight into the episode slot), so
 *   reading it as a part would invert real data. Only `P1/2` says "part".
 * - **A bare number** — `5`, `427`, `2706` are all common and irreducibly
 *   ambiguous: an episode in one grabber, a *season* in another, a
 *   distributor's own code in a third.
 * - **Anything trailing** — `S1E2 1` is not a real form, and Kodi's
 *   strip-then-match approach would silently read it as episode 21.
 */
const ONSCREEN =
  /^(?:S(?<season>\d{1,4})(?:\/(?<seasons>\d{1,4}))?[\s._]*)?EP?\s*(?<episode>\d{1,5})(?:\/(?<episodes>\d{1,5}))?(?:[\s._]*P(?<part>\d{1,3})(?:\/(?<parts>\d{1,3}))?)?$/i;

/**
 * A 1-based number from an `onscreen` value, as a 0-based index.
 *
 * `0` means *unknown*, not "the zeroth": `onscreen` counts from one, and `S0 E0`
 * is among the commonest values in real guides — nearly sixteen thousand of them
 * in one public feed.
 */
function ordinal(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const value = Number(raw);

  return value === 0 ? undefined : value - 1;
}

/** A total from an `onscreen` value, which is a count and so stays as it is. */
function count(raw: string | undefined): number | undefined {
  if (raw === undefined) {
    return undefined;
  }

  const value = Number(raw);

  return value === 0 ? undefined : value;
}

function fieldFrom(index: number | undefined, total: number | undefined): EpisodeField {
  return {
    ...(index === undefined ? {} : { index }),
    ...(total === undefined ? {} : { total }),
  };
}

/**
 * Read an `onscreen` value into numbers, or `undefined` if it is none of the
 * forms above. Indices come back **zero-based**, as `xmltv_ns` has them.
 */
export function parseOnscreenEpisodeNum(value: string): EpisodeNumbers | undefined {
  const groups = ONSCREEN.exec(value.trim())?.groups;

  if (groups === undefined) {
    return undefined;
  }

  const episode = ordinal(groups.episode);

  // `E0` is a source saying it does not know, and an episode-num naming no
  // episode is nothing to derive from.
  if (episode === undefined) {
    return undefined;
  }

  return {
    season: fieldFrom(ordinal(groups.season), count(groups.seasons)),
    episode: fieldFrom(episode, count(groups.episodes)),
    part: fieldFrom(ordinal(groups.part), count(groups.parts)),
  };
}

/**
 * Write numbers as `onscreen`, in the form the most consumers read.
 *
 * `S01E01`, padded, because that is what the bulk of real guides carry and what
 * this package's builder already writes. A part becomes ` P1/2` —
 * WebGrab+Plus's documented form, and the only one that means "part" rather
 * than "of a total".
 *
 * `undefined` when there is no episode to name: `'0..'` says which season but
 * not which episode, and `S01` alone is not an episode number — it would be a
 * one-way write that {@link parseOnscreenEpisodeNum} could not read back, and
 * that MediaPortal would take for a bare episode number.
 */
export function formatOnscreenEpisodeNum(numbers: EpisodeNumbers): string | undefined {
  const { season, episode, part } = numbers;

  if (episode.index === undefined) {
    return undefined;
  }

  const number = episode.index + 1;
  // No season to name, so the episode-only form WebGrab+Plus documents.
  const base =
    season.index === undefined
      ? `E${number}`
      : `S${String(season.index + 1).padStart(2, '0')}E${String(number).padStart(2, '0')}`;

  // A part only when there is more than one, matching the builder's own guard —
  // `0.0.0/1` is `S01E01`, not `S01E01 P1/1`.
  return part.index !== undefined && part.total !== undefined && part.total > 1
    ? `${base} P${part.index + 1}/${part.total}`
    : base;
}

/**
 * `EP01006886.0028`, `EP010068860028`, or `EP01006886.0028.0/2` — the three
 * forms XMLTV's own grabbers emit.
 *
 * The trailing field is `part/total`, which `tv_grab_na_dd` documents and also
 * emits separately as `xmltv_ns`, so it is matched and discarded rather than
 * kept twice.
 */
const DD_PROGID =
  /^(?<type>[A-Za-z]{2})(?<rootId>\d{8})(?:\.?(?<discriminator>\d{4}))?(?:\.\d{1,3}\/\d{1,3})?$/;

/**
 * Take a `dd_progid` apart, whichever of its three forms it is in.
 *
 * `undefined` for anything that is not two letters and eight digits. The prefix
 * is uppercased: nothing documents a lowercase one, but every consumer's check
 * for it is case-sensitive, so normalising is free.
 */
export function parseDdProgidEpisodeNum(value: string): DdProgid | undefined {
  const groups = DD_PROGID.exec(value.trim())?.groups;

  if (groups === undefined) {
    return undefined;
  }

  const { type, rootId, discriminator } = groups as {
    type: string;
    rootId: string;
    discriminator?: string;
  };
  const id: DdProgid = { type: type.toUpperCase(), rootId };

  // `0000` is how the wire says "no specific episode" — it is what XMLTV's own
  // grabber builds a series id with — so it is absence, not a value.
  if (discriminator !== undefined && discriminator !== '0000') {
    id.discriminator = discriminator;
  }

  return id;
}

/**
 * Write a `dd_progid` in the dotted two-field form.
 *
 * The only form every consumer reads: tvheadend scans backwards for a dot, so
 * an undotted id yields it neither a series uri nor an episode, and a
 * three-field one makes it read the part as the episode.
 */
export function formatDdProgidEpisodeNum(id: DdProgid): string {
  return `${id.type}${id.rootId}.${id.discriminator ?? '0000'}`;
}

import { describe, expect, it } from 'vitest';
import { ProgrammeBuilder } from '../src/xmltv/builder.js';
import {
  formatDdProgidEpisodeNum,
  formatOnscreenEpisodeNum,
  formatXmltvNsEpisodeNum,
  parseDdProgidEpisodeNum,
  parseOnscreenEpisodeNum,
  parseXmltvNsEpisodeNum,
  type EpisodeNumbers,
} from '../src/xmltv/episode-num.js';

/** Season, episode and part indices, for a compact assertion. */
function indices(numbers: EpisodeNumbers | undefined): (number | undefined)[] | undefined {
  return numbers === undefined
    ? undefined
    : [numbers.season.index, numbers.episode.index, numbers.part.index];
}

describe('xmltv_ns episode numbers', () => {
  it('reads the DTD’s own examples', () => {
    // Straight from xmltv.dtd's "Some examples will make things clearer".
    expect(indices(parseXmltvNsEpisodeNum('1.0.0/1'))).toEqual([1, 0, 0]);
    expect(indices(parseXmltvNsEpisodeNum('1.0.0/2'))).toEqual([1, 0, 0]);
    expect(indices(parseXmltvNsEpisodeNum('1.0.1/2'))).toEqual([1, 0, 1]);
    expect(indices(parseXmltvNsEpisodeNum('0 . 12/13 . 0/3'))).toEqual([0, 12, 0]);
  });

  it('keeps the totals an X/Y gives', () => {
    const numbers = parseXmltvNsEpisodeNum('0 . 12/13 . 0/3');

    expect(numbers?.season.total).toBeUndefined();
    expect(numbers?.episode.total).toBe(13);
    expect(numbers?.part.total).toBe(3);
  });

  it('tolerates spaces wherever the DTD allows them', () => {
    // "You can put spaces whereever you like to make things easier to read",
    // and the DTD's own sample document writes `1 . 1 . 0/1`.
    expect(indices(parseXmltvNsEpisodeNum('1 . 1 . 0/1'))).toEqual([1, 1, 0]);
    expect(indices(parseXmltvNsEpisodeNum(' 2 . 3 . '))).toEqual([2, 3, undefined]);
    expect(parseXmltvNsEpisodeNum('0 . 12 / 13 . ')?.episode.total).toBe(13);
  });

  it('reads an empty field as absent, not as zero', () => {
    // The trap this module exists to avoid: `Number('')` is `0`, so a naive
    // parser reads "season 1, episode unknown" as "episode 1".
    const numbers = parseXmltvNsEpisodeNum('0..');

    expect(numbers?.season.index).toBe(0);
    expect(numbers?.episode.index).toBeUndefined();
    expect(numbers?.part.index).toBeUndefined();

    // And the shape this repo's own fixtures are full of.
    expect(indices(parseXmltvNsEpisodeNum('0.1.'))).toEqual([0, 1, undefined]);
    expect(indices(parseXmltvNsEpisodeNum('.5.'))).toEqual([undefined, 5, undefined]);
  });

  it('accepts fewer than three fields, since trailing ones are optional', () => {
    expect(indices(parseXmltvNsEpisodeNum('0'))).toEqual([0, undefined, undefined]);
    expect(indices(parseXmltvNsEpisodeNum('0.'))).toEqual([0, undefined, undefined]);
    expect(indices(parseXmltvNsEpisodeNum('3.4'))).toEqual([3, 4, undefined]);
  });

  it('reads a half of an X/Y that is given alone', () => {
    expect(parseXmltvNsEpisodeNum('.  /13 .')?.episode).toEqual({ total: 13 });
    expect(parseXmltvNsEpisodeNum('.0/.')?.episode).toEqual({ index: 0 });
  });

  it('refuses a value that names nothing at all', () => {
    // Structurally fine, but carries no index — so there is nothing to derive
    // from and nothing to report.
    for (const value of ['', '.', '..', '  .  .  ']) {
      expect(parseXmltvNsEpisodeNum(value)).toBeUndefined();
    }
  });

  it('refuses what is not an xmltv_ns value', () => {
    for (const value of [
      '1.2.3.4', // four fields
      '-1.0.0', // a sign
      '+1.0.0',
      '1e3.0.0', // exponent notation, which Number() would accept
      '0x10..', // hex, likewise
      'a.b.c',
      'S01E01', // an onscreen value mislabelled
      '1 2.0.0', // two numbers in one field: not twelve
      '0/1/2..', // three halves
      '1..'.padStart(20, '9'), // more digits than stay exact
    ]) {
      expect(parseXmltvNsEpisodeNum(value), value).toBeUndefined();
    }
  });

  it('survives the values this package’s own builder can write', () => {
    // `episode('S2', 'two')` writes NaN, and season 0 writes a negative index,
    // so a guide written here is among the inputs that must not parse into
    // nonsense.
    expect(parseXmltvNsEpisodeNum('NaN.NaN.0/1')).toBeUndefined();
    expect(parseXmltvNsEpisodeNum('-1.4.0/1')).toBeUndefined();
  });

  it('reads back what the builder wrote, for a matrix of episodes', () => {
    // Guards `builder.ts`'s episode numbering against drift: whatever it emits,
    // this reads the numbers it was given.
    for (const [season, episode] of [
      [1, 1],
      [2, 6],
      [10, 252],
      [2026, 12],
    ] as const) {
      const built = new ProgrammeBuilder({
        channel: 'one',
        start: new Date('2026-09-06T12:00:00Z'),
        title: 'Show',
      })
        .episode(episode, season)
        .build();
      const value = built.episodeNum?.find((entry) => entry.system === 'xmltv_ns')?.value;

      expect(value, `S${season}E${episode}`).toBeDefined();
      expect(indices(parseXmltvNsEpisodeNum(value!))).toEqual([season - 1, episode - 1, 0]);
    }
  });

  it('normalises spacing on the way back out without changing meaning', () => {
    const numbers = parseXmltvNsEpisodeNum('0 . 12/13 . 0/3');

    expect(formatXmltvNsEpisodeNum(numbers!)).toBe('0.12/13.0/3');
    // And an omitted field stays omitted rather than becoming a zero.
    expect(formatXmltvNsEpisodeNum(parseXmltvNsEpisodeNum('0..')!)).toBe('0..');
    expect(formatXmltvNsEpisodeNum(parseXmltvNsEpisodeNum('.5.')!)).toBe('.5.');
  });
});

describe('onscreen episode numbers', () => {
  it('reads the form real guides overwhelmingly use', () => {
    // Pluto TV, Samsung TV Plus, Freeview-EPG and iptv-org's grabber all emit
    // exactly this, padded or not.
    expect(indices(parseOnscreenEpisodeNum('S01E01'))).toEqual([0, 0, undefined]);
    expect(indices(parseOnscreenEpisodeNum('S1E2'))).toEqual([0, 1, undefined]);
    expect(indices(parseOnscreenEpisodeNum('s2e6'))).toEqual([1, 5, undefined]);
    expect(indices(parseOnscreenEpisodeNum('S01E252'))).toEqual([0, 251, undefined]);
    // A year used as a season, which real feeds do.
    expect(indices(parseOnscreenEpisodeNum('S2025E12'))).toEqual([2024, 11, undefined]);
  });

  it('allows the separators WebGrab+Plus and Kodi do', () => {
    expect(indices(parseOnscreenEpisodeNum('S1 E10'))).toEqual([0, 9, undefined]);
    expect(indices(parseOnscreenEpisodeNum('S1.E2'))).toEqual([0, 1, undefined]);
    expect(indices(parseOnscreenEpisodeNum('S1_E2'))).toEqual([0, 1, undefined]);
    expect(indices(parseOnscreenEpisodeNum('  S01E01  '))).toEqual([0, 0, undefined]);
  });

  it('reads an episode with no season', () => {
    // WebGrab+Plus's documented `E12`, and the `Ep` spelling Kodi accepts.
    expect(indices(parseOnscreenEpisodeNum('E12'))).toEqual([undefined, 11, undefined]);
    expect(indices(parseOnscreenEpisodeNum('Ep 5'))).toEqual([undefined, 4, undefined]);
    expect(indices(parseOnscreenEpisodeNum('EP12'))).toEqual([undefined, 11, undefined]);
  });

  it('reads the totals and the part WebGrab+Plus documents', () => {
    const numbers = parseOnscreenEpisodeNum('S2/4 E12/20 P1/2');

    expect(indices(numbers)).toEqual([1, 11, 0]);
    expect(numbers?.season.total).toBe(4);
    expect(numbers?.episode.total).toBe(20);
    expect(numbers?.part.total).toBe(2);

    // A part may be given with no total, which its grammar allows.
    expect(parseOnscreenEpisodeNum('S2 E12 P1')?.part).toEqual({ index: 0 });
    expect(parseOnscreenEpisodeNum('E4 P2')?.part).toEqual({ index: 1 });
    expect(parseOnscreenEpisodeNum('E12/24')?.episode).toEqual({ index: 11, total: 24 });
  });

  it('treats a zero as unknown, because onscreen counts from one', () => {
    // `S0 E0` is one of the commonest onscreen values in real guides — nearly
    // sixteen thousand in a single public feed — and it means "no idea", not
    // season zero, episode zero.
    expect(parseOnscreenEpisodeNum('S0 E0')).toBeUndefined();
    expect(parseOnscreenEpisodeNum('E0')).toBeUndefined();
    expect(indices(parseOnscreenEpisodeNum('S0E5'))).toEqual([undefined, 4, undefined]);
  });

  it('refuses a bare number, which is irreducibly ambiguous', () => {
    // Very common, and the meaning is not recoverable: an episode in one
    // grabber, a season in another, a distributor's own code in a third. This
    // repo's own fixture carries `427`.
    for (const value of ['5', '427', '2706', '12']) {
      expect(parseOnscreenEpisodeNum(value), value).toBeUndefined();
    }
  });

  it('refuses forms that are unattested or would invert real data', () => {
    for (const value of [
      '1x01', // no grabber emits it; Kodi strips the x and cannot read it
      '1X01',
      'S01E01 (1/2)', // in the wild `(n/m)` is episode-of-total, not a part
      '(7/10)',
      'S01E01 1', // not a real form; strip-and-match would read episode 21
      'S01E01 Part 1',
      '#FFEE', // the DTD's own example of free-form onscreen text
      'Episode #FFEE',
      'Part 2',
      '3:10',
      '2 5',
      'V./3',
      '(S5, ep 4)',
      'S01', // a season with no episode is not an episode number
      '',
    ]) {
      expect(parseOnscreenEpisodeNum(value), value).toBeUndefined();
    }
  });

  it('writes only forms it can read back', () => {
    const through = (value: string): string | undefined =>
      formatOnscreenEpisodeNum(parseOnscreenEpisodeNum(value)!);

    expect(through('S01E13')).toBe('S01E13');
    expect(through('S1E2')).toBe('S01E02');
    expect(through('E12')).toBe('E12');
    expect(through('S02E06 P1/3')).toBe('S02E06 P1/3');

    for (const value of ['S01E13', 'E12', 'S02E06 P1/3']) {
      expect(parseOnscreenEpisodeNum(through(value)!), value).toEqual(
        parseOnscreenEpisodeNum(value),
      );
    }
  });

  it('writes no part unless there is more than one', () => {
    // Matching the builder's own `parts > 1` guard: `0.0.0/1` is one part,
    // which is to say no parts.
    expect(formatOnscreenEpisodeNum(parseXmltvNsEpisodeNum('0.0.0/1')!)).toBe('S01E01');
    expect(formatOnscreenEpisodeNum(parseXmltvNsEpisodeNum('1.5.1/2')!)).toBe('S02E06 P2/2');
  });

  it('writes nothing when there is no episode to name', () => {
    // `0..` says which season but not which episode. `S01` alone is not an
    // episode number, and nothing could read it back.
    expect(formatOnscreenEpisodeNum(parseXmltvNsEpisodeNum('0..')!)).toBeUndefined();
    expect(
      formatOnscreenEpisodeNum({ season: { index: 3 }, episode: {}, part: {} }),
    ).toBeUndefined();
  });

  it('writes the episode-only form when the season is unknown', () => {
    expect(formatOnscreenEpisodeNum(parseXmltvNsEpisodeNum('.12.')!)).toBe('E13');
  });
});

describe('dd_progid', () => {
  it('reads all three forms XMLTV’s own grabbers emit', () => {
    const dotted = { type: 'EP', rootId: '01006886', discriminator: '0028' };

    // `tv_grab_zz_sdjson_sqlite` and `tv_grab_na_dd` — the whole real corpus.
    expect(parseDdProgidEpisodeNum('EP01006886.0028')).toEqual(dotted);
    // `tv_grab_zz_sdjson`, which dumps the raw 14-character programID.
    expect(parseDdProgidEpisodeNum('EP010068860028')).toEqual(dotted);
    // `tv_grab_na_dd`'s documented `a.b.c/d`, whose part is redundant with the
    // xmltv_ns it emits alongside.
    expect(parseDdProgidEpisodeNum('EP01006886.0028.0/2')).toEqual(dotted);
  });

  it('normalises every form to the only one every consumer reads', () => {
    // tvheadend scans backwards for a dot: an undotted id yields it neither a
    // series uri nor an episode, and a three-field one makes it read the part
    // as the episode.
    for (const value of ['EP01006886.0028', 'EP010068860028', 'EP01006886.0028.0/2']) {
      expect(formatDdProgidEpisodeNum(parseDdProgidEpisodeNum(value)!), value).toBe(
        'EP01006886.0028',
      );
    }
  });

  it('partitions the id, so reassembling it returns the original', () => {
    const id = parseDdProgidEpisodeNum('EP01006886.0028')!;

    expect(id.type).toBe('EP');
    expect(id.rootId).toBe('01006886');
    expect(id.discriminator).toBe('0028');
    expect(`${id.type}${id.rootId}.${id.discriminator}`).toBe('EP01006886.0028');
  });

  it('gives an episode and its series the same rootId', () => {
    // The property the whole decomposition exists for: the prefix is not part
    // of the show's identity, and XMLTV's own grabber builds the series id by
    // swapping it.
    const episode = parseDdProgidEpisodeNum('EP01006886.0028')!;
    const series = parseDdProgidEpisodeNum('SH01006886.0000')!;

    expect(series.rootId).toBe(episode.rootId);
    expect(series.discriminator).toBeUndefined();
    expect(`SH${episode.rootId}0000`).toBe('SH010068860000');
  });

  it('uppercases the prefix, since every consumer checks it case-sensitively', () => {
    expect(parseDdProgidEpisodeNum('ep01006886.0028')?.type).toBe('EP');
  });

  it('accepts a prefix nobody has written down', () => {
    // Gracenote says the first two characters "generally" identify the type, so
    // an unknown one still normalises — the dot is what makes an id readable,
    // not the prefix.
    expect(parseDdProgidEpisodeNum('XX01006886.0028')).toEqual({
      type: 'XX',
      rootId: '01006886',
      discriminator: '0028',
    });
  });

  it('refuses what is not a dd_progid', () => {
    for (const value of [
      '1P01006886.0028', // a digit where a letter belongs
      'E01006886.0028', // one letter
      'EPP1006886.0028', // three
      'EP0100688.0028', // seven digits
      'EP010068861.0028', // nine
      'EP01006886.002', // three-digit tail
      'EP01006886.00288',
      'S01E01',
      '',
    ]) {
      expect(parseDdProgidEpisodeNum(value), value).toBeUndefined();
    }
  });

  it('does not turn the discriminator into an episode number', () => {
    // The finding this whole design rests on: in real Schedules Direct data
    // Seinfeld S9E17 carries 0196 and Judge Judy S20E213 carries 5668, so the
    // tail is not an ordinal. tvheadend reads it as one and is wrong to.
    const seinfeld = parseDdProgidEpisodeNum('EP00003636.0196')!;

    expect(seinfeld.discriminator).toBe('0196');
    expect(seinfeld).not.toHaveProperty('episode');
    // Nothing here can turn it into episode numbers, by construction: it is a
    // dd_progid, and neither of the other parsers reads one.
    expect(parseOnscreenEpisodeNum('EP00003636.0196')).toBeUndefined();
    expect(parseXmltvNsEpisodeNum('EP00003636.0196')).toBeUndefined();
  });
});

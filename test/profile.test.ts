import { describe, expect, it } from 'vitest';
import {
  OUTPUT_PROFILE_NAMES,
  OUTPUT_PROFILES,
  pick,
  resolveProfile,
  type OutputProfile,
  type ResolvedKeepRule,
} from '../src/xmltv/profile.js';
import type { XmltvEpisodeNum, XmltvTextValue } from '../src/xmltv/types.js';

/** Run a profile's episode-num policy over a list. */
function episodes(profile: OutputProfile, entries: XmltvEpisodeNum[]): XmltvEpisodeNum[] {
  const rewrite = resolveProfile(profile).episodeNum;

  return rewrite === undefined ? entries : rewrite(entries);
}

/** Run a profile's category policy over a list. */
function categories(profile: OutputProfile, values: XmltvTextValue[]): XmltvTextValue[] {
  const rewrite = resolveProfile(profile).categories;

  return rewrite === undefined ? values : rewrite(values);
}

/** The compiled keep rule for one path, which the profile is expected to have. */
function keepRule(profile: OutputProfile, path: string): ResolvedKeepRule {
  const rules = resolveProfile(profile).keep;

  expect(rules?.has(path), path).toBe(true);

  return (rules as ReadonlyMap<string, ResolvedKeepRule>).get(path)!;
}

describe('resolveProfile', () => {
  it('compiles nothing for a profile that asks for nothing', () => {
    expect(resolveProfile({})).toEqual({});
  });

  it('returns the same compiled profile for the same input', () => {
    // Resolved once per profile, not once per element: the serializer rebuilds
    // its formatting record for every channel and programme in the guide.
    const profile: OutputProfile = { drop: ['programme/review'] };

    expect(resolveProfile(profile)).toBe(resolveProfile(profile));
    expect(resolveProfile('tvheadend')).toBe(resolveProfile('tvheadend'));
  });

  it('refuses a name it does not ship', () => {
    expect(() => resolveProfile('plex' as 'tvheadend')).toThrow(/Unknown output profile: plex/);
    expect(() => resolveProfile('plex' as 'tvheadend')).toThrow(/tvheadend, jellyfin/);
  });

  it('ships only the profiles that were read from source', () => {
    // No Plex or Emby: both are closed, so a profile for either would be a
    // guess, and a wrong profile is worse than none.
    expect(OUTPUT_PROFILE_NAMES).toEqual(['tvheadend', 'jellyfin']);
  });

  it('refuses a path that names no optional element', () => {
    for (const path of ['programme/title', 'channel/display-name', 'image', 'credits/actor']) {
      expect(() => resolveProfile({ drop: [path as 'programme/review'] }), path).toThrow(
        /not an optional element/,
      );
    }
  });

  it('refuses narrowing something that occurs once', () => {
    expect(() => resolveProfile({ keep: { 'programme/video': 1 } as never })).toThrow(
      /the DTD allows at most one/,
    );
  });

  it('refuses a count that is not one', () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      expect(() => resolveProfile({ keep: { 'programme/icon': bad } }), String(bad)).toThrow(
        /expected a whole number/,
      );
    }
  });
});

describe('keep', () => {
  const icons = [{ src: 'a' }, { src: 'b' }, { src: 'c' }];

  it('takes a count from the front', () => {
    const rule = keepRule({ keep: { 'programme/icon': 1 } }, 'programme/icon');

    expect(pick(rule, icons)).toEqual([{ src: 'a' }]);
  });

  it('takes nothing for a count of zero', () => {
    const rule = keepRule({ keep: { 'programme/icon': 0 } }, 'programme/icon');

    expect(pick(rule, icons)).toEqual([]);
  });

  it('lets a function choose comparatively, which a count cannot', () => {
    // The case that earns the function form: prefer one language, but not at
    // the cost of having none.
    const english = (all: readonly XmltvTextValue[]): readonly XmltvTextValue[] => {
      const found = all.filter((desc) => desc.lang === 'en');

      return found.length > 0 ? found : all.slice(0, 1);
    };
    const rule = keepRule({ keep: { 'programme/desc': english } }, 'programme/desc');

    expect(
      pick(rule, [
        { value: 'Ahoj', lang: 'sk' },
        { value: 'Hello', lang: 'en' },
      ]),
    ).toEqual([{ value: 'Hello', lang: 'en' }]);
    // Nothing in English, so rather than nothing at all, the first.
    expect(
      pick(rule, [
        { value: 'Ahoj', lang: 'sk' },
        { value: 'Cześć', lang: 'pl' },
      ]),
    ).toEqual([{ value: 'Ahoj', lang: 'sk' }]);
  });

  it('lets a function reorder as well as filter', () => {
    const widest = (all: readonly { src: string; width?: number }[]) =>
      [...all].sort((a, b) => (b.width ?? 0) - (a.width ?? 0)).slice(0, 1);
    const rule = keepRule({ keep: { 'programme/icon': widest } }, 'programme/icon');

    expect(
      pick(rule, [
        { src: 'small', width: 100 },
        { src: 'big', width: 900 },
      ]),
    ).toEqual([{ src: 'big', width: 900 }]);
  });
});

describe('episodeNum', () => {
  it('orders the systems as they were asked for', () => {
    // The real-world case: one XMLTV grabber writes `dd_progid` before
    // `xmltv_ns`, and MediaPortal reads only the first entry.
    const out = episodes({ episodeNum: { systems: ['xmltv_ns', 'dd_progid'] } }, [
      { system: 'dd_progid', value: 'EP01006886.0028' },
      { system: 'xmltv_ns', value: '0.1.' },
    ]);

    expect(out.map((entry) => entry.system)).toEqual(['xmltv_ns', 'dd_progid']);
  });

  it('drops a system that was not asked for', () => {
    const out = episodes({ episodeNum: { systems: ['xmltv_ns'] } }, [
      { system: 'xmltv_ns', value: '0.1.' },
      { system: 'onscreen', value: 'S01E02' },
    ]);

    expect(out).toEqual([{ system: 'xmltv_ns', value: '0.1.' }]);
  });

  it('treats an entry with no system as onscreen, which the DTD says it is', () => {
    // Filtering on `entry.system` alone would silently delete every bare
    // `<episode-num>S01E02</episode-num>`.
    const bare: XmltvEpisodeNum[] = [{ value: 'S01E02' }];

    expect(episodes({ episodeNum: { systems: ['onscreen'] } }, bare)).toEqual(bare);
    expect(episodes({ episodeNum: { systems: ['xmltv_ns'] } }, bare)).toEqual([]);
  });

  it('keeps the extension attributes of a surviving entry', () => {
    // Reordering must not quietly strip them: `extensions` cannot see an
    // attribute on an element that was never written.
    const out = episodes({ episodeNum: { systems: ['xmltv_ns'] } }, [
      { system: 'xmltv_ns', value: '0.1.', extraAttributes: { verified: 'no' } },
    ]);

    expect(out[0]?.extraAttributes).toEqual({ verified: 'no' });
  });

  it('emits one entry under single', () => {
    const out = episodes({ episodeNum: { systems: ['xmltv_ns', 'onscreen'], single: true } }, [
      { system: 'onscreen', value: 'S01E02' },
      { system: 'xmltv_ns', value: '0.1.' },
    ]);

    expect(out).toEqual([{ system: 'xmltv_ns', value: '0.1.' }]);
  });

  it('derives a missing system from one that is present', () => {
    const profile: OutputProfile = {
      episodeNum: { systems: ['xmltv_ns', 'onscreen'], deriveMissing: true },
    };

    expect(episodes(profile, [{ system: 'onscreen', value: 'S02E06' }])).toEqual([
      { system: 'xmltv_ns', value: '1.5.' },
      { system: 'onscreen', value: 'S02E06' },
    ]);
    expect(episodes(profile, [{ system: 'xmltv_ns', value: '1.5.' }])).toEqual([
      { system: 'xmltv_ns', value: '1.5.' },
      { system: 'onscreen', value: 'S02E06' },
    ]);
  });

  it('never derives over an entry a source supplied', () => {
    // `onscreen` is free-form display text — the DTD's own example is
    // `#FFEE` — so replacing one with a fabricated `S02E06` is data loss.
    const out = episodes(
      { episodeNum: { systems: ['xmltv_ns', 'onscreen'], deriveMissing: true } },
      [
        { system: 'xmltv_ns', value: '1.5.' },
        { system: 'onscreen', value: '#FFEE' },
      ],
    );

    expect(out).toEqual([
      { system: 'xmltv_ns', value: '1.5.' },
      { system: 'onscreen', value: '#FFEE' },
    ]);
  });

  it('derives nothing from a value it cannot read', () => {
    const out = episodes(
      { episodeNum: { systems: ['xmltv_ns', 'onscreen'], deriveMissing: true } },
      [{ system: 'onscreen', value: 'Episode #FFEE' }],
    );

    expect(out).toEqual([{ system: 'onscreen', value: 'Episode #FFEE' }]);
  });

  it('normalises every dd_progid form to the one every consumer reads', () => {
    const profile: OutputProfile = { episodeNum: { normalizeDdProgid: true } };

    for (const value of ['EP01006886.0028', 'EP010068860028', 'EP01006886.0028.0/2']) {
      expect(episodes(profile, [{ system: 'dd_progid', value }]), value).toEqual([
        { system: 'dd_progid', value: 'EP01006886.0028' },
      ]);
    }
  });

  it('leaves a dd_progid it cannot read exactly as it came', () => {
    const out = episodes({ episodeNum: { normalizeDdProgid: true } }, [
      { system: 'dd_progid', value: 'not-an-id' },
    ]);

    expect(out).toEqual([{ system: 'dd_progid', value: 'not-an-id' }]);
  });

  it('never turns a dd_progid into an episode number', () => {
    // Seinfeld S9E17 really carries 0196 in Schedules Direct data, so the tail
    // is not an ordinal. tvheadend reads it as one and is wrong to.
    const out = episodes(
      { episodeNum: { systems: ['xmltv_ns', 'dd_progid'], deriveMissing: true } },
      [{ system: 'dd_progid', value: 'EP00003636.0196' }],
    );

    expect(out).toEqual([{ system: 'dd_progid', value: 'EP00003636.0196' }]);
    expect(out.some((entry) => entry.system === 'xmltv_ns')).toBe(false);
  });
});

describe('categories', () => {
  it('rewrites text to the vocabulary a consumer matches on', () => {
    // `Movie` means nothing to it; `Movie / Drama` means a film.
    expect(categories({ categories: true }, [{ value: 'Movie' }])).toEqual([
      { value: 'Movie / Drama', lang: 'en' },
    ]);
  });

  it('says the language it rewrote into, rather than keeping a false one', () => {
    // A `lang="de"` left on English text is a lie the merge would believe: its
    // dedup key is `(lang, value)`.
    expect(categories({ categories: true }, [{ value: 'Film', lang: 'de' }])).toEqual([
      { value: 'Movie / Drama', lang: 'en' },
    ]);
  });

  it('leaves a category the vocabulary does not know', () => {
    // `Series` is among the commonest categories in any real guide and DVB has
    // no concept for it, so it passes through untouched.
    expect(categories({ categories: true }, [{ value: 'Series', lang: 'en' }])).toEqual([
      { value: 'Series', lang: 'en' },
    ]);
  });

  it('emits a genre once when two categories canonicalise onto it', () => {
    // The merge deduped on `(lang, value)` before any of this ran, so the
    // rewrite has to dedupe its own output.
    expect(
      categories({ categories: true }, [
        { value: 'Movie', lang: 'en' },
        { value: 'Film', lang: 'de' },
      ]),
    ).toEqual([{ value: 'Movie / Drama', lang: 'en' }]);
  });

  it('keeps the original language for a caller’s own map', () => {
    // Mapping into canonical German is a reasonable thing to have written, and
    // stamping `en` on it would introduce the very lie we avoid above.
    expect(
      categories({ categories: { Spielfilm: 'Kinofilm' } }, [{ value: 'Spielfilm', lang: 'de' }]),
    ).toEqual([{ value: 'Kinofilm', lang: 'de' }]);
  });

  it('matches a caller’s keys the way the vocabulary is matched', () => {
    const profile: OutputProfile = {
      categories: { 'sci-fi': 'Science fiction / Fantasy / Horror' },
    };

    for (const value of ['Sci-Fi', 'sci fi', 'SciFi']) {
      expect(categories(profile, [{ value }]), value).toEqual([
        { value: 'Science fiction / Fantasy / Horror' },
      ]);
    }
  });

  it('lets a mapper leave a category alone, change it, or drop it', () => {
    const out = categories(
      {
        categories: (category) => {
          if (category.value === 'Filler') {
            return null;
          }

          return category.value === 'Movie' ? 'Film' : undefined;
        },
      },
      [{ value: 'Movie' }, { value: 'Filler' }, { value: 'Series' }],
    );

    expect(out).toEqual([{ value: 'Film' }, { value: 'Series' }]);
  });

  it('attaches the genre code when asked, as an extension attribute', () => {
    // In `extraAttributes` on purpose: that is what puts it behind the
    // `extensions` policy, so `--no-extensions` still yields a DTD-valid
    // document.
    expect(categories({ categories: true, eit: true }, [{ value: 'Documentary' }])).toEqual([
      { value: 'Documentary', lang: 'en', extraAttributes: { eit: '0x23' } },
    ]);
  });

  it('attaches a code without rewriting, when the text is already canonical', () => {
    expect(categories({ eit: true }, [{ value: 'Sports', lang: 'en' }])).toEqual([
      { value: 'Sports', lang: 'en', extraAttributes: { eit: '0x40' } },
    ]);
  });

  it('leaves a code the source supplied', () => {
    // It knows its own data better than a lookup table does.
    expect(
      categories({ categories: true, eit: true }, [
        { value: 'Documentary', extraAttributes: { eit: '0x99' } },
      ]),
    ).toEqual([{ value: 'Documentary', lang: 'en', extraAttributes: { eit: '0x99' } }]);
  });

  it('does not mutate what it was given', () => {
    // A server re-serializes cached programme objects on every poll, so an
    // in-place edit would compound.
    const original: XmltvTextValue[] = [{ value: 'Movie', lang: 'de' }];
    const before = structuredClone(original);

    categories({ categories: true, eit: true }, original);

    expect(original).toEqual(before);
  });
});

describe('the shipped profiles', () => {
  it('keep dd_progid rather than dropping it', () => {
    // The naive reading of "one episode-num" would have thrown away the entry
    // both consumers actually want: Jellyfin reads it as the programme's id,
    // tvheadend takes the series uri from it.
    for (const name of OUTPUT_PROFILE_NAMES) {
      expect(OUTPUT_PROFILES[name].episodeNum.systems, name).toContain('dd_progid');
      expect(OUTPUT_PROFILES[name].episodeNum).not.toHaveProperty('single');
    }
  });

  it('put xmltv_ns first, which is what fixes the episode number', () => {
    for (const name of OUTPUT_PROFILE_NAMES) {
      expect(OUTPUT_PROFILES[name].episodeNum.systems[0], name).toBe('xmltv_ns');
    }
  });

  it('compose by spreading, so there is no merge API', () => {
    const quiet = resolveProfile({ ...OUTPUT_PROFILES.tvheadend, eit: false });

    expect(
      categories({ ...OUTPUT_PROFILES.tvheadend, eit: false }, [{ value: 'Documentary' }]),
    ).toEqual([{ value: 'Documentary', lang: 'en' }]);
    expect(quiet.drop?.has('programme/image')).toBe(true);
  });
});

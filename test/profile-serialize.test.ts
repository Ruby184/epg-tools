import { describe, expect, it } from 'vitest';
import {
  serializeChannel,
  serializeProgramme,
  validateXmltv,
  type SerializeOptions,
} from '../src/xmltv/main.js';
import { OUTPUT_PROFILES } from '../src/xmltv/profile.js';
import type { XmltvChannel, XmltvProgramme, XmltvTextValue } from '../src/xmltv/types.js';

const START = new Date('2026-09-06T12:00:00Z');

/** A programme carrying one of everything a profile might touch. */
function programme(): XmltvProgramme {
  return {
    channel: 'one.tv',
    start: START,
    title: [{ value: 'Spectre', lang: 'en' }],
    subTitle: [{ value: 'Part one', lang: 'en' }],
    desc: [
      { value: 'Ahoj', lang: 'sk' },
      { value: 'Hello', lang: 'en' },
      { value: 'Cześć', lang: 'pl' },
    ],
    credits: {
      director: ['Sam Mendes'],
      actor: [{ value: 'Daniel Craig' }, { value: 'Léa Seydoux' }],
    },
    date: new Date('2015-01-01T00:00:00Z'),
    category: [{ value: 'Movie', lang: 'en' }],
    keyword: [{ value: 'spy', lang: 'en' }],
    language: { value: 'English' },
    length: { units: 'minutes', value: 148 },
    icon: [
      { src: 'small.png', width: 100 },
      { src: 'big.png', width: 900 },
    ],
    url: ['https://example.com/spectre'],
    country: [{ value: 'GB' }],
    episodeNum: [
      { system: 'dd_progid', value: 'EP010068860028' },
      { system: 'xmltv_ns', value: '0.1.' },
    ],
    video: { present: true, colour: true, aspect: '16:9', quality: 'HDTV' },
    audio: { present: true, stereo: 'Dolby Digital' },
    new: true,
    subtitles: [{ type: 'teletext', language: { value: 'English' } }],
    rating: [{ system: 'BBFC', value: '12A', icon: [{ src: '12a.png' }] }],
    starRating: [{ value: '7/10', system: 'imdb' }],
    review: [{ type: 'text', value: 'Good', source: 'RT' }],
    image: [{ value: 'https://example.com/poster.jpg', type: 'poster' }],
  };
}

function write(options?: SerializeOptions): string {
  return serializeProgramme(programme(), options);
}

describe('a document written with no profile', () => {
  it('is exactly the document this package always wrote', () => {
    // The regression guard for the whole feature: `serializeProgramme` and
    // `serializeChannel` are public API, and adding a profile option must not
    // move a byte for anyone who does not pass one.
    const plain = write({ indent: 2 });

    expect(write({ indent: 2, profile: {} })).toBe(plain);
    expect(write({ indent: 2, extensions: true })).toBe(plain);
  });
});

describe('drop', () => {
  it('leaves out the elements a profile names', () => {
    const out = write({ indent: 2, profile: { drop: ['programme/review', 'programme/image'] } });

    expect(out).not.toContain('<review');
    expect(out).not.toContain('<image');
    // And nothing else went with them.
    expect(out).toContain('<title lang="en">Spectre</title>');
    expect(out).toContain('<star-rating system="imdb">');
  });

  it('tells a programme’s icons from a channel’s and a rating’s', () => {
    // `<icon>` occurs under four elements, which is why paths are rooted.
    const out = write({ indent: 2, profile: { drop: ['programme/icon'] } });

    expect(out).not.toContain('big.png');
    // The rating still has its own.
    expect(out).toContain('12a.png');

    const channel: XmltvChannel = {
      id: 'one.tv',
      displayName: [{ value: 'One' }],
      icon: [{ src: 'logo.png' }],
    };

    expect(serializeChannel(channel, { profile: { drop: ['programme/icon'] } })).toContain(
      'logo.png',
    );
    expect(serializeChannel(channel, { profile: { drop: ['channel/icon'] } })).not.toContain(
      'logo.png',
    );
  });

  it('takes a rating’s icon without touching the programme’s', () => {
    const out = write({ indent: 2, profile: { drop: ['programme/rating/icon'] } });

    expect(out).not.toContain('12a.png');
    expect(out).toContain('big.png');
    // `<value>` is required, so it survives regardless.
    expect(out).toContain('<value>12A</value>');
  });

  it('drops one credit role and leaves the others', () => {
    const out = write({ indent: 2, profile: { drop: ['programme/credits/actor'] } });

    expect(out).toContain('<director>Sam Mendes</director>');
    expect(out).not.toContain('Daniel Craig');
    expect(out).toContain('<credits>');
  });

  it('writes no credits block when the container is dropped, and the same when every role is', () => {
    // Both routes must produce identical bytes: the container short-circuits,
    // the ten-role form relies on the empty parent collapsing.
    const viaContainer = write({ indent: 2, profile: { drop: ['programme/credits'] } });
    const viaRoles = write({
      indent: 2,
      profile: {
        drop: [
          'programme/credits/director',
          'programme/credits/actor',
          'programme/credits/writer',
          'programme/credits/adapter',
          'programme/credits/producer',
          'programme/credits/composer',
          'programme/credits/editor',
          'programme/credits/presenter',
          'programme/credits/commentator',
          'programme/credits/guest',
        ],
      },
    });

    expect(viaContainer).not.toContain('<credits>');
    expect(viaContainer).toBe(viaRoles);
  });

  it('collapses a video block whose details all went, rather than writing nothing', () => {
    const out = write({
      indent: 2,
      profile: {
        drop: [
          'programme/video/present',
          'programme/video/colour',
          'programme/video/aspect',
          'programme/video/quality',
        ],
      },
    });

    // `<video/>` is what the DTD allows here, and what the existing collapse
    // logic produces once the children are gone.
    expect(out).toContain('<video/>');
    expect(out).not.toContain('<aspect>');
  });

  it('drops a single optional element', () => {
    const out = write({
      indent: 2,
      profile: { drop: ['programme/date', 'programme/length', 'programme/new'] },
    });

    expect(out).not.toContain('<date>');
    expect(out).not.toContain('<length');
    expect(out).not.toContain('<new/>');
  });

  it('drops a subtitles language without dropping the block', () => {
    const out = write({ indent: 2, profile: { drop: ['programme/subtitles/language'] } });

    // Collapsed to the empty form the DTD allows, rather than omitted.
    expect(out).toContain('<subtitles type="teletext"/>');
    // The programme's own `<language>` is untouched — a different path, even
    // though the two elements share a name and, here, their text.
    expect(out).toContain('<language>English</language>');
  });
});

describe('keep', () => {
  it('takes a count from the front', () => {
    const out = write({ indent: 2, profile: { keep: { 'programme/icon': 1 } } });

    expect(out).toContain('small.png');
    expect(out).not.toContain('big.png');
  });

  it('lets a function pick comparatively', () => {
    const out = write({
      indent: 2,
      profile: {
        keep: {
          'programme/icon': (all) =>
            [...all].sort((a, b) => (b.width ?? 0) - (a.width ?? 0)).slice(0, 1),
        },
      },
    });

    expect(out).toContain('big.png');
    expect(out).not.toContain('small.png');
  });

  it('serves one language without losing the programmes that lack it', () => {
    const english = (all: readonly XmltvTextValue[]): readonly XmltvTextValue[] => {
      const found = all.filter((desc) => desc.lang === 'en');

      return found.length > 0 ? found : all.slice(0, 1);
    };
    const out = write({ indent: 2, profile: { keep: { 'programme/desc': english } } });

    expect(out).toContain('<desc lang="en">Hello</desc>');
    expect(out).not.toContain('Ahoj');
    expect(out).not.toContain('Cześć');
  });
});

describe('episode-num', () => {
  it('orders the systems, normalises the id and derives what is missing', () => {
    const out = write({ indent: 2, profile: OUTPUT_PROFILES.tvheadend });
    const order = [...out.matchAll(/<episode-num system="([^"]+)"/gu)].map(([, system]) => system);

    // xmltv_ns first, which is what stops the consumer reading the dd_progid
    // tail as an episode number.
    expect(order).toEqual(['xmltv_ns', 'dd_progid', 'onscreen']);
    // The undotted id, which tvheadend cannot read, becomes the dotted one.
    expect(out).toContain('>EP01006886.0028<');
    // And the onscreen entry is derived from the xmltv_ns one.
    expect(out).toContain('>S01E02<');
  });

  it('leaves episode numbers alone with no profile', () => {
    const out = write({ indent: 2 });

    expect(out).toContain('>EP010068860028<');
    expect(out).not.toContain('S01E02');
  });
});

describe('categories and eit', () => {
  it('rewrites text to what a consumer matches on', () => {
    const out = write({ indent: 2, profile: { categories: true } });

    expect(out).toContain('<category lang="en">Movie / Drama</category>');
  });

  it('adds the genre code as an extension attribute', () => {
    const out = write({ indent: 2, profile: { categories: true, eit: true } });

    expect(out).toContain('<category lang="en" eit="0x10">Movie / Drama</category>');
  });

  it('lets the extension policy remove the code, which keeps no-extensions honest', () => {
    // The interaction worth stating out loud: `--no-extensions` wins over a
    // profile that asks for `eit`, because `eit` is a non-DTD attribute and
    // "no extensions" has to keep meaning "a document that validates".
    const out = write({ indent: 2, extensions: false, profile: OUTPUT_PROFILES.tvheadend });

    expect(out).not.toContain('eit=');
    expect(out).toContain('Movie / Drama');
  });

  it('removes the code under an allowlist that does not name it', () => {
    const out = write({ indent: 2, extensions: ['lcn'], profile: { categories: true, eit: true } });

    expect(out).not.toContain('eit=');
  });
});

describe('a profiled document', () => {
  it('still validates for each shipped profile', async () => {
    for (const [name, profile] of Object.entries(OUTPUT_PROFILES)) {
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n` +
        serializeChannel(
          { id: 'one.tv', displayName: [{ value: 'One' }] },
          { indent: 2, profile },
        ) +
        serializeProgramme(programme(), { indent: 2, profile }) +
        `</tv>\n`;
      const report = await validateXmltv([xml]);

      expect(
        report.findings.filter((finding) => finding.severity === 'error'),
        name,
      ).toEqual([]);
      expect(report.errors, name).toBe(0);
    }
  });

  it('is unchanged by applying the same profile again', () => {
    // Idempotency: the category rewrite must be a fixed point, and the derived
    // episode-num must not be re-derived into something else.
    const once = write({ indent: 2, profile: OUTPUT_PROFILES.tvheadend });
    const parsed = programme();
    // Feed the shaped values back in and shape again.
    const twice = serializeProgramme(
      {
        ...parsed,
        category: [{ value: 'Movie / Drama', lang: 'en' }],
        episodeNum: [
          { system: 'xmltv_ns', value: '0.1.' },
          { system: 'dd_progid', value: 'EP01006886.0028' },
          { system: 'onscreen', value: 'S01E02' },
        ],
      },
      { indent: 2, profile: OUTPUT_PROFILES.tvheadend },
    );

    expect(twice).toBe(once);
  });

  it('does not mutate the programme it was given', () => {
    // `serve` re-serializes the same cached objects on every poll, so an
    // in-place edit would compound.
    const original = programme();
    const before = structuredClone(original);

    serializeProgramme(original, { indent: 2, profile: OUTPUT_PROFILES.tvheadend });

    expect(original).toEqual(before);
  });
});

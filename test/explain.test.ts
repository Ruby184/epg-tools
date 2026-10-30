import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { explanations, type Explainable } from '../src/cli/explain.js';
import type { EpgConfig } from '../src/config.js';
import { stamped, type EpgEventInput, type TimeSpent } from '../src/core/events.js';
import type { AnySiteConfig } from '../src/grabber/types.js';

/** What a run writes on stderr: every chunk, as it was written. */
class Sink extends Writable {
  readonly chunks: string[] = [];

  override _write(chunk: Buffer | string, _encoding: string, done: () => void): void {
    this.chunks.push(String(chunk));
    done();
  }

  get text(): string {
    return this.chunks.join('');
  }
}

const CONFIG: EpgConfig = { sites: [], output: 'guide.xml' };

/** A config naming one site, with what an explanation reads of it. */
function configWith(
  site: Partial<AnySiteConfig> & { site: string },
  more: Partial<EpgConfig> = {},
): EpgConfig {
  return {
    ...CONFIG,
    sites: [
      { channels: [], request: async () => ({}), parseDay: () => [], ...site } as AnySiteConfig,
    ],
    ...more,
  };
}

/** What the explanations `names` write, once a run has said `events`. */
async function written(
  names: Explainable[],
  events: EpgEventInput[],
  config: EpgConfig = CONFIG,
): Promise<string> {
  const { reporter, render } = explanations(names);
  const emit = stamped(reporter!);

  for (const event of events) {
    emit(event);
  }

  const out = new Sink();

  await render(out, config);

  return out.text;
}

/** One channel-day, fetched with `programmes` programmes. */
function fetched(site: string, channelId: string, day: string, programmes = 0): EpgEventInput {
  return { type: 'entry:fetched', site, channelId, day, programmes };
}

/** One channel-day, fresh in the cache. */
function cached(site: string, channelId: string, day: string): EpgEventInput {
  return { type: 'entry:cached', site, channelId, day };
}

/**
 * A site done in `ms`, with these requests — `[requests, requestMs, waitedMs,
 * failed]` by label — and its time as `spent` says, the rest of it other.
 */
function done(
  site: string,
  ms: number,
  requestsBy: Record<string, [number, number, number, Record<string, number>?]> = {},
  spent: Partial<Omit<TimeSpent, 'other'>> = {},
): EpgEventInput {
  const measured = { source: 0, held: 0, rateLimit: 0, working: 0, queued: 0, ...spent };
  const by = Object.entries(requestsBy).map(
    ([label, [requests, requestMs, waitedMs, failed = {}]]) => [
      label,
      { requests, requestMs, waitedMs, failed },
    ],
  );

  return {
    type: 'site:done',
    site,
    requests: Object.values(requestsBy).reduce((sum, [requests]) => sum + requests, 0),
    ms,
    requestMs: 0,
    requestsBy: Object.fromEntries(by),
    msBy: { ...measured, other: ms - Object.values(measured).reduce((sum, part) => sum + part, 0) },
    fetched: 0,
    empty: 0,
    fromCache: 0,
    unchanged: 0,
    failed: 0,
    sitesFailed: 0,
  };
}

/** A near miss on `channelId`: the programme that joined nothing, and the one nearest it. */
function nearMiss(
  channelId: string,
  why: Extract<EpgEventInput, { type: 'merge:unmatched' }>['why'],
  programme: [site: string, title: string, start: string],
  nearby: [site: string, title: string, start: string],
): EpgEventInput {
  const at = (start: string): number =>
    Date.UTC(
      +start.slice(0, 4),
      +start.slice(4, 6) - 1,
      +start.slice(6, 8),
      +start.slice(8, 10),
      +start.slice(10, 12),
    );

  return {
    type: 'merge:unmatched',
    channelId,
    shiftMs: at(programme[2]) - at(nearby[2]),
    why,
    programme: { site: programme[0], title: programme[1], start: `${programme[2]}00 +0000` },
    nearby: { site: nearby[0], title: nearby[1], start: `${nearby[2]}00 +0000` },
  };
}

describe('explanations', () => {
  it('hears nothing and writes nothing where none is asked for', async () => {
    const { reporter, render } = explanations([]);
    const out = new Sink();

    await render(out, CONFIG);

    expect(reporter).toBeUndefined();
    expect(out.text).toBe('');
  });

  it('writes each once, in the order asked for, a blank line between them', async () => {
    expect(await written(['held', 'empty', 'held'], [])).toBe(
      'No site was told to slow down.\n\nNo channel-day came back empty.\n',
    );
  });

  it('writes a long one a thousand lines at a time', async () => {
    const { reporter, render } = explanations(['unmatched']);
    const emit = stamped(reporter!);

    for (let n = 0; n < 2_500; n++) {
      emit(
        nearMiss(
          'one.tv',
          'start',
          ['b.tv', `Show ${n}`, '202610240607'],
          ['a.tv', `Show ${n}`, '202610240600'],
        ),
      );
    }

    const out = new Sink();

    await render(out, CONFIG);

    // Its heading, its one group, the blank line and the list's own heading,
    // then 2,500 lines — in three writes, and the empty one each waits on.
    const lines = out.chunks
      .filter((chunk) => chunk !== '')
      .map((chunk) => chunk.split('\n').length - 1);

    expect(lines).toEqual([1_000, 1_000, 505]);
    expect(out.text.split('\n')[2_504]).toContain('"Show 2499"');
  });

  it('says what an explanation throws, rather than ending it quietly', async () => {
    const { reporter, render } = explanations(['requests']);

    // A site:done from no run of this version, with no requestsBy to read.
    stamped(reporter!)({ type: 'site:done', site: 'a.tv', requests: 1, ms: 5 } as never);

    await expect(render(new Sink(), CONFIG)).rejects.toThrow(TypeError);
  });

  it('writes a batch the blank line between two filled, and every one after it', async () => {
    const { reporter, render } = explanations(['empty', 'unmatched']);
    const emit = stamped(reporter!);

    // A heading and 998 lines, so the blank line after them is the 1000th.
    emit(fetched('a.tv', 'busy.tv', '2026-10-24', 3));

    for (let n = 0; n < 998; n++) {
      emit(fetched('a.tv', `c${String(n).padStart(3, '0')}.tv`, '2026-10-24'));
    }

    for (let n = 0; n < 1_500; n++) {
      emit(
        nearMiss(
          'one.tv',
          'start',
          ['b.tv', 'Show', '202610240607'],
          ['a.tv', 'Show', '202610240600'],
        ),
      );
    }

    const out = new Sink();

    await render(out, CONFIG);

    const lines = out.chunks
      .filter((chunk) => chunk !== '')
      .map((chunk) => chunk.split('\n').length - 1);

    expect(lines.reduce((sum, n) => sum + n, 0)).toBe(999 + 1 + 1_505);
    expect(Math.max(...lines)).toBeLessThanOrEqual(1_001);
  });

  it('counts each hold once in each explanation that reads it', async () => {
    const events: EpgEventInput[] = [
      { type: 'pacing:held', site: 'a.tv', status: 429, ms: 1_000 },
      { type: 'pacing:held', site: 'a.tv', status: 429, ms: 1_000 },
      done('a.tv', 10_000, { request: [40, 1, 0] }, { source: 9_000 }),
    ];
    const text = await written(['requests', 'held'], events);

    expect(text).toContain('told to slow down twice');
    expect(text).toContain('  a.tv: held twice,');
    // Heard only where something reads it.
    expect(explanations(['unmatched']).reporter!.wants!('pacing:held')).toBe(false);
    expect(explanations(['requests']).reporter!.wants!('pacing:held')).toBe(true);
  });

  it('fails nothing for a stderr nothing reads any more', async () => {
    const gone = new Writable({
      write(_chunk, _encoding, callback) {
        callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      },
    });

    gone.on('error', () => {});

    const { reporter, render } = explanations(['empty']);

    stamped(reporter!)(fetched('a.tv', 'one.tv', '2026-10-24'));

    await expect(render(gone, CONFIG)).resolves.toBeUndefined();
  });
});

describe('the unmatched explanation', () => {
  it('groups them by channel, sources and why, says what would join them, then lists each', async () => {
    expect(
      await written(
        ['unmatched'],
        [
          nearMiss(
            'ct1.cz',
            'start',
            ['b.tv', 'Zprávy', '202610250607'],
            ['a.tv', 'Zprávy', '202610250600'],
          ),
          nearMiss(
            'ct1.cz',
            'start',
            ['b.tv', 'Zprávy', '202610250807'],
            ['a.tv', 'Zprávy', '202610250800'],
          ),
          nearMiss(
            'ct1.cz',
            'start',
            ['b.tv', 'Počasí', '202610251410'],
            ['a.tv', 'Počasí', '202610251400'],
          ),
          nearMiss(
            'dvtv.cz',
            'title',
            ['b.tv', 'DVTV: Jakub Kříž', '202610252002'],
            ['a.tv', 'DVTV', '202610252000'],
          ),
          nearMiss(
            'dvtv.cz',
            'title',
            ['b.tv', 'DVTV: Petra Nová', '202610252101'],
            ['a.tv', 'DVTV', '202610252100'],
          ),
          nearMiss(
            'dvtv.cz',
            'title',
            ['b.tv', 'DVTV: Ivan Hořejší', '202610252201'],
            ['a.tv', 'DVTV', '202610252200'],
          ),
          nearMiss(
            'dvtv.cz',
            'runs',
            ['b.tv', 'Clip', '202610252301'],
            ['a.tv', 'Clip', '202610252300'],
          ),
        ],
      ),
    ).toBe(
      '7 programmes nearly merged, on 2 channels:\n' +
        '  ct1.cz, b.tv against a.tv:\n' +
        '    3 × starts too far apart: b.tv starts 7 minutes later on 2 of them — ' +
        'a startToleranceMs of 600000 would bring them within reach (it is 300000), and join those whose shorter lasts longer than they are apart\n' +
        '  dvtv.cz, b.tv against a.tv:\n' +
        '    3 × titles differ: b.tv\'s titles go on past a.tv\'s after ": " on all 3, ' +
        'e.g. "DVTV: Jakub Kříž" / "DVTV" — a normalizeTitle that cuts them there would join them\n' +
        '    1 × they start further apart than the shorter lasts: programmes in a row, or one within the other — rightly kept apart\n' +
        '\n' +
        'Each of them:\n' +
        '  ct1.cz: 420s apart, starts too far apart — "Zprávy" (b.tv, 06:07) / "Zprávy" (a.tv, 06:00)\n' +
        '  ct1.cz: 420s apart, starts too far apart — "Zprávy" (b.tv, 08:07) / "Zprávy" (a.tv, 08:00)\n' +
        '  ct1.cz: 10m00s apart, starts too far apart — "Počasí" (b.tv, 14:10) / "Počasí" (a.tv, 14:00)\n' +
        '  dvtv.cz: 120s apart, titles differ — "DVTV: Jakub Kříž" (b.tv, 20:02) / "DVTV" (a.tv, 20:00)\n' +
        '  dvtv.cz: 60s apart, titles differ — "DVTV: Petra Nová" (b.tv, 21:01) / "DVTV" (a.tv, 21:00)\n' +
        '  dvtv.cz: 60s apart, titles differ — "DVTV: Ivan Hořejší" (b.tv, 22:01) / "DVTV" (a.tv, 22:00)\n' +
        '  dvtv.cz: 60s apart, they start further apart than the shorter lasts — "Clip" (b.tv, 23:01) / "Clip" (a.tv, 23:00)\n',
    );
  });

  it('says which source runs behind, earlier as well as later, and on both of two', async () => {
    const text = await written(
      ['unmatched'],
      [
        nearMiss(
          'one.tv',
          'start',
          ['b.tv', 'News', '202610250553'],
          ['a.tv', 'News', '202610250600'],
        ),
        nearMiss(
          'one.tv',
          'start',
          ['b.tv', 'News', '202610250753'],
          ['a.tv', 'News', '202610250800'],
        ),
      ],
    );

    expect(text).toContain('b.tv starts 7 minutes earlier on both —');
    expect(text).toContain('a startToleranceMs of 420000 would bring them within reach');
  });

  it('takes two sources for one pair, whichever of them joined nothing', async () => {
    const text = await written(
      ['unmatched'],
      [
        nearMiss(
          'one.tv',
          'start',
          ['b.tv', 'News', '202610250607'],
          ['a.tv', 'News', '202610250600'],
        ),
        nearMiss(
          'one.tv',
          'start',
          ['b.tv', 'News', '202610250807'],
          ['a.tv', 'News', '202610250800'],
        ),
        // B's held over from the day before, met by A's first list.
        nearMiss(
          'one.tv',
          'start',
          ['a.tv', 'News', '202610250553'],
          ['b.tv', 'News', '202610250600'],
        ),
      ],
    );

    expect(text).toContain(
      '  one.tv, b.tv against a.tv:\n    3 × starts too far apart: b.tv starts 7 minutes later on all 3 —',
    );
    expect(text).not.toContain('a.tv against b.tv');
  });

  it('says no shift where the pairs do not agree on one, and the tolerance a config set', async () => {
    const text = await written(
      ['unmatched'],
      [
        nearMiss(
          'one.tv',
          'start',
          ['b.tv', 'News', '202610250603'],
          ['a.tv', 'News', '202610250600'],
        ),
        nearMiss(
          'one.tv',
          'start',
          ['b.tv', 'News', '202610250809'],
          ['a.tv', 'News', '202610250800'],
        ),
      ],
      { ...CONFIG, merge: { match: { startToleranceMs: 120_000 } } },
    );

    expect(text).toContain(
      '2 × starts too far apart: a startToleranceMs of 540000 would bring them within reach (it is 120000), and join those whose shorter lasts longer than they are apart',
    );
  });

  it('rounds the tolerance it suggests up to the minute, so it reaches the widest', async () => {
    const event = nearMiss(
      'one.tv',
      'start',
      ['b.tv', 'News', '202610250607'],
      ['a.tv', 'News', '202610250600'],
    );

    // Seven minutes and twenty seconds: eight reach it, seven do not.
    const text = await written(['unmatched'], [{ ...event, shiftMs: 440_000 } as EpgEventInput]);

    expect(text).toContain('a startToleranceMs of 480000 would bring it within reach');
  });

  it('suggests a window to a matcher that has one, and the tolerance a shipped match was given', async () => {
    const pair = nearMiss(
      'one.tv',
      'start',
      ['b.tv', 'News', '202610250607'],
      ['a.tv', 'News', '202610250600'],
    );
    const windowed = await written(['unmatched'], [pair], {
      ...CONFIG,
      merge: { match: { windowMs: 120_000, matches: () => false } },
    });
    const shipped = await written(['unmatched'], [pair], {
      ...CONFIG,
      merge: { match: { titles: 'always' } },
    });

    expect(windowed).toContain(
      '— a windowMs of 420000 would let its match be asked about it (it is 120000)\n',
    );
    expect(windowed).not.toContain('startToleranceMs');
    expect(shipped).toContain(
      'a startToleranceMs of 420000 would bring it within reach (it is 300000)',
    );
  });

  it('suggests no tolerance where the config matches programmes its own way', async () => {
    const text = await written(
      ['unmatched'],
      [
        nearMiss(
          'one.tv',
          'start',
          ['b.tv', 'News', '202610250607'],
          ['a.tv', 'News', '202610250600'],
        ),
      ],
      { ...CONFIG, merge: { match: () => false } },
    );

    // Of one pair, said of it — and no tolerance, which is the config's own.
    expect(text).toContain('    1 × starts too far apart: b.tv starts 7 minutes later\n');
  });

  it('says where one source’s titles begin with more, whichever side', async () => {
    const text = await written(
      ['unmatched'],
      [
        nearMiss(
          'films.tv',
          'title',
          ['b.tv', 'Titanic', '202610252000'],
          ['a.tv', 'Film - Titanic', '202610252001'],
        ),
        nearMiss(
          'films.tv',
          'title',
          ['b.tv', 'Ghost', '202610252200'],
          ['a.tv', 'Film - Ghost', '202610252201'],
        ),
      ],
    );

    expect(text).toContain(
      'a.tv\'s titles begin with more, before " - " on both, e.g. "Titanic" / "Film - Titanic" — ' +
        'a normalizeTitle that keeps what follows it would join them',
    );
  });

  it('compares titles as the merge does: by the config’s normalizeTitle, accents aside', async () => {
    const accents = await written(
      ['unmatched'],
      [
        nearMiss(
          'one.tv',
          'title',
          ['b.tv', 'Večerníček: Krtko', '202610251900'],
          ['a.tv', 'Vecernicek', '202610251901'],
        ),
      ],
    );
    const own = await written(
      ['unmatched'],
      [
        nearMiss(
          'two.tv',
          'title',
          ['b.tv', 'Zprávy: Večer', '202610251900'],
          ['a.tv', 'News', '202610251901'],
        ),
      ],
      {
        ...CONFIG,
        merge: {
          match: { normalizeTitle: (title) => title.replace(/^Zprávy/, 'News').toLowerCase() },
        },
      },
    );

    expect(accents).toContain('b.tv\'s titles go on past a.tv\'s after ": "');
    expect(own).toContain('b.tv\'s titles go on past a.tv\'s after ": "');
  });

  it('suggests no title rule that only half a group bears out, nor one from an empty title', async () => {
    const text = await written(
      ['unmatched'],
      [
        nearMiss(
          'one.tv',
          'title',
          ['b.tv', 'DVTV: Jakub Kříž', '202610252002'],
          ['a.tv', 'DVTV', '202610252000'],
        ),
        nearMiss(
          'one.tv',
          'title',
          ['b.tv', 'News', '202610252101'],
          ['a.tv', 'Weather', '202610252100'],
        ),
        nearMiss(
          'two.tv',
          'title',
          ['b.tv', '', '202610252001'],
          ['a.tv', ': Show', '202610252000'],
        ),
      ],
    );

    expect(text).toContain('    2 × titles differ, e.g. "DVTV: Jakub Kříž" / "DVTV"\n');
    expect(text).toContain('    1 × titles differ, e.g. "" / ": Show"\n');
    expect(text).not.toContain('normalizeTitle');
  });

  it('gives an example only, where titles differ otherwise, or the config said no', async () => {
    const text = await written(
      ['unmatched'],
      [
        nearMiss(
          'one.tv',
          'title',
          ['b.tv', 'News', '202610250601'],
          ['a.tv', 'Weather', '202610250600'],
        ),
        nearMiss(
          'two.tv',
          'matcher',
          ['b.tv', 'Film', '202610250601'],
          ['a.tv', 'Film', '202610250600'],
        ),
        nearMiss(
          'three.tv',
          'both',
          ['b.tv', 'Talk', '202610250620'],
          ['a.tv', 'Chat', '202610250600'],
        ),
      ],
    );

    expect(text).toContain('    1 × titles differ, e.g. "News" / "Weather"\n');
    expect(text).toContain('    1 × the config\'s match said no, e.g. "Film" / "Film"\n');
    expect(text).toContain('    1 × titles and starts differ, e.g. "Talk" / "Chat"\n');
  });

  it('says a merge whose channels are kept apart has none to look for', async () => {
    expect(
      await written(['unmatched'], [], { ...CONFIG, merge: { channelStrategy: 'keep-all' } }),
    ).toBe(
      "Near misses are looked for only under channelStrategy 'merge-programmes' and " +
        "programmeStrategy 'merge', and this merge is under channelStrategy: 'keep-all'.\n",
    );
  });

  it('says where none nearly merged', async () => {
    expect(await written(['unmatched'], [])).toBe('No programmes nearly merged.\n');
  });
});

describe('the empty explanation', () => {
  it('reads each empty channel-day from what the run’s other answers say', async () => {
    const days = ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29'];
    const events: EpgEventInput[] = [];

    // sky.sk has programmes up to the 28th, and nothing after it on any channel.
    for (const channel of ['joj.sk', 'ta3.sk']) {
      for (const day of days) {
        events.push(fetched('sky.sk', channel, day, day < '2026-10-29' ? 20 : 0));
      }
    }

    events.push(
      // magio.tv has none for joj.sk on days sky.sk does.
      fetched('magio.tv', 'joj.sk', '2026-10-25'),
      fetched('magio.tv', 'joj.sk', '2026-10-26'),
      // Nor for dvojka.sk on one day it has the rest of its channels for.
      fetched('magio.tv', 'dvojka.sk', '2026-10-25', 30),
      fetched('magio.tv', 'dvojka.sk', '2026-10-27'),
      fetched('magio.tv', 'joj.sk', '2026-10-27', 12),
      // Nor for one it and sky.sk carry, on a day both are empty.
      fetched('magio.tv', 'markiza.sk', '2026-10-26'),
      fetched('sky.sk', 'markiza.sk', '2026-10-26'),
      // And nothing at all from a source whose parse has broken.
      fetched('broken.tv', 'one.tv', '2026-10-25'),
      fetched('broken.tv', 'two.tv', '2026-10-25'),
    );

    expect(await written(['empty'], events)).toBe(
      '9 channel-days came back empty:\n' +
        '  broken.tv: every channel-day it was asked about came back empty — 2 channel-days on 2 channels: ' +
        'its parseDay may no longer read what the source sends, or the source has nothing\n' +
        '  sky.sk: nothing after 2026-10-28 on any channel — it has not published that far yet: ' +
        '2026-10-29, on 2 channels\n' +
        '  dvojka.sk (magio.tv): 2026-10-27 — magio.tv has programmes on other channels then: ' +
        'a gap in its listings, or off air\n' +
        '  joj.sk (magio.tv): 2026-10-25..2026-10-26 (2 days) — sky.sk has programmes then: ' +
        'magio.tv may know it by another id, or have stopped carrying it\n' +
        '  markiza.sk (magio.tv): 2026-10-26 — every source asked about it came back empty then: off air, or not published yet\n' +
        '  markiza.sk (sky.sk): 2026-10-26 — every source asked about it came back empty then: off air, or not published yet\n',
    );
  });

  it('claims nothing a channel-day served from the cache could make untrue', async () => {
    const text = await written(
      ['empty'],
      [
        fetched('a.tv', 'one.tv', '2026-10-25', 10),
        // Cached for the 26th, so a.tv may well have published that far.
        cached('a.tv', 'two.tv', '2026-10-26'),
        fetched('a.tv', 'one.tv', '2026-10-26'),
        // b.tv's 25th cached: whether it has programmes then is not known —
        // so c.tv's being empty too is not every source's.
        cached('b.tv', 'three.tv', '2026-10-25'),
        fetched('c.tv', 'three.tv', '2026-10-25'),
        fetched('c.tv', 'four.tv', '2026-10-25', 5),
        fetched('a.tv', 'three.tv', '2026-10-25'),
      ],
    );

    expect(text).not.toContain('published that far');
    expect(text).not.toContain('every source');
    expect(text).toContain(
      "  one.tv (a.tv): 2026-10-26 — nothing else says otherwise: off air, or a gap in a.tv's listings\n",
    );
    expect(text).toContain(
      '  three.tv (a.tv): 2026-10-25 — a.tv has programmes on other channels then: a gap in its listings, or off air\n',
    );
  });

  it('takes a day the source said unchanged, or that failed, as one it may have programmes on', async () => {
    const text = await written(
      ['empty'],
      [
        // Unchanged everywhere but one day: not a parse that has broken.
        { type: 'entry:unchanged', site: 'a.tv', channelId: 'one.tv', day: '2026-10-25' },
        { type: 'entry:unchanged', site: 'a.tv', channelId: 'one.tv', day: '2026-10-27' },
        fetched('a.tv', 'one.tv', '2026-10-26'),
        // Empty at b.tv and g.tv, failed at c.tv and in a request of d.tv's: not
        // every source's.
        fetched('b.tv', 'two.tv', '2026-10-26'),
        fetched('b.tv', 'three.tv', '2026-10-26', 4),
        fetched('g.tv', 'two.tv', '2026-10-26'),
        fetched('g.tv', 'three.tv', '2026-10-26', 4),
        {
          type: 'entry:failed',
          site: 'c.tv',
          channelId: 'two.tv',
          day: '2026-10-26',
          error: new Error('no'),
        },
        fetched('e.tv', 'four.tv', '2026-10-26'),
        fetched('e.tv', 'five.tv', '2026-10-26', 4),
        fetched('f.tv', 'four.tv', '2026-10-26'),
        fetched('f.tv', 'five.tv', '2026-10-26', 4),
        {
          type: 'request:failed',
          site: 'd.tv',
          channels: ['four.tv', 'six.tv'],
          days: ['2026-10-25', '2026-10-26'],
          entries: 4,
          error: new Error('no'),
        },
      ],
    );

    expect(text).not.toContain('every channel-day it was asked about');
    expect(text).not.toContain('every source');
    expect(text).toContain(
      "  one.tv (a.tv): 2026-10-26 — nothing else says otherwise: off air, or a gap in a.tv's listings\n",
    );
  });

  it('says every source asked that answered, where one failed whole and said nothing of the day', async () => {
    const text = await written(
      ['empty'],
      [
        fetched('a.tv', 'one.tv', '2026-10-26'),
        fetched('a.tv', 'two.tv', '2026-10-26', 3),
        fetched('b.tv', 'one.tv', '2026-10-26'),
        fetched('b.tv', 'two.tv', '2026-10-26', 3),
        { type: 'site:failed', site: 'c.tv', error: new Error('no channel list') },
        // Failed too, though only once it had answered the day — empty.
        fetched('d.tv', 'one.tv', '2026-10-26'),
        fetched('d.tv', 'two.tv', '2026-10-26', 3),
        { type: 'site:failed', site: 'd.tv', error: new Error('its thread went') },
      ],
    );

    expect(text).toContain(
      '  one.tv (a.tv): 2026-10-26 — every source asked about it that answered came back empty then, ' +
        'though c.tv failed and may have it: off air, or not published yet\n',
    );
  });

  it('leaves out a day a second emission filled, as a run counts it', async () => {
    const appended = (channelId: string, total: number): EpgEventInput => ({
      type: 'entry:appended',
      site: 'a.tv',
      channelId,
      day: '2026-10-24',
      added: total,
      total,
    });

    const text = await written(
      ['empty'],
      [
        fetched('a.tv', 'one.tv', '2026-10-24'),
        fetched('a.tv', 'two.tv', '2026-10-24'),
        fetched('a.tv', 'three.tv', '2026-10-24'),
        appended('one.tv', 2),
        appended('two.tv', 0),
      ],
    );

    expect(text).toMatch(/^2 channel-days came back empty:\n/);
    expect(text).not.toContain('one.tv');
    expect(text).toContain('  three.tv (a.tv): 2026-10-24 —');
    expect(text).toContain('  two.tv (a.tv): 2026-10-24 —');
  });

  it('says a source has programmes on other channels only where it has them every day of the run', async () => {
    const text = await written(
      ['empty'],
      [
        fetched('a.tv', 'one.tv', '2026-10-26'),
        fetched('a.tv', 'one.tv', '2026-10-27'),
        fetched('a.tv', 'two.tv', '2026-10-27', 5),
      ],
    );

    expect(text).toContain(
      "  one.tv (a.tv): 2026-10-26..2026-10-27 (2 days) — nothing else says otherwise: off air, or a gap in a.tv's listings\n",
    );
  });

  it('runs days on across the end of a month', async () => {
    const text = await written(
      ['empty'],
      [
        fetched('a.tv', 'two.tv', '2026-11-01', 5),
        fetched('a.tv', 'one.tv', '2026-10-31'),
        fetched('a.tv', 'one.tv', '2026-11-01'),
      ],
    );

    expect(text).toContain('  one.tv (a.tv): 2026-10-31..2026-11-01 (2 days) —');
  });

  it('says where none came back empty', async () => {
    expect(await written(['empty'], [fetched('a.tv', 'one.tv', '2026-10-24', 3)])).toBe(
      'No channel-day came back empty.\n',
    );
  });
});

describe('the requests explanation', () => {
  it('tables each site’s requests, then says where its time went, and why', async () => {
    expect(
      await written(
        ['requests'],
        [
          done(
            'sky.sk',
            697_000,
            {
              request: [49, 7_310, 2_100],
              detail: [5_242, 577_400, 44_000, { 404: 3_242, timeout: 3 }],
            },
            { source: 560_000, held: 90_000, rateLimit: 22_000, working: 15_000 },
          ),
          done('cached.tv', 412),
          done(
            'magio.tv',
            170_412,
            { request: [2, 939, 0] },
            { source: 939, working: 1_204, queued: 168_100 },
          ),
        ],
        configWith({ site: 'sky.sk', concurrency: 4 }),
      ),
    ).toBe(
      'Requests, by site and what each was for:\n' +
        '  site      label    requests  waiting  in queue  failed\n' +
        '  magio.tv  request         2    939ms       0ms\n' +
        '  sky.sk    request        49   7310ms    2100ms\n' +
        '  sky.sk    detail       5242     577s       44s  3242 × 404 and 3 × timeout\n' +
        '  None from cached.tv.\n' +
        '\n' +
        "Where each site's time went:\n" +
        '  cached.tv took 412ms: 412ms on other things.\n' +
        '  magio.tv took 170s: 168s waiting for a local slot, 1204ms parsing and writing, ' +
        '939ms on the source, 169ms on other things.\n' +
        "    Mostly waiting for one of the run's 16 local slots, which other sites' work held: " +
        'a higher localConcurrency, or --threads, lets it in sooner.\n' +
        '  sky.sk took 11m37s: 560s on the source, 90s held by the source, 22s under its own rateLimit, ' +
        '15s parsing and writing, 10s on other things.\n' +
        '    Mostly waiting on the source, 4 requests at a time: the source is the slow part.\n' +
        '    3242 of its 5242 detail requests were answered 404: the source has nothing at those ' +
        'addresses — ids it no longer knows, or details of programmes it has dropped.\n' +
        "    3 of its 5242 detail requests took longer than the site's timeout.\n",
    );
  });

  it('reads whichever part is most of a site’s time', async () => {
    const mostly = async (
      spent: Partial<Omit<TimeSpent, 'other'>>,
      config: EpgConfig = CONFIG,
    ): Promise<string> =>
      (await written(['requests'], [done('a.tv', 10_000, { request: [40, 1, 0] }, spent)], config))
        .split('\n')
        .find((line) => line.startsWith('    Mostly'))!
        .trim();

    expect(await mostly({ source: 9_000 })).toBe(
      'Mostly waiting on the source, one request at a time: a concurrency above 1 would overlap them, where the source allows it.',
    );
    // Nothing to overlap.
    expect(
      (
        await written(
          ['requests'],
          [done('a.tv', 10_000, { request: [1, 1, 0] }, { source: 9_000 })],
        )
      )
        .split('\n')
        .find((line) => line.startsWith('    Mostly'))!
        .trim(),
    ).toBe('Mostly waiting on the source, for its one request: the source is the slow part.');
    expect(await mostly({ held: 9_000 })).toBe(
      'Mostly held by the source: it is asked faster than it allows — see --explain held.',
    );
    expect(await mostly({ rateLimit: 9_000 })).toBe(
      'Mostly under its own rateLimit: the source may allow more.',
    );
    expect(
      await mostly(
        { rateLimit: 9_000 },
        configWith({ site: 'a.tv', rateLimit: { requests: 2, perMs: 1000 } }),
      ),
    ).toBe('Mostly under its own rateLimit of 2 per 1000ms: the source may allow more.');
    expect(await mostly({ working: 9_000 })).toBe(
      'Mostly its own parsing and writing: a parse, or a cache, that is slow — with --threads, only the sites that share its thread wait on it.',
    );
    expect(await mostly({ working: 9_000 }, { ...CONFIG, threads: true })).toBe(
      'Mostly its own parsing and writing: a parse, or a cache, that is slow.',
    );
    expect(await mostly({ queued: 9_000 }, { ...CONFIG, threads: 2, localConcurrency: 4 })).toBe(
      "Mostly waiting for a local slot — one of its thread's 4, or one of the run's thread's 4, where its cache is read and written — which other work held: a higher localConcurrency lets it in sooner.",
    );
    expect(await mostly({})).toBe(
      'Mostly none of these: its own code between requests, or reading what it remembered.',
    );
  });

  it('says the pace a site kept on the source, where its slow-downs took it below its own', async () => {
    const config = configWith({ site: 'a.tv', concurrency: 8 });
    const said = async (events: EpgEventInput[]): Promise<string> =>
      (await written(['requests'], events, config))
        .split('\n')
        .find((line) => line.startsWith('    Mostly'))!
        .trim();
    const site = done('a.tv', 10_000, { request: [40, 1, 0] }, { source: 9_000 });

    expect(
      await said([
        { type: 'pacing:slowed', site: 'a.tv', concurrency: 1 },
        // Given some back, and slowed again — not as far.
        { type: 'pacing:slowed', site: 'a.tv', concurrency: 2 },
        { type: 'pacing:slowed', site: 'b.tv', concurrency: 1 },
        site,
      ]),
    ).toBe(
      "Mostly waiting on the source, its concurrency of 8 taken as low as 1 by the source's slow-downs — see --explain held.",
    );
    expect(await said([site])).toBe(
      'Mostly waiting on the source, 8 requests at a time: the source is the slow part.',
    );
  });

  it('advises no more requests at once to a site the source held, one at a time', async () => {
    const said = async (events: EpgEventInput[], config: EpgConfig = CONFIG): Promise<string> =>
      (await written(['requests'], events, config))
        .split('\n')
        .find((line) => line.startsWith('    Mostly'))!
        .trim();
    const site = done('a.tv', 10_000, { request: [40, 1, 0] }, { source: 9_000 });

    expect(
      await said([
        { type: 'pacing:held', site: 'a.tv', status: 429, ms: 1_000 },
        { type: 'pacing:held', site: 'a.tv', status: 429, ms: 1_000 },
        site,
      ]),
    ).toBe(
      'Mostly waiting on the source, one request at a time, and told to slow down twice: ' +
        'it would take no more — see --explain held.',
    );
    // Its local slots as the run takes them: at least one.
    expect(
      await said([done('a.tv', 10_000, { request: [1, 1, 0] }, { queued: 9_000 })], {
        ...CONFIG,
        localConcurrency: 0,
      }),
    ).toContain("one of the run's 1 local slots");
  });

  it('reads nothing into a short site, or one no part is most of', async () => {
    const text = await written(
      ['requests'],
      [
        done('quick.tv', 900, { request: [1, 1, 0] }, { source: 800 }),
        done(
          'even.tv',
          10_000,
          { request: [1, 1, 0] },
          { source: 4_000, working: 3_000, queued: 3_000 },
        ),
      ],
    );

    expect(text).not.toContain('Mostly');
  });

  it('says what each way a request failed most likely means', async () => {
    const text = await written(
      ['requests'],
      [
        done('a.tv', 100, {
          request: [9, 1, 0, { 403: 1, 410: 1, 429: 1, 502: 1, 418: 1, network: 1, error: 1 }],
        }),
      ],
    );

    expect(text).toContain(
      '    1 of its 9 request requests were refused (403): credentials, or a block.\n',
    );
    expect(text).toContain(
      '    1 of its 9 request requests were answered 410: the source has nothing at those addresses',
    );
    expect(text).toContain(
      '    1 of its 9 request requests were told to slow down (429) — see --explain held.\n',
    );

    // Its backoff off, it was held for neither: a 503 is the source failing.
    const off = await written(
      ['requests'],
      [done('b.tv', 100, { request: [4, 1, 0, { 429: 1, 503: 1 }] })],
      configWith({ site: 'b.tv', backoff: false }),
    );

    expect(off).toContain(
      '    1 of its 4 request requests were told to slow down (429), which its backoff does not ' +
        'hold for: backoff, or a rateLimit, would pace it.\n',
    );
    expect(off).toContain('    1 of its 4 request requests failed at the source (503).\n');
    expect(text).toContain('    1 of its 9 request requests failed at the source (502).\n');
    expect(text).toContain(
      '    1 of its 9 request requests were answered 418: the source would not give what was asked.\n',
    );
    expect(text).toContain(
      '    1 of its 9 request requests were answered by nothing: the source down, or out of reach.\n',
    );
    expect(text).toContain(
      "    1 of its 9 request requests threw something that was not the source's answer: the site's own code.\n",
    );
  });

  it('says where no site was run, or none sent a request', async () => {
    expect(await written(['requests'], [])).toBe('No site was run.\n');
    expect(await written(['requests'], [done('a.tv', 5)])).toBe(
      "No site sent a request.\n\nWhere each site's time went:\n  a.tv took 5ms: 5ms on other things.\n",
    );
  });
});

describe('the held explanation', () => {
  it('says how often each site was held, with what, how it was let go, and the pace that earned it', async () => {
    expect(
      await written(
        ['held'],
        [
          { type: 'pacing:slowed', site: 'b.tv', concurrency: 1 },
          { type: 'pacing:held', site: 'b.tv', status: 429, ms: 30_000, retryAfterMs: 30_000 },
          { type: 'pacing:recovered', site: 'b.tv', concurrency: 2 },
          { type: 'pacing:recovered', site: 'b.tv', concurrency: 3 },
          { type: 'pacing:slowed', site: 'b.tv', concurrency: 2 },
          { type: 'pacing:held', site: 'b.tv', status: 429, ms: 60_000, retryAfterMs: 120_000 },
          { type: 'pacing:held', site: 'b.tv', status: 503, ms: 5_000 },
          { type: 'pacing:recovered', site: 'b.tv', concurrency: 3 },
          // Its requests out for 560s of its 11m37s: the rest, other work.
          done('b.tv', 697_000, { request: [5_291, 1, 0] }, { source: 560_000, queued: 120_000 }),
          { type: 'pacing:held', site: 'a.tv', status: 418, ms: 5_000, retryAfterMs: 5_000 },
          { type: 'pacing:held', site: 'c.tv', status: 503, ms: 1_000 },
          { type: 'pacing:slowed', site: 'c.tv', concurrency: 1 },
          done('c.tv', 4_000, { request: [10, 1, 0] }, { source: 2_000 }),
        ],
        configWith({ site: 'c.tv', rateLimit: { requests: 5, perMs: 1000 } }),
      ),
    ).toBe(
      '3 sites told to slow down:\n' +
        '  a.tv: held once, for 5000ms\n' +
        '    1 × 418: a status its backoff.statuses lists\n' +
        '    As long as the source asked, each time.\n' +
        '  b.tv: held 3 times, for up to 60s at a time; concurrency down to 1, back up to 3\n' +
        "    2 × 429: too many requests — the source's rate limit\n" +
        '    1 × 503: unavailable — overloaded, or a limit it does not name\n' +
        '    As long as the source asked, once.\n' +
        '    Cut short by backoff.maxMs once, where the source asked for up to 120s: ' +
        'let go sooner than it wanted, the site is likely to be held again.\n' +
        '    For the fallback once — backoff.fallbackMs, at most backoff.maxMs — the source saying nothing of how long.\n' +
        '    It sent 5291 requests, 9.4 a second over the 560s it had any out unheld, with no rateLimit: ' +
        'a rateLimit below that pace would keep it from being held, at the cost of the time that takes.\n' +
        '  c.tv: held once, for 1000ms; concurrency down to 1\n' +
        '    1 × 503: unavailable — overloaded, or a limit it does not name\n' +
        '    For the fallback once — backoff.fallbackMs, at most backoff.maxMs — the source saying nothing of how long.\n' +
        '    It sent 10 requests, 5.0 a second over the 2000ms it had any out unheld, under a rateLimit of 5 per 1000ms: ' +
        'the source allows less than that.\n',
    );
  });

  it('counts a hold made longer as one hold, and each time it was told as one', async () => {
    const text = await written(
      ['held'],
      [
        { type: 'pacing:held', site: 'a.tv', status: 429, ms: 5_000, retryAfterMs: 5_000 },
        // Two more answers while it held, asking longer: still one hold.
        {
          type: 'pacing:held',
          site: 'a.tv',
          status: 429,
          ms: 20_000,
          retryAfterMs: 20_000,
          lengthened: true,
        },
        { type: 'pacing:held', site: 'a.tv', status: 503, ms: 8_000, lengthened: true },
        { type: 'pacing:held', site: 'b.tv', status: 429, ms: 1_000, retryAfterMs: 1_000 },
        {
          type: 'pacing:held',
          site: 'b.tv',
          status: 429,
          ms: 2_000,
          retryAfterMs: 2_000,
          lengthened: true,
        },
        { type: 'pacing:held', site: 'b.tv', status: 429, ms: 1_000, retryAfterMs: 1_000 },
      ],
    );

    expect(text).toBe(
      '2 sites told to slow down:\n' +
        '  a.tv: held once, made longer twice while it held — for up to 20s each time it was told\n' +
        "    2 × 429: too many requests — the source's rate limit\n" +
        '    1 × 503: unavailable — overloaded, or a limit it does not name\n' +
        '    As long as the source asked, twice.\n' +
        '    For the fallback once — backoff.fallbackMs, at most backoff.maxMs — the source saying nothing of how long.\n' +
        '  b.tv: held twice, made longer once while it held — for up to 2000ms each time it was told\n' +
        "    3 × 429: too many requests — the source's rate limit\n" +
        '    As long as the source asked, each time.\n',
    );
  });

  it('rounds a pace of ten or more a second to the whole', async () => {
    const text = await written(
      ['held'],
      [
        { type: 'pacing:held', site: 'a.tv', status: 429, ms: 1_000 },
        { type: 'pacing:held', site: 'a.tv', status: 429, ms: 1_000 },
        { type: 'pacing:held', site: 'a.tv', status: 429, ms: 1_000 },
        done('a.tv', 1_000, { request: [124, 1, 0] }, { source: 1_000 }),
      ],
    );

    expect(text).toContain('    For the fallback 3 times —');
    expect(text).toContain(
      'It sent 124 requests, 124 a second over the 1000ms it had any out unheld',
    );
  });
});

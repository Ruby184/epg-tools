import { parseXmltvDate, writeXmltvStream } from '../src/xmltv/main.js';
import type { XmltvChannel, XmltvProgramme } from '../src/xmltv/types.js';

export interface Guide {
  channels: XmltvChannel[];
  programmes: XmltvProgramme[];
}

const DAY_MS = 86_400_000;
const BASE = Date.UTC(2026, 6, 17);

/**
 * Deterministic synthetic guide with realistic field density — every DTD
 * element populated on every programme (credits, video/audio, ratings,
 * subtitles, previously-shown, extensions, ...), matching the richness of
 * a real multi-source feed rather than just the common subset. Comparable
 * in density to the example in epg-parser's own README.
 */
export function makeGuide(channelCount: number, days: number, programmesPerDay: number): Guide {
  const channels: XmltvChannel[] = [];
  const programmes: XmltvProgramme[] = [];

  for (let c = 0; c < channelCount; c++) {
    const id = `channel-${c}.example.tv`;

    channels.push({
      id,
      displayName: [
        { value: `Channel ${c}`, lang: 'en' },
        { value: `Kanál ${c}`, lang: 'sk' },
      ],
      icon: [{ src: `https://example.tv/logo-${c}.png`, width: 120, height: 60 }],
      url: [
        `https://example.tv/${c}`,
        { value: `https://example.tv/${c}/alt`, system: 'alternate' },
      ],
      extra: [{ name: 'lcn', value: String(100 + c) }],
    });

    for (let d = 0; d < days; d++) {
      const duration = DAY_MS / programmesPerDay;

      for (let p = 0; p < programmesPerDay; p++) {
        const start = BASE + d * DAY_MS + p * duration;
        const tag = `${c}-${d}-${p}`;

        const programme: XmltvProgramme = {
          channel: id,
          start: new Date(start),
          stop: new Date(start + duration),
          title: [
            { value: `Programme ${tag}`, lang: 'en' },
            { value: `Relácia ${tag}`, lang: 'sk' },
          ],
          subTitle: [{ value: `Episode ${p}`, lang: 'en' }],
          desc: [{
            value: `Description of programme ${p} on channel ${c}, day ${d}. Contains some & special <characters> that need escaping.`,
            lang: 'en',
          }],
          date: parseXmltvDate('2026'),
          category: [
            { value: 'News', lang: 'en' },
            { value: 'Správy', lang: 'sk' },
          ],
          keyword: [{ value: 'live' }, { value: `tag-${p % 5}` }],
          language: { value: 'English', lang: 'en' },
          origLanguage: { value: 'Slovak', lang: 'sk' },
          length: { units: 'minutes', value: duration / 60_000 },
          icon: [{ src: `https://example.tv/prog-${c}-${p}.jpg` }],
          url: [
            `https://example.tv/programme/${tag}`,
            { value: `https://imdb.example/${tag}`, system: 'imdb' },
          ],
          country: [{ value: 'SK' }],
          episodeNum: [
            { system: 'xmltv_ns', value: `${d}.${p}.0/1` },
            { system: 'onscreen', value: `S${d + 1}E${p + 1}` },
          ],
          video: { present: true, colour: true, aspect: '16:9', quality: 'HDTV' },
          audio: { present: true, stereo: p % 2 === 0 ? 'stereo' : 'dolby digital' },
          credits: {
            director: [`Director ${c}`],
            actor: [
              { value: `Actor ${tag} A`, role: 'Lead' },
              { value: `Actor ${tag} B`, role: 'Supporting', guest: p % 6 === 0 },
            ],
            producer: [`Producer ${c}`],
          },
          subtitles: [
            { type: 'teletext', language: { value: 'English', lang: 'en' } },
            { type: 'onscreen' },
          ],
          rating: [{ system: 'VCHIP', value: 'TV-PG' }],
          starRating: [{ system: 'imdb', value: '7.5/10' }],
          review: [{ type: 'text', source: 'Critic Weekly', value: 'A solid watch.' }],
          image: [{ type: 'poster', size: '3', orient: 'P', value: `https://example.tv/poster-${tag}.jpg` }],
        };

        if (p % 4 === 0) {
          programme.previouslyShown = { start: new Date(start - 7 * DAY_MS), channel: id };
        }

        if (p % 6 === 0) {
          programme.premiere = { value: 'First showing', lang: 'en' };
        }

        if (p % 8 === 0) {
          programme.lastChance = true;
        }

        if (p % 7 === 0) {
          programme.new = true;
        }

        if (p % 10 === 0) {
          programme.extraAttributes = { uniqueID: `ev-${tag}` };
          programme.extra = [{ name: 'crid', value: `crid://example.tv/${tag}` }];
        }

        programmes.push(programme);
      }
    }
  }

  return { channels, programmes };
}

export async function guideToXml(guide: Guide): Promise<string> {
  let xml = '';

  for await (const chunk of writeXmltvStream({
    meta: { generatorInfoName: 'epg-tools-bench' },
    channels: guide.channels,
    programmes: guide.programmes,
  })) {
    xml += chunk;
  }

  return xml;
}

export function* rechunk(document: string, size: number): Generator<string> {
  for (let i = 0; i < document.length; i += size) {
    yield document.slice(i, i + size);
  }
}

/**
 * What `--channels` was given, as a set of ids.
 *
 * A path or a list, and for a path any of the four things somebody might
 * reasonably have lying around: a playlist, a `*.channels.xml`, a guide, or a
 * plain list of ids. Which of those it is comes from the content, as everywhere
 * else here — all four get renamed, and `.xml` alone does not say whether it is
 * a channel list or a guide.
 */

import { parseXmltvStream } from '../xmltv/parse.js';
import { isGuide, looksLikePath, sniff } from './sniff.js';
import { wantedFrom } from './channels.js';

/** The channel ids `--channels` asks for. */
export async function wantedIds(value: string): Promise<Set<string>> {
  if (!looksLikePath(value)) {
    return new Set(
      value
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id !== ''),
    );
  }

  const { head: sniffed, whole, text: rest } = await sniff(value);

  // A guide is the one input that is routinely enormous — subsetting somebody
  // else's 900 channels is the whole point — so it streams, and only its
  // `<channel>` ids are kept. Reading a 90 MiB document whole to end up with a
  // few hundred strings would undo the feature it is being read for.
  if (isGuide(sniffed)) {
    const ids = new Set<string>();

    for await (const event of parseXmltvStream(whole())) {
      if (event.type === 'channel') {
        ids.add(event.value.id);
      }
    }

    return ids;
  }

  return new Set(
    wantedFrom(await rest(), value)
      .map((channel) => channel.id)
      .filter((id) => id !== ''),
  );
}

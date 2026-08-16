import type { XmltvChannel } from '../xmltv/types.js';
import { textKey, unionBy, urlKey } from './programme.js';

/**
 * Merge two `<channel>` descriptions of the same channel from different
 * sites into one. Display names are unioned by `(lang, value)`, icons by
 * `src` and urls by value — `base` (the higher-priority site) first.
 */
export function mergeChannels(base: XmltvChannel, extra: XmltvChannel): XmltvChannel {
  const merged: XmltvChannel = {
    id: base.id,
    displayName: unionBy(base.displayName, extra.displayName, textKey),
  };

  const icon = unionBy(base.icon, extra.icon, (item) => item.src);
  if (icon.length > 0) merged.icon = icon;

  const url = unionBy(base.url, extra.url, urlKey);
  if (url.length > 0) merged.url = url;

  const extras = unionBy(base.extra, extra.extra, (item) => JSON.stringify(item));
  if (extras.length > 0) merged.extra = extras;

  const extraAttributes = { ...extra.extraAttributes, ...base.extraAttributes };
  if (Object.keys(extraAttributes).length > 0) merged.extraAttributes = extraAttributes;

  return merged;
}

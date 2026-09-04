/**
 * Write a `*.channels.xml` document.
 *
 * These files live in version control and are edited by hand, so the output is
 * shaped for a diff rather than for a parser: the entries stay in the order
 * they were given, the indentation matches what iptv-org and WebGrab+Plus both
 * write, and the attributes come out in the order those two put them in. A
 * writer that sorted or re-ordered would turn every one-channel change into an
 * unreviewable patch.
 */

import { escapeXml } from '../xmltv/escape.js';
import type { ChannelList, ChannelListEntry } from './types.js';

export interface WriteChannelListOptions {
  /**
   * A `site` for the `<channels>` root, naming the source once.
   *
   * An entry whose own `site` is this one then writes without it, which is what
   * makes reading such a file and writing it back a no-op rather than a diff
   * that repeats the site on every line.
   */
  site?: string;
  /**
   * What ends a line. Defaults to `'\n'`.
   *
   * The files in the wild are LF, including on Windows checkouts, because they
   * are kept in git.
   */
  eol?: '\n' | '\r\n';
}

/** One `<channel>` element, attributes in the order the two formats use them. */
export function serializeChannelListEntry(
  entry: ChannelListEntry,
  options?: WriteChannelListOptions,
): string {
  let out = '  <channel';

  // `update` first, where WebGrab+Plus puts it; then the four iptv-org writes,
  // in its order. A file read and written back is a no-op diff either way.
  if (entry.update !== undefined) {
    out += ` update="${escapeXml(entry.update)}"`;
  }

  // Left off when the root already says it, and written when it differs — a
  // list may name one source and still carry a channel from another.
  if (entry.site !== undefined && entry.site !== options?.site) {
    out += ` site="${escapeXml(entry.site)}"`;
  }

  out += ` site_id="${escapeXml(entry.siteId)}"`;

  if (entry.lang !== undefined) {
    out += ` lang="${escapeXml(entry.lang)}"`;
  }

  // Written even when empty, because that is what an unmapped channel *is* in
  // these files, and the tooling that reads them expects the attribute.
  out += ` xmltv_id="${escapeXml(entry.xmltvId)}"`;

  for (const [attribute, value] of [
    ['logo', entry.logo],
    ['url', entry.url],
    ['lcn', entry.lcn],
  ] as const) {
    if (value !== undefined) {
      out += ` ${attribute}="${escapeXml(value)}"`;
    }
  }

  return `${out}>${escapeXml(entry.name)}</channel>${options?.eol ?? '\n'}`;
}

/**
 * A whole `<channels>` document.
 *
 * Takes what {@link parseChannelList} returned, or just its entries — so
 * `serializeChannelList(parseChannelList(text))` writes the file back as it
 * was, root `site` and all, without the caller having to move it across.
 */
export function serializeChannelList(
  list: ChannelList | readonly ChannelListEntry[],
  options?: WriteChannelListOptions,
): string {
  // `Array.isArray` and not `'entries' in list`: an array *has* an `entries`
  // method, so the `in` check matches both branches and reads the method as the
  // list. The casts are the price of `Array.isArray` narrowing a readonly array
  // to `any[]`.
  const given = Array.isArray(list);
  const entries = given ? (list as readonly ChannelListEntry[]) : (list as ChannelList).entries;
  const root = options?.site ?? (given ? undefined : (list as ChannelList).site);
  const eol = options?.eol ?? '\n';
  const site = root === undefined ? '' : ` site="${escapeXml(root)}"`;
  let out = `<?xml version="1.0" encoding="UTF-8"?>${eol}<channels${site}>${eol}`;

  for (const entry of entries) {
    out += serializeChannelListEntry(entry, {
      ...options,
      ...(root === undefined ? {} : { site: root }),
    });
  }

  return `${out}</channels>${eol}`;
}

/**
 * Read a `*.channels.xml` document.
 *
 * A tiny reader rather than a general XML parser, because the document is tiny
 * and flat: a `<channels>` root, one level of `<channel>` elements, attributes
 * and a text body. There is no nesting to track and no mixed content to worry
 * about, so a scan for `<channel` and the matching `>` is the whole of it.
 *
 * Warnings rather than throws, as everywhere else here: these files are kept by
 * hand and the useful answer to a malformed one is the 2,298 channels that
 * *did* read, plus a note about the one that did not.
 */

import { decodeEntities } from '../xmltv/escape.js';
import type { ChannelList, ChannelListEntry, ChannelListWarning } from './types.js';

const CHANNEL_OPEN = '<channel';

const SPACE = ' '.charCodeAt(0);
const TAB = '\t'.charCodeAt(0);
const LF = '\n'.charCodeAt(0);
const CR = '\r'.charCodeAt(0);
const GT = '>'.charCodeAt(0);
const SLASH = '/'.charCodeAt(0);

/** Attributes of one element, as spelled. Values are entity-decoded. */
function attributes(text: string): Map<string, string> {
  const found = new Map<string, string>();
  const pattern = /([A-Za-z_:][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match = pattern.exec(text);

  while (match !== null) {
    found.set(match[1]!, decodeEntities(match[3] ?? match[4] ?? ''));
    match = pattern.exec(text);
  }

  return found;
}

/**
 * Every `<channel>` in a `*.channels.xml`, in the order the file has them.
 *
 * Order is kept because these files are hand-maintained and diffed: writing one
 * back with its channels rearranged would turn a one-line change into a review
 * nobody can read.
 */
export function parseChannelList(text: string): ChannelList {
  const entries: ChannelListEntry[] = [];
  const warnings: ChannelListWarning[] = [];
  /** Which line an index falls on, counted as the scan passes newlines. */
  let line = 1;
  let counted = 0;
  const lineAt = (index: number): number => {
    for (; counted < index; counted++) {
      if (text.charCodeAt(counted) === LF) {
        line++;
      }
    }

    return line;
  };

  const root = /<channels\b([^>]*)>/.exec(text);
  const rootSite = root === null ? undefined : attributes(root[1]!).get('site');

  if (root === null) {
    warnings.push({
      code: 'unexpected-document',
      message: 'no <channels> element: this does not look like a channel list',
      line: 1,
    });

    return { entries, warnings };
  }

  /**
   * `site_id`s already seen, per site.
   *
   * Nested rather than joined into one `site + siteId` string, which needs a
   * separator that can appear in neither — and a `site_id` may hold very nearly
   * anything: WebGrab+Plus writes them like `tv3/42`.
   */
  const seen = new Map<string, Set<string>>();
  let at = text.indexOf(CHANNEL_OPEN);

  while (at !== -1) {
    const after = text.charCodeAt(at + CHANNEL_OPEN.length);

    // `<channels>` itself, and any longer name that merely starts the same way.
    if (
      after !== SPACE &&
      after !== TAB &&
      after !== LF &&
      after !== CR &&
      after !== GT &&
      after !== SLASH
    ) {
      at = text.indexOf(CHANNEL_OPEN, at + CHANNEL_OPEN.length);
      continue;
    }

    const close = text.indexOf('>', at);

    if (close === -1) {
      break;
    }

    const selfClosing = text.charCodeAt(close - 1) === SLASH;
    const found = attributes(text.slice(at + CHANNEL_OPEN.length, selfClosing ? close - 1 : close));
    const body = selfClosing ? '' : text.slice(close + 1, indexOfClose(text, close + 1));
    const entryLine = lineAt(at);
    const siteId = found.get('site_id') ?? '';
    const xmltvId = found.get('xmltv_id') ?? '';
    const name = decodeEntities(body).trim();
    const site = found.get('site');

    if (siteId === '') {
      warnings.push({
        code: 'missing-site-id',
        message: `<channel> for ${JSON.stringify(name)} has no site_id, so nothing can be fetched for it`,
        line: entryLine,
      });
    } else {
      // The resolved site, so a channel naming it and one inheriting it from
      // the root still collide — they are the same channel of the same source.
      const of = site ?? rootSite ?? '';
      let ids = seen.get(of);

      if (ids === undefined) {
        ids = new Set();
        seen.set(of, ids);
      }

      if (ids.has(siteId)) {
        warnings.push({
          code: 'duplicate-site-id',
          message: `site_id ${JSON.stringify(siteId)} appears more than once${
            of === '' ? '' : ` for ${of}`
          }`,
          line: entryLine,
        });
      }

      ids.add(siteId);
    }

    if (xmltvId === '') {
      warnings.push({
        code: 'unmapped-channel',
        message: `${JSON.stringify(name || siteId)} has no xmltv_id, so nothing in a guide can match it`,
        line: entryLine,
      });
    }

    const lang = found.get('lang');
    const update = found.get('update');
    const logo = found.get('logo');
    const url = found.get('url');
    const lcn = found.get('lcn');
    // The root's `site` where the channel gave none: a file that names its
    // source once means every channel in it, and an entry should not have to be
    // read back with the document in hand to know where it came from.
    const belongsTo = site ?? rootSite;

    entries.push({
      siteId,
      xmltvId,
      name,
      ...(belongsTo === undefined ? {} : { site: belongsTo }),
      ...(lang === undefined ? {} : { lang }),
      ...(update === undefined ? {} : { update }),
      ...(logo === undefined ? {} : { logo }),
      ...(url === undefined ? {} : { url }),
      ...(lcn === undefined ? {} : { lcn }),
    });

    at = text.indexOf(CHANNEL_OPEN, close);
  }

  return { ...(rootSite === undefined ? {} : { site: rootSite }), entries, warnings };
}

/** Where this element's text ends: its `</channel>`, or the next `<`. */
function indexOfClose(text: string, from: number): number {
  const end = text.indexOf('<', from);

  return end === -1 ? text.length : end;
}

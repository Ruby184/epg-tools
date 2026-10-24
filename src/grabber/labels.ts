/**
 * What a run counts a request under where the site names none — see
 * `RequestCounts`. Here once, so a default and the check of a site's own
 * label cannot disagree; and in a module of its own, importing nothing, since
 * the site, its channel list and its run all read it.
 */
export const LABELS = {
  /** A channel list fetched: the run's own, so no site may name a request so. */
  channels: 'channels',
  /** A planned request, where the site gives no `requestLabel`. */
  request: 'request',
  /** A parse's `ctx.paced` call, where it gives no label. */
  paced: 'paced',
  /** A stream's `ctx.paced` call, where neither it nor the site's `requestLabel` names one. */
  stream: 'stream',
} as const;

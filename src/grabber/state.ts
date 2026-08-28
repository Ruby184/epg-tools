/**
 * What a site remembers between runs, and the handle a run holds it by.
 *
 * The cache keeps one small blob per `(site, key)` and never looks inside one —
 * see {@link CacheStore.getState}. What the groups *are* is here: the names, the
 * shape of each, and the bookkeeping that keeps a run from reading a group twice
 * or writing one it never changed.
 *
 * A group is read when it is first asked for and not before, so nobody pays for
 * one they have no use for: a site run wants its own bag, a merge or
 * `--list-channels` wants the channel list and nothing else. Asking again is free
 * and gives back the same thing — including while the first read is still in
 * flight, which is what makes two pipelines asking at once one question rather
 * than two.
 */

import type { CacheStore, StateEntry } from '../cache/types.js';
import type { AnySiteConfig, GrabberChannel, SiteState } from './types.js';

/**
 * The groups this package keeps on a site's behalf, by the key each is stored
 * under.
 *
 * `SITE` is stored as `state` because that is what it is to anyone looking at a
 * cache directory — the site's own — while the rest is bookkeeping done for it.
 */
export enum StateKey {
  /** A channel list `resolveChannels` fetched. */
  CHANNELS = 'channels',
  /** Whatever the site itself put there. */
  SITE = 'state',
}

/**
 * How long a cached channel list stays fresh when a site asks for one without
 * saying. A day: long enough that no command re-fetches a list the last one
 * already has, short enough that a channel added to a source turns up without
 * anybody clearing a cache.
 */
export const DEFAULT_CHANNELS_MAX_AGE_DAYS = 1;

const DAY_MS = 86_400_000;

/**
 * How long this site's cached channel list may be kept, or nothing when it does
 * not want one kept at all.
 *
 * Off unless asked, so nothing changes behaviour by upgrading: a list that is
 * fetched every run keeps being fetched every run until someone says otherwise.
 */
export function channelsMaxAgeMs(config: AnySiteConfig): number | undefined {
  const asked = config.cacheChannels;

  if (asked === undefined || asked === false) {
    return undefined;
  }

  const days = (asked === true ? undefined : asked.maxAgeDays) ?? DEFAULT_CHANNELS_MAX_AGE_DAYS;

  return Math.max(0, days) * DAY_MS;
}

/**
 * A `Map` that remembers which keys actually changed.
 *
 * A bag is handed out as an ordinary `Map` — `state.set('token', x)` with no
 * await, and nothing to learn — so nothing else can tell a run that it was
 * written to, and rewriting a group nothing touched would be a file written per
 * site per run for no reason. Tracking the *keys* rather than a flag costs one
 * `Set` and leaves room for a driver that would rather be told the diff than
 * handed the whole group.
 *
 * A subclass rather than a `Proxy`: a `Map` keeps its data in an internal slot,
 * so a proxy's `get` trap has to bind every method it hands out or every call
 * fails on an incompatible receiver — indirection to re-implement what `extends`
 * gives for nothing.
 */
export class TrackedMap<V> extends Map<string, V> {
  /** Keys written or removed since it was loaded. Empty means nothing to save. */
  readonly changed = new Set<string>();

  /**
   * The entries this group was stored with, taken as already stored.
   *
   * Filled here rather than handed to `Map`'s own constructor, which would call
   * *this* class's {@link set} for each of them — twice wrong. It would mark as
   * changed what had only just been read, and it would do so before
   * {@link changed} exists at all: a field is initialized after `super()`
   * returns, so the `Set` is still `undefined` while the base constructor is
   * inserting.
   */
  constructor(entries: Iterable<readonly [string, V]> = []) {
    super();

    for (const [key, value] of entries) {
      super.set(key, value);
    }
  }

  override set(key: string, value: V): this {
    // Setting a key to the value it already holds is not a change, so a site
    // storing the same token every run writes no file.
    if (!this.has(key) || super.get(key) !== value) {
      this.changed.add(key);
    }

    return super.set(key, value);
  }

  override delete(key: string): boolean {
    const had = super.delete(key);

    if (had) {
      this.changed.add(key);
    }

    return had;
  }

  override clear(): void {
    for (const key of this.keys()) {
      this.changed.add(key);
    }

    super.clear();
  }
}

/**
 * One group, as {@link SiteStateHandle.save} needs to see it: whether it is worth
 * writing, what to write, and — once written — that it is now what is stored.
 *
 * Which is what lets a handle save every kind of group with one loop, and a new
 * kind of group be added without touching it.
 */
interface StateGroup {
  readonly key: string;
  readonly dirty: boolean;
  data(): unknown;
  /** What to stamp the write with, when the group has an opinion. */
  writtenAt(): string | undefined;
  settle(): void;
}

/**
 * The channel list a site fetched, and how old it is allowed to get.
 *
 * A group of its own rather than a bag because it is one value with one question
 * asked of it, and because the answer depends on when it was written — which the
 * envelope already records, so the list carries no timestamp of its own to
 * disagree with.
 */
export class ChannelsGroup implements StateGroup {
  readonly key = StateKey.CHANNELS;
  #list: GrabberChannel[] | undefined;
  #writtenAt: string | undefined;
  #dirty = false;

  constructor(list: GrabberChannel[] | undefined, writtenAt: string | undefined) {
    this.#list = list;
    this.#writtenAt = writtenAt;
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  /** The list, while it is still worth having: `maxAgeMs` from when it was written. */
  fresh(maxAgeMs: number, now: Date): GrabberChannel[] | undefined {
    if (this.#list === undefined || this.#writtenAt === undefined) {
      return undefined;
    }

    const written = Date.parse(this.#writtenAt);
    const age = now.getTime() - written;

    // A list stamped in the future is one to distrust rather than to keep for
    // ever: a clock that moved, or a cache copied from another machine.
    return Number.isNaN(written) || age < 0 || age > maxAgeMs ? undefined : this.#list;
  }

  /** Remember this list, as fetched at `now`. */
  set(list: GrabberChannel[], now: Date): void {
    this.#list = list;
    this.#writtenAt = now.toISOString();
    this.#dirty = true;
  }

  data(): unknown {
    return this.#list;
  }

  writtenAt(): string | undefined {
    return this.#writtenAt;
  }

  settle(): void {
    this.#dirty = false;
  }
}

/**
 * A group of key-value pairs: the site's own bag, or another keyed the same way.
 *
 * Stored as its **entries** rather than as an object, which is the form that
 * round-trips a `Map` exactly. An object would reorder any key that looks like an
 * integer — JS puts those first, whatever order they went in — and insertion
 * order is not decoration here: it is what a group ordered by use is ordered by.
 */
class BagGroup<V> implements StateGroup {
  readonly map: TrackedMap<V>;

  constructor(
    readonly key: string,
    entries: Array<[string, V]>,
  ) {
    this.map = new TrackedMap(entries);
  }

  get dirty(): boolean {
    return this.map.changed.size > 0;
  }

  data(): unknown {
    return [...this.map];
  }

  writtenAt(): string | undefined {
    // Nothing to say: the manager stamps the write with the moment it happens,
    // which for a bag is exactly what "last written" means.
    return undefined;
  }

  settle(): void {
    this.map.changed.clear();
  }
}

/** A channel list as it comes back out of a store: at its word, until checked. */
function asChannels(data: unknown): GrabberChannel[] | undefined {
  // All or nothing, unlike a bag's entries below: half a channel list would mean
  // grabbing half a site, which is worse than fetching the list again.
  return Array.isArray(data) &&
    data.every(
      (channel: unknown) =>
        typeof channel === 'object' &&
        channel !== null &&
        typeof (channel as GrabberChannel).xmltvId === 'string' &&
        typeof (channel as GrabberChannel).siteId === 'string',
    )
    ? (data as GrabberChannel[])
    : undefined;
}

/**
 * The entries a bag was stored as, in the order they were written.
 *
 * A pair that is not one is dropped rather than costing the rest: forgetting one
 * unreadable value is better than forgetting the token beside it.
 */
function asEntries<V>(data: unknown): Array<[string, V]> {
  return Array.isArray(data)
    ? data.filter(
        (entry: unknown): entry is [string, V] =>
          Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string',
      )
    : [];
}

/**
 * One site's state for the length of a run: asked for what it needs, handed
 * around by reference, and saved once.
 *
 * Each group is loaded on first ask and remembered, so a caller says what it
 * wants where it wants it rather than declaring its needs up front — and asking
 * twice, or from two places at once, costs one read. Saving writes only the
 * groups that changed, so a pass that reads a channel list and nothing else
 * leaves the cache alone.
 */
export class SiteStateHandle {
  readonly #store: CacheStore;
  readonly #site: string;

  /**
   * The groups in hand, by key — as *promises*, deliberately. A run has more than
   * one thing happening at a time, and remembering the read rather than its
   * result is what makes two asks that overlap one question of the store.
   */
  readonly #groups = new Map<string, Promise<StateGroup>>();

  private constructor(store: CacheStore, site: string) {
    this.#store = store;
    this.#site = site;
  }

  /** A handle over this site's state. Reads nothing until something is asked for. */
  static open(store: CacheStore, site: string): SiteStateHandle {
    return new SiteStateHandle(store, site);
  }

  /** The channel list this site last fetched, and where to put the next one. */
  async channels(): Promise<ChannelsGroup> {
    return this.#use(
      StateKey.CHANNELS,
      (found) => new ChannelsGroup(asChannels(found?.data), found?.meta.writtenAt),
    );
  }

  /**
   * A bag of key-value pairs the site keeps — {@link StateKey.SITE} unless
   * another group is named.
   *
   * What a site's `ctx.state` is: one `Map` per site for the whole run rather
   * than per channel-day, so a token written by one request is there for every
   * later request and every `parseDay`, and two pipelines running at once share
   * it. Whatever goes in must survive `JSON.stringify`, this being a cache file.
   */
  async bag<V = unknown>(key: string = StateKey.SITE): Promise<TrackedMap<V>> {
    const group = await this.#use(key, (found) => new BagGroup<V>(key, asEntries<V>(found?.data)));

    return group.map;
  }

  /** The site's bag as a plain `Map`, which is all a site is promised. */
  async siteState(): Promise<SiteState> {
    return this.bag();
  }

  /** Write back the groups that changed, and nothing else. */
  async save(): Promise<void> {
    for (const pending of this.#groups.values()) {
      const group = await pending;

      if (!group.dirty) {
        continue;
      }

      const writtenAt = group.writtenAt();

      await this.#store.setState(this.#site, group.key, group.data(), {
        ...(writtenAt === undefined ? {} : { writtenAt }),
      });
      group.settle();
    }
  }

  /**
   * One group, read once and made into whatever kind of group it is.
   *
   * The promise goes in before it settles, so a second ask — from anywhere, at
   * any time — joins the read already under way instead of starting another. The
   * cast on the way back out is the one thing this cannot prove: a `Map` of
   * groups cannot say which kind each key holds. It stands on the invariant that
   * a key is only ever asked for through the one method that owns it, which is
   * why `channels()` and `bag()` are the only callers.
   */
  async #use<TGroup extends StateGroup>(
    key: string,
    make: (found: StateEntry | undefined) => TGroup,
  ): Promise<TGroup> {
    let pending = this.#groups.get(key);

    if (pending === undefined) {
      pending = this.#store.getState(this.#site, key).then(make);
      this.#groups.set(key, pending);
    }

    return pending as Promise<TGroup>;
  }
}

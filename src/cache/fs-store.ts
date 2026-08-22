import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeFileAtomic } from '../core/atomic.js';
import type { XmltvProgramme } from '../xmltv/types.js';
import type {
  CacheEntryMeta,
  CacheFormat,
  CacheStore,
  ChannelDayKey,
  FsCacheStoreOptions,
} from './types.js';

type XmltvModule = typeof import('../xmltv/main.js');

const ENTRY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.(?:ndjson|xml|meta\.json)$/;

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/** Revive Date fields of a programme parsed from an ndjson line. */
function reviveProgramme(line: string): XmltvProgramme {
  const raw = JSON.parse(line) as XmltvProgramme;

  raw.start = new Date(raw.start);

  if (raw.stop !== undefined) {
    raw.stop = new Date(raw.stop);
  }

  if (raw.pdcStart !== undefined) {
    raw.pdcStart = new Date(raw.pdcStart);
  }

  if (raw.vpsStart !== undefined) {
    raw.vpsStart = new Date(raw.vpsStart);
  }

  if (raw.previouslyShown?.start !== undefined) {
    raw.previouslyShown.start = new Date(raw.previouslyShown.start);
  }

  return raw;
}

/**
 * Filesystem-backed {@link CacheStore}.
 *
 * Layout: `<dir>/<site>/<channelId>/<day>.<ext>` where `ext` is `ndjson` or
 * `xml`, plus a sidecar `<day>.meta.json` holding {@link CacheEntryMeta}.
 * Site and channel path segments are sanitized with `encodeURIComponent`.
 *
 * A store reads entries written in either format regardless of its
 * configured write format.
 */
export class FsCacheStore implements CacheStore {
  readonly #dir: string;
  readonly #format: CacheFormat;
  readonly #signal: AbortSignal | undefined;
  /**
   * Channel directories this store has already made. A grab writes every day of
   * a channel in turn, so without this each of them asks the filesystem to make
   * a directory that has been there since the first — 7,000 entries is a
   * quarter of a second of learning what we already knew.
   */
  readonly #ensured = new Set<string>();
  #xmltv: Promise<XmltvModule> | undefined;

  constructor(options: FsCacheStoreOptions) {
    this.#dir = options.dir;
    this.#format = options.format ?? 'ndjson';
    this.#signal = options.signal;
  }

  /**
   * Reading options for `fs`: the encoding, and the signal when there is one.
   *
   * A store belongs to a run, so the signal lives here rather than on every
   * method — which is also what keeps the `CacheStore` interface something
   * anyone can implement with three arguments and no ceremony.
   */
  #readOptions(): { encoding: BufferEncoding; signal: AbortSignal | undefined } {
    return { encoding: 'utf8', signal: this.#signal };
  }

  /** The xmltv module is loaded lazily so ndjson-only usage never needs it. */
  #loadXmltv(): Promise<XmltvModule> {
    this.#xmltv ??= import('../xmltv/main.js');
    return this.#xmltv;
  }

  #channelDir(key: ChannelDayKey): string {
    return path.join(this.#dir, encodeURIComponent(key.site), encodeURIComponent(key.channelId));
  }

  /** The channel's directory, made once per store however many days it holds. */
  async #ensureDir(dir: string): Promise<void> {
    if (this.#ensured.has(dir)) {
      return;
    }

    await fs.mkdir(dir, { recursive: true });
    this.#ensured.add(dir);
  }

  /** Path prefix of an entry, without the file extension. */
  #entryBase(key: ChannelDayKey): string {
    return path.join(this.#channelDir(key), key.day);
  }

  async getMeta(key: ChannelDayKey): Promise<CacheEntryMeta | undefined> {
    let content: string;

    try {
      content = await fs.readFile(`${this.#entryBase(key)}.meta.json`, this.#readOptions());
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }

      throw error;
    }

    try {
      const meta = JSON.parse(content) as Partial<CacheEntryMeta>;

      if (typeof meta.grabbedAt !== 'string' || typeof meta.programmeCount !== 'number') {
        throw new TypeError('invalid cache meta shape');
      }

      return meta as CacheEntryMeta;
    } catch {
      // Corrupt sidecar: treat the whole entry as missing and remove it.
      await this.delete(key);
      return undefined;
    }
  }

  async read(key: ChannelDayKey): Promise<XmltvProgramme[] | undefined> {
    const base = this.#entryBase(key);

    // Both formats are readable regardless of the configured write format;
    // try the configured one first to avoid a pointless ENOENT per read.
    const readers =
      this.#format === 'ndjson'
        ? [() => this.#readNdjson(base), () => this.#readXml(base)]
        : [() => this.#readXml(base), () => this.#readNdjson(base)];

    for (const reader of readers) {
      const programmes = await reader();

      if (programmes !== undefined) {
        return programmes;
      }
    }

    return undefined;
  }

  async #readNdjson(base: string): Promise<XmltvProgramme[] | undefined> {
    let content: string;

    try {
      content = await fs.readFile(`${base}.ndjson`, this.#readOptions());
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }

      throw error;
    }

    return content
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map(reviveProgramme);
  }

  async #readXml(base: string): Promise<XmltvProgramme[] | undefined> {
    const { parseXmltvStream } = await this.#loadXmltv();
    const programmes: XmltvProgramme[] = [];

    try {
      // A missing file surfaces as ENOENT on the first stream read.
      const reading = createReadStream(`${base}.xml`, { signal: this.#signal });

      for await (const event of parseXmltvStream(reading)) {
        if (event.type === 'programme') {
          programmes.push(event.value);
        }
      }
    } catch (error) {
      if (isNotFound(error)) {
        return undefined;
      }

      throw error;
    }

    return programmes;
  }

  async write(
    key: ChannelDayKey,
    programmes: XmltvProgramme[],
    meta?: Partial<CacheEntryMeta>,
  ): Promise<void> {
    await this.#ensureDir(this.#channelDir(key));

    const base = this.#entryBase(key);
    let data: string;
    let staleFile: string;

    if (this.#format === 'ndjson') {
      data = programmes.map((programme) => `${JSON.stringify(programme)}\n`).join('');
      staleFile = `${base}.xml`;
    } else {
      const { serializeProgramme } = await this.#loadXmltv();
      const elements = programmes
        .map((programme) => serializeProgramme(programme))
        .map((element) => (element.endsWith('\n') ? element : `${element}\n`))
        .join('');
      data = `<?xml version="1.0" encoding="UTF-8"?>\n<tv>\n${elements}</tv>\n`;
      staleFile = `${base}.ndjson`;
    }

    await writeFileAtomic(
      `${base}.${this.#format === 'ndjson' ? 'ndjson' : 'xml'}`,
      data,
      this.#signal,
    );
    // An entry must exist in a single format only.
    await fs.rm(staleFile, { force: true });

    const fullMeta: CacheEntryMeta = {
      grabbedAt: meta?.grabbedAt ?? new Date().toISOString(),
      programmeCount: programmes.length,
    };

    await writeFileAtomic(`${base}.meta.json`, `${JSON.stringify(fullMeta)}\n`, this.#signal);
  }

  async delete(key: ChannelDayKey): Promise<void> {
    const base = this.#entryBase(key);

    await Promise.all([
      fs.rm(`${base}.ndjson`, { force: true }),
      fs.rm(`${base}.xml`, { force: true }),
      fs.rm(`${base}.meta.json`, { force: true }),
    ]);
  }

  async prune(options: { before: string }): Promise<number> {
    let removed = 0;
    let sites;

    try {
      sites = await fs.readdir(this.#dir, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) {
        return 0;
      }

      throw error;
    }

    for (const site of sites) {
      // Between sites, and between channels below: `readdir` and `rm` take no
      // signal of their own, and a prune is a walk rather than one long
      // operation — so this is where it stops, having removed whole days.
      this.#signal?.throwIfAborted();

      if (!site.isDirectory()) {
        continue;
      }

      const sitePath = path.join(this.#dir, site.name);
      const channels = await fs.readdir(sitePath, { withFileTypes: true });

      for (const channel of channels) {
        this.#signal?.throwIfAborted();

        if (!channel.isDirectory()) {
          continue;
        }

        const channelPath = path.join(sitePath, channel.name);
        removed += await this.#pruneChannelDir(channelPath, options.before);

        if ((await fs.readdir(channelPath)).length === 0) {
          await fs.rmdir(channelPath);
          // It is not there any more, so a later write to this channel has to
          // make it again.
          this.#ensured.delete(channelPath);
        }
      }

      if ((await fs.readdir(sitePath)).length === 0) {
        await fs.rmdir(sitePath);
      }
    }

    return removed;
  }

  /** Remove all entries in one channel directory older than `before`. */
  async #pruneChannelDir(channelPath: string, before: string): Promise<number> {
    const files = await fs.readdir(channelPath);
    const staleDays = new Set<string>();

    for (const file of files) {
      const day = ENTRY_FILE_RE.exec(file)?.[1];

      // String comparison works for YYYY-MM-DD day strings.
      if (day !== undefined && day < before) {
        staleDays.add(day);
      }
    }

    for (const day of staleDays) {
      const base = path.join(channelPath, day);

      await Promise.all([
        fs.rm(`${base}.ndjson`, { force: true }),
        fs.rm(`${base}.xml`, { force: true }),
        fs.rm(`${base}.meta.json`, { force: true }),
      ]);
    }

    return staleDays.size;
  }
}

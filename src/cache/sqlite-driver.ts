/**
 * A cache of SQLite rows: one row per channel-day, one file for the lot.
 *
 * What a directory of files is bad at, this is good at. A fortnight of 5,000
 * channels is 70,000 files — 70,000 inodes to walk, back up, copy into an image
 * or wait through an `ls` of, and one `readdir` per channel to prune. Here it is
 * one file, and a prune is one statement the database plans itself. What you give
 * up is the thing files are unbeatable at: reading one day's listings with `cat`.
 *
 * It is a separate entry point — `epg-tools/cache/sqlite` — because `node:sqlite`
 * is not on every runtime this package supports: it arrived in Node 22.5 behind
 * `--experimental-sqlite`, and is there without a flag from Node 24. Nothing
 * loads this module until a config asks for it, by name or otherwise, so an
 * older Node is unaffected until then.
 *
 * The API is synchronous, which for a cache is a feature rather than a
 * compromise: a statement against a local file costs microseconds, so there is
 * nothing to overlap and no threadpool to bound — the file descriptor storm the
 * filesystem driver is careful about cannot happen here at all.
 */

import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { CacheDriverBase } from './driver.js';
import type {
  CacheDriver,
  ChannelDayKey,
  FoundEntry,
  FoundMeta,
  FoundState,
  StoredEntryMeta,
  StoredProgramme,
  StoredStateMeta,
} from './types.js';

/**
 * The version of the table, kept in SQLite's own `user_version`.
 *
 * A different question from an entry's `schema`, which says what one row
 * *holds*: this says what the columns *are*, and a mismatch is not something
 * re-grabbing a day could fix, since the statements would not run at all. So the
 * table is dropped and made again — a cache is disposable, and that is the whole
 * of the migration story here as everywhere else in this module.
 *
 * 1 — site, channel, day, the four meta fields, and the programmes as JSON.
 * 2 — a `state` table beside it: what each site remembers between runs.
 */
const TABLE_VERSION = 2;

/** What the database is called inside the cache directory. */
const DEFAULT_FILE = 'cache.sqlite';

/**
 * One table, and two indexes over it.
 *
 * A rowid table rather than `WITHOUT ROWID`, and the difference is the hot path.
 * A staleness check asks about every channel-day of a window and reads four small
 * columns of each, while a day of listings is several kilobytes of JSON in the
 * same row. `WITHOUT ROWID` would put both in one B-tree, so those small reads
 * walk pages bloated by payloads they have no use for. Here the payload stays in
 * the table and `entries_meta` holds every column a staleness check wants, so the
 * sweep is answered from an index that never touches it: 7,000 of them cost 80ms
 * against 310ms, and reading 7,000 whole entries 670ms against 880ms. The second
 * index costs about 6% on writes and 2% on the file, which is the trade.
 *
 * `entries_key` is what makes a channel-day one row — an upsert needs a unique
 * index on exactly those three columns to name as its conflict target, and
 * `entries_meta` leads with the same three but must not be the unique one, since
 * two entries differing only in `grabbed_at` would then both be allowed.
 */
const CREATE_TABLE = [
  `CREATE TABLE entries (
    site TEXT NOT NULL,
    channel TEXT NOT NULL,
    day TEXT NOT NULL,
    grabbed_at TEXT NOT NULL,
    programme_count INTEGER NOT NULL,
    schema INTEGER NOT NULL,
    written_by TEXT NOT NULL,
    programmes TEXT NOT NULL
  ) STRICT`,
  'CREATE UNIQUE INDEX entries_key ON entries (site, channel, day)',
  `CREATE INDEX entries_meta ON entries
    (site, channel, day, grabbed_at, programme_count, schema, written_by)`,
  /**
   * What each site remembers between runs, one row per group.
   *
   * `WITHOUT ROWID` here where `entries` is deliberately not: the reason to keep
   * a payload out of the key's B-tree is a hot path that reads the meta and not
   * the payload, and there is no such path for state — every read of a group
   * wants what is in it. So the key *is* the row, one lookup instead of two.
   */
  `CREATE TABLE state (
    site TEXT NOT NULL,
    key TEXT NOT NULL,
    written_at TEXT NOT NULL,
    schema INTEGER NOT NULL,
    written_by TEXT NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (site, key)
  ) STRICT, WITHOUT ROWID`,
];

const STATE_COLUMNS = 'written_at, schema, written_by, data';

const META_COLUMNS = 'grabbed_at, programme_count, schema, written_by';
const BY_KEY = 'WHERE site = ? AND channel = ? AND day = ?';

/** The meta columns as they come back. */
interface MetaRow {
  grabbed_at: string;
  programme_count: number;
  schema: number;
  written_by: string;
}

interface EntryRow extends MetaRow {
  programmes: string;
}

/** A meta row that says which key it answers, for a batch. */
interface KeyedMetaRow extends MetaRow {
  site: string;
  channel: string;
  day: string;
}

/** One group of a site's state, as its row comes back. */
interface StateRow {
  written_at: string;
  schema: number;
  written_by: string;
  data: string;
}

export interface SqliteCacheDriverOptions {
  /**
   * The cache directory, which is where the database goes — `cache.sqlite`
   * inside it. The same option every driver here takes, so a config that names
   * this one by `'sqlite'` needs nothing else, and the directory is made if it
   * is not there.
   */
  dir: string;
  /**
   * The database file itself, when it should not be the default inside
   * {@link dir}: a path of your own, or `':memory:'` for one that lasts as long
   * as the process.
   */
  file?: string;
  /**
   * Give up on what this driver is asked for.
   *
   * Asked at the start of each call, since a statement against a local file is
   * not something there would be any point interrupting half way through.
   */
  signal?: AbortSignal | undefined;
}

export class SqliteCacheDriver extends CacheDriverBase implements CacheDriver<StoredProgramme> {
  readonly #db: DatabaseSync;
  readonly #signal: AbortSignal | undefined;
  /**
   * Statements prepared once and reused, which is most of why this is quick: a
   * run asks the same handful of questions about every channel-day in the
   * window, and parsing that SQL 70,000 times would cost more than the reads do.
   */
  readonly #statements = new Map<string, StatementSync>();

  constructor(options: SqliteCacheDriverOptions) {
    super();
    this.#signal = options.signal;

    const file = options.file ?? path.join(options.dir, DEFAULT_FILE);

    // SQLite will not make the directory its file goes in, and on a first run
    // that directory is as likely as not to be missing.
    if (file !== ':memory:') {
      mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    }

    this.#db = new DatabaseSync(file);
    // Write-ahead logging, so a merge reading the cache is not held up by a grab
    // writing it; and the relaxed sync because this is a cache — a day lost to a
    // power cut is a day grabbed again.
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA synchronous = NORMAL');
    // Wait rather than fail when another process holds the write lock: grabbing
    // two sites into one cache from two commands is a reasonable thing to do.
    this.#db.exec('PRAGMA busy_timeout = 5000');
    this.#ensureTable();
  }

  /** The table as this code expects it — made, or made again. */
  #ensureTable(): void {
    const { user_version: version } = this.#db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };

    if (version === TABLE_VERSION) {
      return;
    }

    this.#db.exec('DROP TABLE IF EXISTS entries');
    this.#db.exec('DROP TABLE IF EXISTS state');

    for (const statement of CREATE_TABLE) {
      this.#db.exec(statement);
    }

    // Interpolated because a pragma takes no parameter — and it is an integer
    // constant of ours, not anything a caller can reach.
    this.#db.exec(`PRAGMA user_version = ${TABLE_VERSION}`);
  }

  #prepared(sql: string): StatementSync {
    let statement = this.#statements.get(sql);

    if (statement === undefined) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }

    return statement;
  }

  #meta(row: MetaRow): StoredEntryMeta {
    return {
      grabbedAt: row.grabbed_at,
      programmeCount: row.programme_count,
      schema: row.schema,
      writtenBy: row.written_by,
    };
  }

  async readMeta(key: ChannelDayKey): Promise<FoundMeta | undefined> {
    this.#signal?.throwIfAborted();

    // The payload column is left out of the query rather than read and dropped,
    // which is what lets `entries_meta` answer this on its own.
    const row = this.#prepared(`SELECT ${META_COLUMNS} FROM entries ${BY_KEY}`).get(
      key.site,
      key.channelId,
      key.day,
    ) as MetaRow | undefined;

    return row && { meta: this.#meta(row) };
  }

  /**
   * A whole batch in one statement, which is what a database is for.
   *
   * A row-value `IN` rather than a day range, so any set of keys works and the
   * unique index still answers it. The statement text depends on how many keys
   * there are, and prepared statements are cached by that text — a run asks
   * about the same window every time, so that settles at one or two.
   *
   * Worth it for the overhead saved rather than for any less reading: 7,000
   * statements become 500. As a run measures it — through the manager, which
   * judges every meta either way — a 500-channel fortnight sweeps in 65ms
   * against 115ms; the statements alone are 25ms against 80ms.
   */
  async readMetas(keys: readonly ChannelDayKey[]): Promise<Array<FoundMeta | undefined>> {
    this.#signal?.throwIfAborted();

    if (keys.length === 0) {
      return [];
    }

    const rows = this.#prepared(
      `SELECT site, channel, day, ${META_COLUMNS} FROM entries
       WHERE (site, channel, day) IN (VALUES ${keys.map(() => '(?, ?, ?)').join(', ')})`,
    ).all(
      ...keys.flatMap((key) => [key.site, key.channelId, key.day]),
    ) as unknown as KeyedMetaRow[];

    // By key, since a database answers in whatever order suits it while the
    // caller is owed the order it asked in — and a key with no row is a day
    // never grabbed, which is most of them on a first run.
    const found = new Map(rows.map((row) => [this.#id(row.site, row.channel, row.day), row]));

    return keys.map((key) => {
      const row = found.get(this.#id(key.site, key.channelId, key.day));

      return row && { meta: this.#meta(row) };
    });
  }

  /** One key as one string, for looking a row back up by it. */
  #id(site: string, channel: string, day: string): string {
    return `${site}\u0000${channel}\u0000${day}`;
  }

  async read(key: ChannelDayKey): Promise<FoundEntry<StoredProgramme> | undefined> {
    this.#signal?.throwIfAborted();

    const row = this.#prepared(`SELECT ${META_COLUMNS}, programmes FROM entries ${BY_KEY}`).get(
      key.site,
      key.channelId,
      key.day,
    ) as EntryRow | undefined;

    return row && { meta: this.#meta(row), programmes: this.#programmes(row.programmes) };
  }

  /** The records one row holds, or none when what it holds is not records. */
  #programmes(payload: string): StoredProgramme[] {
    try {
      const parsed = JSON.parse(payload) as unknown;

      return Array.isArray(parsed) ? (parsed as StoredProgramme[]) : [];
    } catch {
      // A payload that is not JSON says nothing about its programmes, and what
      // that means for the entry is not this driver's to decide: the meta beside
      // it is what the manager judges, and a count disagreeing with what came
      // back is a day worth grabbing again.
      return [];
    }
  }

  async write(
    key: ChannelDayKey,
    programmes: StoredProgramme[],
    meta: StoredEntryMeta,
  ): Promise<void> {
    this.#signal?.throwIfAborted();

    // One statement, so a row is either the whole entry or the one that was
    // there before it — the promise the filesystem driver keeps with an atomic
    // rename, kept here by the database.
    this.#prepared(
      `INSERT INTO entries (site, channel, day, ${META_COLUMNS}, programmes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (site, channel, day) DO UPDATE SET
         grabbed_at = excluded.grabbed_at,
         programme_count = excluded.programme_count,
         schema = excluded.schema,
         written_by = excluded.written_by,
         programmes = excluded.programmes`,
    ).run(
      key.site,
      key.channelId,
      key.day,
      meta.grabbedAt,
      meta.programmeCount,
      meta.schema,
      meta.writtenBy,
      JSON.stringify(programmes),
    );
  }

  async delete(key: ChannelDayKey): Promise<void> {
    this.#signal?.throwIfAborted();

    this.#prepared(`DELETE FROM entries ${BY_KEY}`).run(key.site, key.channelId, key.day);
  }

  async readState(site: string, key: string): Promise<FoundState | undefined> {
    this.#signal?.throwIfAborted();

    const row = this.#prepared(`SELECT ${STATE_COLUMNS} FROM state WHERE site = ? AND key = ?`).get(
      site,
      key,
    ) as StateRow | undefined;

    if (row === undefined) {
      return;
    }

    try {
      return {
        meta: {
          writtenAt: row.written_at,
          schema: row.schema,
          writtenBy: row.written_by,
        },
        data: JSON.parse(row.data) as unknown,
      };
    } catch {
      // A row whose payload is not JSON is a group nobody can read, envelope or
      // no envelope — reported as such, and removed by the manager.
      return { meta: undefined, data: undefined };
    }
  }

  async writeState(site: string, key: string, data: unknown, meta: StoredStateMeta): Promise<void> {
    this.#signal?.throwIfAborted();

    this.#prepared(
      `INSERT INTO state (site, key, ${STATE_COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (site, key) DO UPDATE SET
         written_at = excluded.written_at,
         schema = excluded.schema,
         written_by = excluded.written_by,
         data = excluded.data`,
    ).run(
      site,
      key,
      meta.writtenAt,
      meta.schema,
      meta.writtenBy,
      // `null` rather than nothing at all: the column is `NOT NULL` and
      // `JSON.stringify(undefined)` is not a string, so a group written empty
      // would fail the insert rather than reading back as empty.
      JSON.stringify(data ?? null),
    );
  }

  async deleteState(site: string, key: string): Promise<void> {
    this.#signal?.throwIfAborted();

    this.#prepared('DELETE FROM state WHERE site = ? AND key = ?').run(site, key);
  }

  async prune(options: { before: string }): Promise<number> {
    this.#signal?.throwIfAborted();

    // The whole prune in one statement the database plans itself: no directory
    // walk, nothing to do a few at a time, and nothing to stop half way — which
    // is why this is the one method whose signal is only asked at the start.
    const { changes } = this.#prepared('DELETE FROM entries WHERE day < ?').run(options.before);

    return Number(changes);
  }

  async close(): Promise<void> {
    this.#statements.clear();
    this.#db.close();
  }

  /** The same as {@link close}, for `await using`. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

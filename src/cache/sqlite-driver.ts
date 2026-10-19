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

import { accessSync, constants, existsSync, mkdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import type { CacheCodec, CodecName } from './codec.js';
import type {
  CacheDriver,
  CachedKey,
  CacheListOptions,
  ChannelDayKey,
  FoundEntry,
  FoundMeta,
  FoundState,
  StoredEntryMeta,
  StoredStateMeta,
} from './types.js';

/**
 * The version of the table, kept in SQLite's own `user_version`.
 *
 * A different question from an entry's `schema`, which says what one row
 * *holds*: this says what the columns *are*, and a mismatch is not something
 * re-grabbing a day could fix, since the statements would not run at all. So the
 * table is dropped and made again, by the first write — until then a read
 * finds nothing — since a cache is disposable, and that is the whole of the
 * migration story here as everywhere else in this module.
 *
 * 1 — site, channel, day, the four meta fields, and the programmes as JSON.
 * 2 — a `state` table beside it: what each site remembers between runs.
 * 3 — the programmes as bytes, a BLOB: the cache keeps what its codec made,
 *     so a channel-day a site's thread encoded is kept as it came.
 */
const TABLE_VERSION = 3;

/** How many keys {@link SqliteCacheDriver.list} reads at a time. */
const LIST_PAGE = 1000;

/** What asks a database which version of the tables it holds. */
const VERSION = 'PRAGMA user_version';

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
    programmes BLOB NOT NULL
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
  programmes: Uint8Array;
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

export class SqliteCacheDriver implements CacheDriver {
  /** The records' array, as JSON — kept in a row as the bytes the codec made. */
  readonly codec: CodecName | CacheCodec = 'json';

  readonly #file: string;
  readonly #signal: AbortSignal | undefined;
  /** Opened when first asked for anything, and only then — see {@link #prepared}. */
  #db: DatabaseSync | undefined;
  /** Whether the tables are the ones this code makes, as far as it has found. */
  #current = false;
  /** Whether the file is ready to write: logging ahead, and the tables this code's. */
  #writable = false;
  /** Whether {@link close} was asked for — after which nothing is opened again. */
  #closed = false;
  /**
   * Statements prepared once and reused, which is most of why this is quick: a
   * run asks the same handful of questions about every channel-day in the
   * window, and parsing that SQL 70,000 times would cost more than the reads do.
   */
  readonly #statements = new Map<string, StatementSync>();

  /**
   * Nothing is opened or made here: a driver made only to be looked into —
   * `epg cache` — must not make a database where there was none, or replace
   * the tables of one another version wrote. See {@link #prepared}.
   */
  constructor(options: SqliteCacheDriverOptions) {
    this.#signal = options.signal;
    this.#file = options.file ?? path.join(options.dir, DEFAULT_FILE);

    // Refused now rather than at the first write: a run asks the cache before
    // it fetches anything, so a database that could never be made would be
    // found out only after every request had been made for nothing.
    if (this.#file !== ':memory:' && !existsSync(this.#file)) {
      this.#canMake(this.#file);
    }
  }

  /**
   * Whether the file could be made where it is to go, asked without making
   * anything: the nearest directory there is, on its way, has to be writable.
   */
  #canMake(file: string): void {
    let dir = path.dirname(path.resolve(file));

    while (!existsSync(dir) && path.dirname(dir) !== dir) {
      dir = path.dirname(dir);
    }

    if (!statSync(dir).isDirectory()) {
      throw new Error(`The sqlite cache cannot be made at ${file}: ${dir} is not a directory`);
    }

    try {
      accessSync(dir, constants.W_OK);
    } catch (cause) {
      throw new Error(`The sqlite cache cannot be made at ${file}: ${dir} is not writable`, {
        cause,
      });
    }
  }

  #open(): void {
    const db = new DatabaseSync(this.#file);

    // The relaxed sync because this is a cache — a day lost to a power cut is a
    // day grabbed again.
    db.exec('PRAGMA synchronous = NORMAL');
    // Wait rather than fail when another process holds the write lock: grabbing
    // two sites into one cache from two commands is a reasonable thing to do.
    db.exec('PRAGMA busy_timeout = 5000');
    this.#db = db;
  }

  #version(): number {
    return (this.#statement(VERSION).get() as { user_version: number }).user_version;
  }

  /**
   * A statement on the open database, prepared the first time it is asked for
   * and reused after. Only ever asked once {@link #prepared} has opened it.
   */
  #statement(sql: string): StatementSync {
    let statement = this.#statements.get(sql);

    if (statement === undefined) {
      statement = this.#db!.prepare(sql);
      this.#statements.set(sql, statement);
    }

    return statement;
  }

  /** The table as this code expects it — made, or made again. */
  #ensureTable(): void {
    if (this.#version() === TABLE_VERSION) {
      return;
    }

    const db = this.#db!;

    db.exec('DROP TABLE IF EXISTS entries');
    db.exec('DROP TABLE IF EXISTS state');

    for (const statement of CREATE_TABLE) {
      db.exec(statement);
    }

    // Interpolated because a pragma takes no parameter — and it is an integer
    // constant of ours, not anything a caller can reach.
    db.exec(`PRAGMA user_version = ${TABLE_VERSION}`);
  }

  /**
   * A statement, prepared once and reused, on a database opened the first time
   * anything is asked of it.
   *
   * For a write, the file and its directory are made first, and the tables —
   * made again where another version made them. For a read there is no
   * statement where there is nothing this code can read: no file yet, or
   * tables of another version. That read answers as an empty store would, with
   * nothing made and nothing replaced — so a look changes nothing, and a run
   * finds nothing it can read and grabs again, as when the tables were replaced
   * the moment it opened. Asked again by each read while the answer is no,
   * which is one pragma: a run in another process may have made them since.
   */
  #prepared(mode: 'read' | 'change', sql: string): StatementSync | undefined;
  #prepared(mode: 'write', sql: string): StatementSync;
  #prepared(mode: 'read' | 'change' | 'write', sql: string): StatementSync | undefined {
    // Closed is closed: a driver used after it would otherwise open a database
    // again, which nothing would ever close.
    if (this.#closed) {
      throw new Error('This sqlite cache is closed');
    }

    // Nothing to read or to change where there is no file yet, or its tables
    // are another version's: only a write makes or replaces them.
    if (mode !== 'write' && !this.#current) {
      if (this.#db === undefined) {
        if (this.#file !== ':memory:' && !existsSync(this.#file)) {
          return undefined;
        }

        this.#open();
      }

      this.#current = this.#version() === TABLE_VERSION;

      if (!this.#current) {
        return undefined;
      }
    }

    // Ready to change the file: write-ahead logging, so a merge reading the
    // cache is not held up by a grab writing it — and, for a write, the file
    // and its tables made first. Said by the first change, whatever was read
    // before it, since it is a setting the file keeps: a look leaves the file
    // as it found it, and a run puts it back.
    if (mode !== 'read' && !this.#writable) {
      if (this.#db === undefined) {
        // SQLite will not make the directory its file goes in, and on a first
        // run that directory is as likely as not to be missing.
        if (this.#file !== ':memory:') {
          mkdirSync(path.dirname(path.resolve(this.#file)), { recursive: true });
        }

        this.#open();
      }

      this.#db!.exec('PRAGMA journal_mode = WAL');
      this.#ensureTable();
      this.#current = true;
      this.#writable = true;
    }

    return this.#statement(sql);
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
    const row = this.#prepared('read', `SELECT ${META_COLUMNS} FROM entries ${BY_KEY}`)?.get(
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

    const statement =
      keys.length === 0
        ? undefined
        : this.#prepared(
            'read',
            `SELECT site, channel, day, ${META_COLUMNS} FROM entries
       WHERE (site, channel, day) IN (VALUES ${keys.map(() => '(?, ?, ?)').join(', ')})`,
          );

    if (statement === undefined) {
      return keys.map(() => undefined);
    }

    const rows = statement.all(
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

  async read(key: ChannelDayKey): Promise<FoundEntry | undefined> {
    this.#signal?.throwIfAborted();

    const row = this.#prepared(
      'read',
      `SELECT ${META_COLUMNS}, programmes FROM entries ${BY_KEY}`,
    )?.get(key.site, key.channelId, key.day) as EntryRow | undefined;

    return row && { meta: this.#meta(row), body: row.programmes };
  }

  async write(key: ChannelDayKey, body: Uint8Array, meta: StoredEntryMeta): Promise<void> {
    this.#signal?.throwIfAborted();

    // One statement, so a row is either the whole entry or the one that was
    // there before it — the promise the filesystem driver keeps with an atomic
    // rename, kept here by the database.
    this.#prepared(
      'write',
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
      // Bound as the bytes they are: SQLite copies them in, where a string
      // would be encoded on the way — 0.55ms against 4.4 for a wide day.
      body,
    );
  }

  async delete(key: ChannelDayKey): Promise<void> {
    this.#signal?.throwIfAborted();

    // On what is there: nothing is made to delete from.
    this.#prepared('change', `DELETE FROM entries ${BY_KEY}`)?.run(
      key.site,
      key.channelId,
      key.day,
    );
  }

  async readState(site: string, key: string): Promise<FoundState | undefined> {
    this.#signal?.throwIfAborted();

    const row = this.#prepared(
      'read',
      `SELECT ${STATE_COLUMNS} FROM state WHERE site = ? AND key = ?`,
    )?.get(site, key) as StateRow | undefined;

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
      'write',
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

    // On what is there: nothing is made to delete from.
    this.#prepared('change', 'DELETE FROM state WHERE site = ? AND key = ?')?.run(site, key);
  }

  /**
   * The entries, a page at a time in the order of `entries_key` — which
   * answers each page without touching a payload — and then the groups.
   *
   * Pages rather than one statement stepped through as its keys are handed
   * out: a statement still being stepped holds the connection's read open, and
   * a caller that wrote as it went — deleting what it was handed, say — would
   * have its writes left uncommitted, and the write lock held against every
   * other process, until the listing ended. Each page is read whole before a
   * key of it is handed out, so nothing is held across a yield, and a listing
   * of 70,000 is never held at once either.
   */
  async *list(options: CacheListOptions = {}): AsyncIterable<CachedKey> {
    this.#signal?.throwIfAborted();

    const { site, channelId, kind } = options;
    const narrowed = [
      ...(site === undefined ? [] : [site]),
      ...(channelId === undefined ? [] : [channelId]),
    ];

    if (kind !== 'state') {
      let after: { site: string; channel: string; day: string } | undefined;

      do {
        const page = (this.#prepared(
          'read',
          `SELECT site, channel, day FROM entries${this.#where(site, channelId, after !== undefined)}
           ORDER BY site, channel, day LIMIT ${LIST_PAGE}`,
        )?.all(
          ...narrowed,
          ...(after === undefined ? [] : [after.site, after.channel, after.day]),
        ) ?? []) as unknown as Array<{ site: string; channel: string; day: string }>;

        for (const row of page) {
          yield { kind: 'entry', key: { site: row.site, channelId: row.channel, day: row.day } };
        }

        this.#signal?.throwIfAborted();
        after = page.length === LIST_PAGE ? page.at(-1) : undefined;
      } while (after !== undefined);
    }

    // A channel's entries are all a channel has: state is a site's. A site's
    // groups are a handful, and read at once.
    if (kind !== 'entry' && channelId === undefined) {
      const groups = (this.#prepared(
        'read',
        `SELECT site, key FROM state${this.#where(site)}`,
      )?.all(...narrowed) ?? []) as unknown as Array<{ site: string; key: string }>;

      for (const row of groups) {
        yield { kind: 'state', site: row.site, key: row.key };
      }
    }
  }

  /**
   * What narrows a listing, as SQL — its parameters given in the same order —
   * and, for a page after the first, where the last one ended.
   */
  #where(site: string | undefined, channelId?: string, after = false): string {
    const said = [
      ...(site === undefined ? [] : ['site = ?']),
      ...(channelId === undefined ? [] : ['channel = ?']),
      ...(after ? ['(site, channel, day) > (?, ?, ?)'] : []),
    ];

    return said.length === 0 ? '' : ` WHERE ${said.join(' AND ')}`;
  }

  async prune(options: { before: string }): Promise<number> {
    this.#signal?.throwIfAborted();

    // The whole prune in one statement the database plans itself: no directory
    // walk, nothing to do a few at a time, and nothing to stop half way — which
    // is why this is the one method whose signal is only asked at the start. On
    // what is there, as a delete is.
    return Number(
      this.#prepared('change', 'DELETE FROM entries WHERE day < ?')?.run(options.before).changes ??
        0,
    );
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#statements.clear();
    this.#db?.close();
    this.#db = undefined;
  }

  /** The same as {@link close}, for `await using`. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}

import { closeSync, constants, openSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { triggerActivity } from './inspection.js';
import {
  canonicalHuddleJson,
  huddleLedgerIdentitySchema,
  type HuddleLedgerIdentity,
  type HuddleJson,
  type RuntimeIdentity,
} from '@puddle/shared';
import { privatePath, syncPrivateDirectory } from '@puddle/shared/node';
import { runtimeDirectory } from '../../ownership/storage.js';
import { acquireHostClaim } from '../../../security/claims.js';

export const HUDDLE_STATE_LIMITS = {
  bytes: 64 * 1024 * 1024,
  records: 16_384,
  page: 256,
  pageBytes: 1024 * 1024,
} as const;
export interface LedgerRow {
  ordinal: number;
  id: string;
  body: string;
  state: string;
  parent: string;
  reserved: number;
}
interface Reservation {
  bytes?: number;
  records?: number;
  subject?: string;
}
interface RecordFilter {
  parent?: string;
  subject?: string;
  state?: string;
  after?: number;
}
export type HuddleCollection =
  | 'intervals'
  | 'schedules'
  | 'filetrees'
  | 'git-sources'
  | 'session-sources'
  | 'completion-sources'
  | 'native-completions'
  | 'custom-sources'
  | 'inbox'
  | 'cursors'
  | 'executions'
  | 'budgets'
  | 'invocations'
  | 'activations'
  | 'joins'
  | 'execution-inputs'
  | 'graph-starts'
  | 'revision-activations'
  | 'control'
  | 'operations'
  | 'operation-origins'
  | 'spawn-cleanup'
  | 'emissions';

/** One private writer, with transactions covering data, cursors and outcome reservations. */
export class HuddleStateDatabase {
  private readonly db: Database.Database;
  private readonly claim: { release(): void };
  private closed = false;
  readonly identity: HuddleLedgerIdentity;
  private readonly limits: { bytes: number; records: number };

  constructor(
    home: string,
    identity: HuddleLedgerIdentity,
    limits: Partial<{ bytes: number; records: number }> = {},
    readonly originOwners: readonly RuntimeIdentity[] = [],
  ) {
    this.identity = huddleLedgerIdentitySchema.parse(identity);
    this.limits = {
      bytes: Math.min(limits.bytes ?? HUDDLE_STATE_LIMITS.bytes, HUDDLE_STATE_LIMITS.bytes),
      records: Math.min(limits.records ?? HUDDLE_STATE_LIMITS.records, HUDDLE_STATE_LIMITS.records),
    };
    if (
      !Number.isSafeInteger(this.limits.bytes) ||
      this.limits.bytes < 1024 ||
      !Number.isSafeInteger(this.limits.records) ||
      this.limits.records < 1
    )
      throw new Error('Invalid huddle state limits');
    const directory = runtimeDirectory(home, identity.runtimeId);
    this.claim = acquireHostClaim(home, `huddle-state:${identity.runtimeId}`);
    let db: Database.Database | undefined;
    try {
      const file = join(directory, 'huddle.sqlite');
      try {
        closeSync(
          openSync(
            file,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o600,
          ),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      privatePath(file);
      for (const suffix of ['-wal', '-shm', '-journal']) {
        try {
          privatePath(file + suffix);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      db = new Database(file, { timeout: 0 });
      const version = db.pragma('user_version', { simple: true });
      if (version !== 0 && version !== 1) throw new Error('Unsupported huddle ledger version');
      const encodedIdentity = canonicalHuddleJson(this.identity);
      if (version === 1) {
        const existing = db.prepare('SELECT value FROM metadata WHERE key = ?').get('identity') as
          { value: string } | undefined;
        if (!existing || existing.value !== encodedIdentity)
          throw new Error('Huddle ledger identity changed');
      }
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = FULL');
      db.pragma('foreign_keys = ON');
      if (version === 0) {
        db.transaction(() => {
          db!.exec(`CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE records (
              ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
              collection TEXT NOT NULL, id TEXT NOT NULL, parent TEXT NOT NULL,
              state TEXT NOT NULL, body TEXT NOT NULL, bytes INTEGER NOT NULL,
              reserved INTEGER NOT NULL DEFAULT 0, reserved_records INTEGER NOT NULL DEFAULT 0,
              subject TEXT NOT NULL DEFAULT '',
              UNIQUE(collection, id)
            );
            CREATE INDEX records_parent ON records(collection, parent, ordinal);
            CREATE INDEX records_subject ON records(collection, subject, state);
            CREATE INDEX records_state ON records(collection, state, ordinal);`);
          db!
            .prepare('INSERT INTO metadata (key, value) VALUES (?, ?)')
            .run('identity', encodedIdentity);
          db!.pragma('user_version = 1');
        })();
        syncPrivateDirectory(directory);
      }
      this.db = db;
    } catch (error) {
      db?.close();
      this.claim.release();
      throw error;
    }
  }

  atomic<T>(work: () => T): T {
    if (this.closed) throw new Error('Huddle ledger is closed');
    return this.db.transaction(() => {
      const result = work();
      if (result !== null && typeof result === 'object' && 'then' in result)
        throw new Error('Huddle transactions must be synchronous');
      return result;
    })();
  }

  get(collection: HuddleCollection, id: string): LedgerRow | undefined {
    return this.db
      .prepare(
        'SELECT ordinal, id, parent, state, body, reserved FROM records WHERE collection = ? AND id = ?',
      )
      .get(collection, id) as LedgerRow | undefined;
  }

  put(
    collection: HuddleCollection,
    id: string,
    parent: string,
    state: string,
    value: unknown,
    reservation: Reservation = {},
  ): void {
    if (!this.db.inTransaction) throw new Error('Huddle state writes require a transaction');
    const reserved = reservation.bytes ?? 0;
    const reservedRecords = reservation.records ?? 0;
    if (![reserved, reservedRecords].every((value) => Number.isSafeInteger(value) && value >= 0))
      throw new Error('Invalid huddle reservation');
    const body = JSON.stringify(value);
    const bytes = Buffer.byteLength(body) + Buffer.byteLength(id) + Buffer.byteLength(parent) + 256;
    if (bytes > HUDDLE_STATE_LIMITS.pageBytes)
      throw new Error('Huddle state record exceeds its byte limit');
    this.db
      .prepare(
        `INSERT INTO records(collection, id, parent, state, body, bytes, reserved, reserved_records, subject)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(collection, id) DO UPDATE SET
      parent = excluded.parent, state = excluded.state, body = excluded.body,
      bytes = excluded.bytes, reserved = excluded.reserved, reserved_records = excluded.reserved_records,
      subject = excluded.subject`,
      )
      .run(
        collection,
        id,
        parent,
        state,
        body,
        bytes,
        reserved,
        reservedRecords,
        reservation.subject ?? '',
      );
    const usage = this.usage();
    if (usage.records > this.limits.records || usage.bytes > this.limits.bytes)
      throw new Error('Huddle retained state capacity exceeded');
  }

  list(collection: HuddleCollection, filter: RecordFilter = {}): LedgerRow[] {
    const after = filter.after ?? 0;
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid huddle state cursor');
    const candidates = this.db
      .prepare(
        `SELECT id, bytes FROM records
      WHERE collection = ? AND ordinal > ? AND (? IS NULL OR parent = ?)
      AND (? IS NULL OR state = ?) AND (? IS NULL OR subject = ?) ORDER BY ordinal LIMIT ?`,
      )
      .all(
        collection,
        after,
        filter.parent ?? null,
        filter.parent ?? null,
        filter.state ?? null,
        filter.state ?? null,
        filter.subject ?? null,
        filter.subject ?? null,
        HUDDLE_STATE_LIMITS.page,
      ) as Array<{ id: string; bytes: number }>;
    const rows: LedgerRow[] = [];
    let bytes = 0;
    for (const candidate of candidates) {
      if (bytes + candidate.bytes > HUDDLE_STATE_LIMITS.pageBytes) break;
      rows.push(this.get(collection, candidate.id)!);
      bytes += candidate.bytes;
    }
    return rows;
  }

  usage(): { records: number; bytes: number } {
    return this.db
      .prepare(
        'SELECT COUNT(*) + COALESCE(SUM(reserved_records), 0) AS records, COALESCE(SUM(bytes + reserved), 0) AS bytes FROM records',
      )
      .get() as { records: number; bytes: number };
  }

  count(collection: HuddleCollection, filter: RecordFilter = {}): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM records WHERE collection = ?
      AND (? IS NULL OR parent = ?) AND (? IS NULL OR state = ?) AND (? IS NULL OR subject = ?)`,
        )
        .get(
          collection,
          filter.parent ?? null,
          filter.parent ?? null,
          filter.state ?? null,
          filter.state ?? null,
          filter.subject ?? null,
          filter.subject ?? null,
        ) as { count: number }
    ).count;
  }

  triggerActivity(activationId: string | null) {
    return triggerActivity(this.db, activationId);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } finally {
      this.claim.release();
    }
  }
}

export const stateJson = (value: unknown): HuddleJson =>
  JSON.parse(JSON.stringify(value)) as HuddleJson;

import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { runtimeIdentitySchema, type RuntimeIdentity } from '@puddle/shared';
import { privatePath, syncPrivateDirectory } from '@puddle/shared/node';
import { acquireHostClaim } from '../../../security/claims.js';
import type { RuntimeRetirementClaims } from '../../ownership/retirement-claims.js';
import { retiredGrantProof } from './retirement-proof.js';
import {
  HOST_MEMORY_LEDGER_BYTES,
  createMemoryFile,
  memoryFile,
  memoryIo,
  memoryPaths,
  optionalMemoryFile,
  readMemorySeal,
  requireMemorySidecars,
  requireNoRuntimeLaunches,
  writeMemorySeal,
  type HostMemoryPaths,
  type HostMemorySeal,
} from './storage.js';

/** A bounded ledger, not a lifetime runtime limit: retirement must reclaim exact ended rows. */
export const HOST_MEMORY_GRANT_ROWS = 16_384;
export type HostMemoryIdentity = Pick<RuntimeIdentity, 'runtime_id' | 'incarnation' | 'launch_id'>;
export interface HostMemoryGrant {
  revision: number;
  bytes: number;
}
interface GrantRow extends HostMemoryGrant {
  incarnation: string;
  launch_id: string;
}
interface Header {
  instance: string;
  capacity: number;
  total: number;
  owners: number;
}
const identitySchema = runtimeIdentitySchema.pick({
  runtime_id: true,
  incarnation: true,
  launch_id: true,
});
const schema = [
  `CREATE TABLE host_memory (singleton INTEGER PRIMARY KEY CHECK(singleton=1), instance TEXT NOT NULL, capacity INTEGER NOT NULL CHECK(capacity>0), total INTEGER NOT NULL CHECK(total>=0 AND total<=capacity), owners INTEGER NOT NULL CHECK(owners>=0 AND owners<=16384))`,
  `CREATE TABLE grants (runtime_id TEXT PRIMARY KEY, incarnation TEXT NOT NULL, launch_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), bytes INTEGER NOT NULL CHECK(bytes>=0)) WITHOUT ROWID`,
  `CREATE TRIGGER grant_insert AFTER INSERT ON grants BEGIN UPDATE host_memory SET total=total+NEW.bytes, owners=owners+1 WHERE singleton=1; END`,
  `CREATE TRIGGER grant_update AFTER UPDATE ON grants BEGIN UPDATE host_memory SET total=total+NEW.bytes-OLD.bytes WHERE singleton=1; END`,
  `CREATE TRIGGER grant_delete AFTER DELETE ON grants BEGIN UPDATE host_memory SET total=total-OLD.bytes, owners=owners-1 WHERE singleton=1; END`,
];
const normalise = (sql: string) => sql.replace(/\s+/g, ' ').trim().replace(/;$/, '');
const validInteger = (value: number) => Number.isSafeInteger(value) && value >= 0;

/**
 * Private runtime allowance ledger, independent of application SQLite/migrations.
 * First open must precede acquisition of the daemon controller: initialisation
 * acquires that existing claim as well as the dedicated creation claim. Sealed
 * opens never need the controller claim and work while the daemon is absent.
 */
export class HostMemoryLedger {
  readonly instanceId: string;
  readonly capacityBytes: number;
  private closed = false;

  private constructor(
    private readonly paths: HostMemoryPaths,
    private readonly db: Database.Database,
    private readonly seal: HostMemorySeal,
  ) {
    this.instanceId = seal.instance;
    this.capacityBytes = seal.capacity;
  }

  static open(home: string, capacityBytes: number): HostMemoryLedger {
    if (!validInteger(capacityBytes) || capacityBytes === 0)
      throw new Error('Invalid host memory capacity');
    return this.openKnown(home, capacityBytes, true)!;
  }

  /** Bootstrap policy applies only before the permanent host capacity is sealed. */
  static initialise(home: string, initialCapacity: number): HostMemoryLedger {
    if (!validInteger(initialCapacity) || initialCapacity === 0)
      throw new Error('Invalid host memory capacity');
    return this.openKnown(home, undefined, true, initialCapacity)!;
  }

  /** Never creates a directory, database or seal. Established capacity remains authoritative. */
  static openExisting(home: string): HostMemoryLedger | null {
    return this.openKnown(home, undefined, false);
  }

  private static openKnown(
    home: string,
    requestedCapacity: number | undefined,
    create: boolean,
    initialCapacity?: number,
  ): HostMemoryLedger | null {
    const paths = memoryIo(home, () => memoryPaths(home, create));
    if (!paths) return null;
    let claim: ReturnType<typeof acquireHostClaim> | undefined;
    let controller: ReturnType<typeof acquireHostClaim> | undefined;
    let db: Database.Database | undefined;
    try {
      let seal = memoryIo(home, () => readMemorySeal(paths));
      if (!seal) {
        if (!create) {
          if (optionalMemoryFile(paths.database, HOST_MEMORY_LEDGER_BYTES))
            throw new Error('Host memory ledger exists without an initialisation seal');
          return null;
        }
        claim = memoryIo(home, () => acquireHostClaim(home, 'host-memory-ledger-initialisation'));
        seal = memoryIo(home, () => readMemorySeal(paths));
      }
      let file = memoryIo(home, () => optionalMemoryFile(paths.database, HOST_MEMORY_LEDGER_BYTES));
      const capacityBytes = requestedCapacity ?? seal?.capacity ?? initialCapacity;
      if (capacityBytes === undefined)
        throw new Error('Host memory ledger capacity is unavailable');
      if (seal && !file) throw new Error('Sealed host memory ledger is missing');
      if (
        seal &&
        (seal.capacity !== capacityBytes || seal.device !== file!.dev || seal.inode !== file!.ino)
      )
        throw new Error('Host memory ledger seal changed');
      if (!seal) {
        controller = memoryIo(home, () => acquireHostClaim(home, 'daemon-controller'));
        memoryIo(home, () => requireNoRuntimeLaunches(home));
        if (!file) {
          memoryIo(home, () => createMemoryFile(paths.database));
          file = memoryFile(paths.database, HOST_MEMORY_LEDGER_BYTES);
        }
      }
      requireMemorySidecars(paths);
      db = new Database(paths.database, { timeout: 0, fileMustExist: true });
      db.pragma('busy_timeout=0');
      db.pragma('cache_size=-64');
      const version = db.pragma('user_version', { simple: true });
      if (version === 0 && !seal) {
        const count = db.prepare('SELECT COUNT(*) AS n FROM sqlite_schema').get() as { n: number };
        if (count.n !== 0) throw new Error('Unknown incomplete host memory ledger');
        db.pragma('page_size=4096');
        db.pragma('journal_mode=DELETE');
        db.pragma('synchronous=FULL');
        db.transaction(() => {
          for (const sql of schema) db!.exec(sql);
          db!
            .prepare('INSERT INTO host_memory VALUES (1, ?, ?, 0, 0)')
            .run(randomUUID(), capacityBytes);
          db!.pragma('user_version=1');
        }).immediate();
      } else if (version !== 1) throw new Error('Unsupported host memory ledger format');
      if (
        db.pragma('page_size', { simple: true }) !== 4096 ||
        db.pragma('journal_mode', { simple: true }) !== 'delete'
      )
        throw new Error('Unsupported host memory ledger storage mode');
      db.pragma('synchronous=FULL');
      const actualSchema = db
        .prepare(
          "SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 16",
        )
        .all() as Array<{ sql: string }>;
      if (
        JSON.stringify(actualSchema.map((row) => normalise(row.sql)).sort()) !==
        JSON.stringify(schema.map(normalise).sort())
      )
        throw new Error('Host memory ledger schema changed');
      const header = db.transaction(() => {
        const header = readHeader(db!, capacityBytes);
        const count = db!
          .prepare(
            `SELECT COUNT(*) AS n FROM (SELECT 1 FROM grants LIMIT ${HOST_MEMORY_GRANT_ROWS + 1})`,
          )
          .get() as { n: number };
        if (count.n > HOST_MEMORY_GRANT_ROWS || count.n !== header.owners)
          throw new Error('Host memory ledger owner count changed');
        const total = db!.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM grants').get() as {
          bytes: number;
        };
        if (!validInteger(total.bytes) || total.bytes !== header.total)
          throw new Error('Host memory ledger total changed');
        return header;
      })();
      if (!seal) {
        if (header.owners !== 0)
          throw new Error('Host memory grants exist without an initialisation seal');
        memoryIo(home, () => requireNoRuntimeLaunches(home));
        const stat = memoryFile(paths.database, HOST_MEMORY_LEDGER_BYTES);
        if (stat.dev !== file!.dev || stat.ino !== file!.ino)
          throw new Error('Host memory ledger inode changed');
        seal = {
          format: 1,
          instance: header.instance,
          capacity: header.capacity,
          device: stat.dev,
          inode: stat.ino,
        };
        const initialSeal = seal;
        memoryIo(home, () => writeMemorySeal(paths, initialSeal));
      }
      const ledger = new HostMemoryLedger(paths, db, seal);
      ledger.requireCurrent();
      if (header.instance !== seal.instance || header.capacity !== seal.capacity)
        throw new Error('Host memory ledger seal changed');
      // A previous publication may have succeeded before directory fsync failed.
      // Confirm both permanent entries are durable before this connection grants.
      memoryIo(home, () => syncPrivateDirectory(paths.directory));
      return ledger;
    } catch (error) {
      db?.close();
      throw error;
    } finally {
      try {
        controller?.release();
      } finally {
        claim?.release();
      }
    }
  }

  readGrant(identity: HostMemoryIdentity): HostMemoryGrant | null {
    const exact = identitySchema.parse(identity);
    this.requireCurrent();
    const row = this.db
      .prepare('SELECT incarnation,launch_id,revision,bytes FROM grants WHERE runtime_id=?')
      .get(exact.runtime_id) as GrantRow | undefined;
    this.requireCurrent();
    return row ? this.exactGrant(exact, row) : null;
  }

  /** Absolute compare-and-set only. An uncertain commit is observed by readGrant, never retried here. */
  compareGrant(
    identity: HostMemoryIdentity,
    expectedRevision: number,
    nextBytes: number,
  ): HostMemoryGrant | null {
    const exact = identitySchema.parse(identity);
    if (
      !validInteger(expectedRevision) ||
      expectedRevision === Number.MAX_SAFE_INTEGER ||
      !validInteger(nextBytes)
    )
      throw new Error('Invalid host memory grant');
    this.requireCurrent();
    const result = this.db
      .transaction(() => {
        this.requireCurrent();
        const header = readHeader(this.db, this.capacityBytes);
        if (header.instance !== this.instanceId)
          throw new Error('Host memory ledger instance changed');
        const raw = this.db
          .prepare('SELECT incarnation,launch_id,revision,bytes FROM grants WHERE runtime_id=?')
          .get(exact.runtime_id) as GrantRow | undefined;
        const previous = raw ? this.exactGrant(exact, raw) : null;
        if ((previous?.revision ?? 0) !== expectedRevision) return null;
        if (!previous && header.owners === HOST_MEMORY_GRANT_ROWS) return null;
        if (nextBytes - (previous?.bytes ?? 0) > this.capacityBytes - header.total) return null;
        const next = { revision: expectedRevision + 1, bytes: nextBytes };
        if (previous)
          this.db
            .prepare('UPDATE grants SET revision=?,bytes=? WHERE runtime_id=?')
            .run(next.revision, next.bytes, exact.runtime_id);
        else
          this.db
            .prepare('INSERT INTO grants VALUES (?,?,?,?,?)')
            .run(exact.runtime_id, exact.incarnation, exact.launch_id, next.revision, next.bytes);
        const after = readHeader(this.db, this.capacityBytes);
        if (
          after.total !== header.total - (previous?.bytes ?? 0) + nextBytes ||
          after.owners !== header.owners + (previous ? 0 : 1)
        )
          throw new Error('Host memory grant accounting changed');
        this.requireCurrent();
        return next;
      })
      .immediate();
    this.requireCurrent();
    return result;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  /** Exact process-lifetime exclusion plus a durable launch fence; never age or PID inference. */
  retireGrant(identity: RuntimeIdentity, claims: RuntimeRetirementClaims): boolean {
    this.requireCurrent();
    claims.requireCurrent(this.paths.home, identity.runtime_id);
    const previous = this.readGrant(identity);
    if (!previous) return false;
    const requireRetired = retiredGrantProof(this.paths.home, identity, claims);
    const removed = this.db
      .transaction(() => {
        this.requireCurrent();
        requireRetired();
        const current = this.readGrant(identity);
        if (!current || current.revision !== previous.revision || current.bytes !== previous.bytes)
          throw new Error('Runtime memory grant changed during retirement');
        const before = readHeader(this.db, this.capacityBytes);
        this.db
          .prepare(
            'DELETE FROM grants WHERE runtime_id=? AND incarnation=? AND launch_id=? AND revision=?',
          )
          .run(identity.runtime_id, identity.incarnation, identity.launch_id, current.revision);
        const after = readHeader(this.db, this.capacityBytes);
        if (after.total !== before.total - current.bytes || after.owners !== before.owners - 1)
          throw new Error('Runtime memory retirement accounting changed');
        requireRetired();
        this.requireCurrent();
        return true;
      })
      .immediate();
    this.requireCurrent();
    return removed;
  }

  requireEmpty(): void {
    this.requireCurrent();
    const header = readHeader(this.db, this.capacityBytes);
    if (
      header.owners !== 0 ||
      header.total !== 0 ||
      this.db.prepare('SELECT 1 FROM grants LIMIT 1').get()
    )
      throw new Error(
        'Runtime memory grants must retire before their supporting records are purged',
      );
    this.requireCurrent();
  }

  private exactGrant(identity: HostMemoryIdentity, row: GrantRow): HostMemoryGrant {
    if (row.incarnation !== identity.incarnation || row.launch_id !== identity.launch_id)
      throw new Error('Host memory grant identity changed');
    if (
      !validInteger(row.revision) ||
      row.revision === 0 ||
      !validInteger(row.bytes) ||
      row.bytes > this.capacityBytes
    )
      throw new Error('Invalid recorded host memory grant');
    return { revision: row.revision, bytes: row.bytes };
  }

  private requireCurrent(): void {
    if (this.closed) throw new Error('Host memory ledger is closed');
    memoryIo(this.paths.home, () => {
      privatePath(this.paths.home, true);
      privatePath(this.paths.directory, true);
      const stat = memoryFile(this.paths.database, HOST_MEMORY_LEDGER_BYTES);
      if (
        stat.dev !== this.seal.device ||
        stat.ino !== this.seal.inode ||
        JSON.stringify(readMemorySeal(this.paths)) !== JSON.stringify(this.seal)
      )
        throw new Error('Host memory ledger identity changed');
      requireMemorySidecars(this.paths);
    });
  }
}

function readHeader(db: Database.Database, capacity: number): Header {
  const rows = db
    .prepare('SELECT instance,capacity,total,owners FROM host_memory LIMIT 2')
    .all() as Header[];
  const header = rows[0];
  if (
    rows.length !== 1 ||
    !header ||
    !/^[a-f0-9-]{36}$/.test(header.instance) ||
    header.capacity !== capacity ||
    !validInteger(header.total) ||
    header.total > capacity ||
    !validInteger(header.owners) ||
    header.owners > HOST_MEMORY_GRANT_ROWS
  )
    throw new Error('Invalid host memory ledger header');
  return header;
}

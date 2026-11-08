import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  mkdtempSync,
  rmSync,
  writeSync,
  type BigIntStats,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import {
  canonicalHuddleJson,
  huddleLedgerIdentitySchema,
  type HuddleLedgerIdentity,
} from '@puddle/shared';
import { privatePath } from '@puddle/shared/node';

// The logical ledger is capped at 64 MiB; allow bounded SQLite/index/free-page
// overhead too. Never allocate using an unchecked file size or stored row length.
export const HUDDLE_READER_LIMITS = {
  databaseBytes: 128 * 1024 * 1024,
  walBytes: 256 * 1024 * 1024,
} as const;

/** Observation must not create a missing runtime directory or migrate its permissions. */
export function retainedHuddleDirectory(home: string, runtimeId: string): string {
  huddleLedgerIdentitySchema.shape.runtimeId.parse(runtimeId);
  privatePath(home, true);
  const root = join(home, 'runtimes');
  privatePath(root, true);
  const directory = join(root, runtimeId);
  privatePath(directory, true);
  return directory;
}
function inspect(file: string, max: number): BigIntStats {
  privatePath(file);
  const stat = lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.size > BigInt(max))
    throw new Error('Retained huddle file exceeds its limit');
  return stat;
}
function optional(file: string, max: number): BigIntStats | null {
  try {
    return inspect(file, max);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}
function noSidecars(file: string): void {
  for (const suffix of ['-wal', '-shm', '-journal'])
    if (optional(file + suffix, HUDDLE_READER_LIMITS.walBytes))
      throw new Error('Retained huddle ledger changed during inspection');
}
function closedSnapshot(file: string, stat: BigIntStats): Buffer {
  noSidecars(file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!sameFile(stat, fstatSync(fd, { bigint: true })))
      throw new Error('Retained huddle file changed');
    const bytes = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error('Retained huddle file was truncated');
      offset += count;
    }
    if (
      !sameFile(stat, fstatSync(fd, { bigint: true })) ||
      !sameFile(stat, inspect(file, HUDDLE_READER_LIMITS.databaseBytes))
    )
      throw new Error('Retained huddle file changed during inspection');
    noSidecars(file);
    if (bytes.length < 100 || bytes.subarray(0, 16).toString('ascii') !== 'SQLite format 3\0')
      throw new Error('Invalid retained huddle database');
    // SQLite documents this conversion for deserialize: only the private copy's
    // journal-mode header changes. The source has no WAL to omit and is never opened
    // by SQLite (even a readonly open would create WAL/SHM files beside it).
    // https://www.sqlite.org/c3ref/deserialize.html
    bytes[18] = 1;
    bytes[19] = 1;
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/** Copy only checked bytes; a concurrent append/checkpoint invalidates the snapshot. */
function copyFile(source: string, destination: string, stat: BigIntStats): void {
  const input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let output: number | undefined;
  try {
    if (!sameFile(stat, fstatSync(input, { bigint: true })))
      throw new Error('Retained huddle file changed');
    output = openSync(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    const buffer = Buffer.alloc(64 * 1024);
    let offset = 0;
    while (offset < Number(stat.size)) {
      const count = readSync(
        input,
        buffer,
        0,
        Math.min(buffer.length, Number(stat.size) - offset),
        offset,
      );
      if (!count) throw new Error('Retained huddle file was truncated');
      let written = 0;
      while (written < count) {
        const countWritten = writeSync(output, buffer, written, count - written);
        if (!countWritten) throw new Error('Retained huddle snapshot write made no progress');
        written += countWritten;
      }
      offset += count;
    }
    if (!sameFile(stat, fstatSync(input, { bigint: true })))
      throw new Error('Retained huddle file changed');
  } finally {
    if (output !== undefined) closeSync(output);
    closeSync(input);
  }
}

/** One bounded SQLite read transaction, without a writer claim, migration or owner recovery. */
export function withHuddleReadSnapshot<T>(
  home: string,
  raw: HuddleLedgerIdentity,
  read: (db: Database.Database) => T,
): T {
  const identity = huddleLedgerIdentitySchema.parse(raw);
  const file = join(retainedHuddleDirectory(home, identity.runtimeId), 'huddle.sqlite');
  const stat = inspect(file, HUDDLE_READER_LIMITS.databaseBytes);
  const wal = optional(file + '-wal', HUDDLE_READER_LIMITS.walBytes);
  const shm = optional(file + '-shm', HUDDLE_READER_LIMITS.databaseBytes);
  if ((!wal && shm) || optional(file + '-journal', HUDDLE_READER_LIMITS.walBytes))
    throw new Error('Retained huddle ledger needs unavailable coordination or recovery');
  let scratch: string | undefined;
  let db: Database.Database | undefined;
  const unchanged = () => {
    if (!sameFile(stat, inspect(file, HUDDLE_READER_LIMITS.databaseBytes)))
      throw new Error('Retained huddle file changed during inspection');
    const afterWal = optional(file + '-wal', HUDDLE_READER_LIMITS.walBytes);
    if (wal ? !afterWal || !sameFile(wal, afterWal) : !!afterWal)
      throw new Error('Retained huddle WAL changed during inspection');
    if (optional(file + '-journal', HUDDLE_READER_LIMITS.walBytes))
      throw new Error('Retained huddle ledger changed during inspection');
  };
  try {
    if (wal) {
      // Never open the original with SQLite: its final writer can close between
      // our checks and sqlite3_open, causing even a readonly connection to create
      // WAL/SHM files. Read a stable bounded main+WAL copy instead. SHM is an index,
      // not authoritative state; SQLite regenerates it only in this private scratch.
      scratch = mkdtempSync(join(tmpdir(), 'puddle-huddle-history-'));
      const copy = join(scratch, 'huddle.sqlite');
      copyFile(file, copy, stat);
      copyFile(file + '-wal', copy + '-wal', wal);
      unchanged();
      db = new Database(copy, { readonly: true, fileMustExist: true, timeout: 0 });
    } else {
      db = new Database(closedSnapshot(file, stat), { readonly: true, timeout: 0 });
    }
    db.pragma('query_only = ON');
    db.pragma('trusted_schema = OFF');
    db.exec('BEGIN');
    if (db.pragma('user_version', { simple: true }) !== 1)
      throw new Error('Unsupported retained huddle ledger');
    const stored = db
      .prepare(
        "SELECT CASE WHEN typeof(value) = 'text' AND length(CAST(value AS BLOB)) <= 4096 THEN value ELSE NULL END AS value FROM metadata WHERE key = 'identity'",
      )
      .get() as { value: string | null } | undefined;
    if (stored?.value !== canonicalHuddleJson(identity))
      throw new Error('Retained huddle scope differs from its binding');
    const result = read(db);
    unchanged();
    if (!wal) noSidecars(file);
    return result;
  } finally {
    try {
      db?.close();
    } finally {
      if (scratch) rmSync(scratch, { recursive: true, force: true });
    }
  }
}

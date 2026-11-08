import { randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { huddleLedgerFixture, runningHuddleInvocation } from '../../../helpers/huddle/ledger.js';
import { readRetainedHuddleHistory } from '../../../../src/runtime/huddle/state/readers/history.js';
import {
  HUDDLE_READER_LIMITS,
  withHuddleReadSnapshot,
} from '../../../../src/runtime/huddle/state/readers/database.js';

const files = (directory: string) =>
  Object.fromEntries(
    readdirSync(directory).map((name) => {
      const file = join(directory, name);
      const stat = lstatSync(file);
      return [
        name,
        stat.isFile()
          ? { bytes: readFileSync(file), mode: stat.mode, modified: stat.mtimeMs }
          : null,
      ];
    }),
  );
const request = { collection: 'executions' as const, after: 0 };

it.each([false, true])(
  'reads real retained results with closed=%s without changing any source file',
  (closed) => {
    const f = huddleLedgerFixture();
    try {
      const run = runningHuddleInvocation(f);
      f.ledger.invocations.complete(run.invocation.id, { answer: 'retained result' });
      f.ledger.invocations.route(run.invocation.id, 1, () => {});
      f.ledger.executions.finish(run.execution.id, 'completed');
      if (closed) f.ledger.close();
      const directory = join(f.home, 'runtimes', f.identity.runtimeId);
      const before = files(directory);
      const page = readRetainedHuddleHistory(f.home, f.identity, request);
      expect(page.records[0]?.record.state).toBe('completed');
      const nodes = readRetainedHuddleHistory(f.home, f.identity, {
        collection: 'invocations',
        parent: run.execution.id,
        after: 0,
      });
      expect(nodes.records[0]?.record).toMatchObject({ result: { answer: 'retained result' } });
      expect(
        readRetainedHuddleHistory(f.home, f.identity, { ...request, after: page.next }).records,
      ).toEqual([]);
      expect(files(directory)).toEqual(before);
      expect(() =>
        withHuddleReadSnapshot(f.home, f.identity, (db) => db.exec('DELETE FROM records')),
      ).toThrow();
      expect(files(directory)).toEqual(before);
    } finally {
      f.cleanup();
    }
  },
);

it('does not turn recorded running work into completion or mutate its ledger', () => {
  const f = huddleLedgerFixture();
  try {
    const run = runningHuddleInvocation(f);
    f.ledger.close();
    const page = readRetainedHuddleHistory(f.home, f.identity, request);
    expect(page.records[0]?.record).toMatchObject({ id: run.execution.id, state: 'running' });
  } finally {
    f.cleanup();
  }
});

it('does not create a missing home, runtime or ledger', () => {
  const f = huddleLedgerFixture();
  try {
    const missing = join(f.home, 'missing');
    expect(() => readRetainedHuddleHistory(missing, f.identity, request)).toThrow();
    expect(existsSync(missing)).toBe(false);
    const runtimeId = randomUUID();
    expect(() =>
      readRetainedHuddleHistory(f.home, { ...f.identity, runtimeId }, request),
    ).toThrow();
    expect(existsSync(join(f.home, 'runtimes', runtimeId))).toBe(false);
    f.ledger.close();
    const directory = join(f.home, 'runtimes', f.identity.runtimeId);
    rmSync(join(directory, 'huddle.sqlite'));
    const before = files(directory);
    expect(() => readRetainedHuddleHistory(f.home, f.identity, request)).toThrow();
    expect(files(directory)).toEqual(before);
  } finally {
    f.cleanup();
  }
});

it.each([
  'identity',
  'version',
  'row-size',
  'id-size',
  'parent',
  'journal',
  'symlink',
  'physical-size',
] as const)('refuses %s without repair or oversized text materialisation', (mode) => {
  const f = huddleLedgerFixture();
  try {
    const run = runningHuddleInvocation(f);
    f.ledger.close();
    const directory = join(f.home, 'runtimes', f.identity.runtimeId);
    const file = join(directory, 'huddle.sqlite');
    const db = new Database(file);
    const otherExecution = randomUUID();
    if (mode === 'identity')
      db.prepare("UPDATE metadata SET value = '{}' WHERE key = 'identity'").run();
    if (mode === 'version') db.pragma('user_version = 99');
    if (mode === 'row-size')
      db.prepare("UPDATE records SET body = ?, bytes = 1 WHERE collection = 'executions'").run(
        'x'.repeat(1048577),
      );
    if (mode === 'id-size')
      db.prepare("UPDATE records SET id = ? WHERE collection = 'executions'").run('x'.repeat(129));
    if (mode === 'parent')
      db.prepare("UPDATE records SET parent = ? WHERE collection = 'invocations'").run(
        otherExecution,
      );
    db.close();
    if (mode === 'journal') writeFileSync(file + '-journal', '', { mode: 0o600 });
    if (mode === 'symlink') {
      rmSync(file);
      symlinkSync('/dev/null', file);
    }
    if (mode === 'physical-size') truncateSync(file, HUDDLE_READER_LIMITS.databaseBytes + 1);
    if (mode === 'parent') {
      expect(
        readRetainedHuddleHistory(f.home, f.identity, {
          collection: 'invocations',
          parent: run.execution.id,
          after: 0,
        }).records,
      ).toEqual([]);
      expect(() =>
        readRetainedHuddleHistory(f.home, f.identity, {
          collection: 'invocations',
          parent: otherExecution,
          after: 0,
        }),
      ).toThrow();
    } else expect(() => readRetainedHuddleHistory(f.home, f.identity, request)).toThrow();
  } finally {
    f.cleanup();
  }
});

it('refuses a ledger replacement during observation without accepting a mixed result', () => {
  const f = huddleLedgerFixture();
  try {
    f.ledger.close();
    const file = join(f.home, 'runtimes', f.identity.runtimeId, 'huddle.sqlite');
    expect(() =>
      withHuddleReadSnapshot(f.home, f.identity, () => {
        const db = new Database(file);
        db.pragma('user_version = 2');
        db.close();
        return 'stale';
      }),
    ).toThrow('changed');
  } finally {
    f.cleanup();
  }
});

it('reads committed WAL after a crash without recreating the original shared-memory file', () => {
  const f = huddleLedgerFixture();
  try {
    const run = runningHuddleInvocation(f);
    const directory = join(f.home, 'runtimes', f.identity.runtimeId);
    const file = join(directory, 'huddle.sqlite');
    const main = readFileSync(file);
    const wal = readFileSync(file + '-wal');
    f.ledger.close();
    writeFileSync(file, main, { mode: 0o600 });
    writeFileSync(file + '-wal', wal, { mode: 0o600 });
    expect(existsSync(file + '-shm')).toBe(false);
    const before = files(directory);
    const result = readRetainedHuddleHistory(f.home, f.identity, request);
    expect(result.records[0]?.record).toMatchObject({ id: run.execution.id, state: 'running' });
    expect(files(directory)).toEqual(before);
  } finally {
    f.cleanup();
  }
});

it('bounds page text using actual SQL byte lengths rather than retained accounting fields', () => {
  const f = huddleLedgerFixture();
  try {
    const run = runningHuddleInvocation(f);
    f.ledger.invocations.complete(run.invocation.id, { output: 'x'.repeat(200_000) });
    for (let index = 0; index < 5; index++) {
      const node = {
        ...run.invocation,
        id: randomUUID(),
        activation: `activation-${index}`,
        inputs: {},
      };
      f.ledger.invocations.queue(node);
      f.ledger.invocations.start(node.id);
      f.ledger.invocations.complete(node.id, { output: 'x'.repeat(200_000) });
    }
    const db = new Database(join(f.home, 'runtimes', f.identity.runtimeId, 'huddle.sqlite'));
    db.prepare("UPDATE records SET bytes = 1 WHERE collection = 'invocations'").run();
    db.close();
    const query = { collection: 'invocations' as const, after: 0, parent: run.execution.id };
    const first = readRetainedHuddleHistory(f.home, f.identity, query);
    expect(first.records).toHaveLength(5);
    const next = readRetainedHuddleHistory(f.home, f.identity, { ...query, after: first.next });
    expect(next.records).toHaveLength(1);
  } finally {
    f.cleanup();
  }
});

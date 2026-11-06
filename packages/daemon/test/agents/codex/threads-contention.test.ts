import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { codexThread, codexThreadIndex, threadTitle } from '../../../src/agents/codex/threads.js';

it('never stalls the host waiting for a native index writer; the next read recovers', async () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-native-index-lock-'));
  const path = join(home, 'state_5.sqlite');
  const setup = new Database(path);
  setup.exec(`create table threads (id text, cwd text, created_at integer, rollout_path text,
    name text, title text, source text);
    insert into threads values ('synthetic', '/repo', 1, '/synthetic/rollout', 'Saved title', '', 'cli');`);
  setup.close();
  const sqlite = createRequire(import.meta.url).resolve('better-sqlite3');
  const writer = spawn(
    process.execPath,
    [
      '-e',
      `
    const Database = require(${JSON.stringify(sqlite)});
    const db = new Database(process.argv[1]);
    db.exec('begin exclusive');
    process.send('locked');
    process.once('message', () => { db.exec('rollback'); db.close(); process.disconnect(); });
  `,
      path,
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] },
  );
  try {
    await once(writer, 'message');
    for (const read of [
      () => expect(codexThreadIndex(home, '/repo')).toEqual({ available: false, threads: [] }),
      () => expect(codexThread(home, 'synthetic')).toBeNull(),
      () => expect(threadTitle(home, 'synthetic')).toBeNull(),
    ]) {
      const start = performance.now();
      read();
      expect(performance.now() - start).toBeLessThan(250);
    }
    const exited = once(writer, 'exit');
    writer.send('release');
    await exited;
    expect(codexThreadIndex(home, '/repo').threads).toHaveLength(1);
    expect(codexThread(home, 'synthetic')?.id).toBe('synthetic');
    expect(threadTitle(home, 'synthetic')).toBe('Saved title');
  } finally {
    if (writer.exitCode === null && writer.signalCode === null) {
      const exited = once(writer, 'exit');
      writer.kill('SIGKILL');
      await exited;
    }
    rmSync(home, { recursive: true, force: true });
  }
}, 15_000);

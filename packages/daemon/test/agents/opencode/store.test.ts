import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openCodeDatabaseSessions } from '../../../src/agents/opencode/store.js';
import { opencode } from '../../../src/agents/opencode/index.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
it('reads only V2 metadata, preserves fork parents and yields across catalogue pages', async () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-opencode-store-'));
  homes.push(home);
  mkdirSync(join(home, 'data/opencode'), { recursive: true });
  const db = new Database(join(home, 'data/opencode/opencode.db'));
  try {
    db.exec(
      'create table session_v2(id text primary key, directory text, title text, parent_id text, fork_session_id text, time_created integer, time_updated integer)',
    );
    const insert = db.prepare('insert into session_v2 values(?, ?, ?, ?, ?, ?, ?)');
    db.transaction(() => {
      for (let i = 0; i < 300; i++)
        insert.run(
          `ses_${String(i).padStart(3, '0')}`,
          '/work',
          'title',
          null,
          i === 299 ? 'ses_000' : null,
          1000 + i,
          2000 + i,
        );
    })();
    insert.run('ses_child', '/work', 'child', 'ses_000', null, 1000, 2000);
    let yielded = false;
    setImmediate(() => {
      yielded = true;
    });
    const rows = await openCodeDatabaseSessions(home);
    expect(yielded).toBe(true);
    expect(rows).toHaveLength(301);
    expect(rows?.find((row) => row.id === 'ses_299')?.parentRef).toBe('ses_000');
    expect(await openCodeDatabaseSessions(home, { ref: 'ses_299' })).toHaveLength(1);
    const account = { config_dir: home } as never;
    expect(opencode.conversationDiscovery!.watchRoots(account)).toEqual([
      join(home, 'data/opencode'),
    ]);
    const catalogue = await opencode.conversationDiscovery!.discover(account);
    expect(catalogue).toHaveLength(300);
    expect(catalogue.find((row) => row.ref === 'ses_299')?.parentRef).toBe('ses_000');
    expect(await opencode.hasConversation!('ses_child', account)).toBe(false);
    expect(await opencode.hasConversation!('ses_299', account)).toBe(true);
    db.exec('begin exclusive');
    await expect(openCodeDatabaseSessions(home)).rejects.toThrow(/locked/);
    await expect(opencode.conversationDiscovery!.discover(account)).rejects.toThrow(/locked/);
    db.exec('rollback');
    expect(await openCodeDatabaseSessions(home, { ref: 'ses_299' })).toHaveLength(1);
  } finally {
    db.close();
  }
});

it('reads the V1 SQLite catalogue and refuses changed schemas rather than reporting an empty store', async () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-opencode-store-'));
  homes.push(home);
  mkdirSync(join(home, 'data/opencode'), { recursive: true });
  const db = new Database(join(home, 'data/opencode/opencode.db'));
  try {
    db.exec(
      "create table session(id text primary key, directory text, title text, parent_id text, time_created integer, time_updated integer); insert into session values ('ses_old', '/work', 'Saved V1 chat', null, 1000, 2000)",
    );
    expect(await opencode.conversationDiscovery!.discover({ config_dir: home } as never)).toEqual([
      {
        ref: 'ses_old',
        cwd: '/work',
        title: 'Saved V1 chat',
        parentRef: null,
        createdAt: new Date(1000).toISOString(),
        updatedAt: new Date(2000).toISOString(),
      },
    ]);
    db.exec('alter table session rename column directory to moved_directory');
    await expect(
      opencode.conversationDiscovery!.discover({ config_dir: home } as never),
    ).rejects.toThrow(/schema/);
  } finally {
    db.close();
  }
});

import { afterEach, expect, it, vi } from 'vitest';
import {
  appendFile,
  mkdir,
  mkdtemp,
  rename,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeUsage } from '../../../src/agents/claude-code/usage.js';
import { discoverClaudeRef } from '../../../src/agents/claude-code/transcript-files.js';
import { accountRoutes, type AccountRouteDeps } from '../../../src/http/routes/accounts.js';
import {
  emptyUsage,
  recordUsage,
  UsageRecord,
} from '../../../src/agents/claude-code/usage-record.js';

const observed = vi.hoisted(() => ({
  reads: [] as number[],
  afterRead: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args);
      const read = file.read.bind(file);
      file.read = (async (...args: Parameters<typeof read>) => {
        // Production uses the explicit buffer/offset/length/position overload.
        observed.reads.push(args[2] as number);
        const result = await Reflect.apply(read, file, args);
        await observed.afterRead?.();
        return result;
      }) as typeof file.read;
      return file;
    },
  };
});
const homes: string[] = [];
afterEach(async () => {
  observed.reads.length = 0;
  observed.afterRead = undefined;
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'puddle-transcript-io-'));
  homes.push(home);
  const project = join(home, 'projects', 'synthetic');
  await mkdir(project, { recursive: true });
  return { home, project, file: join(project, 'conversation.jsonl') };
}
const row = (tokens: number, text = 'synthetic') =>
  JSON.stringify({
    type: 'assistant',
    message: { content: text, usage: { input_tokens: tokens, output_tokens: 2 } },
  }) + '\n';

it('bounds cwd discovery to prefixes and preserves canonical cwd/newest-match selection', async () => {
  const f = await fixture();
  const worktree = join(f.home, 'worktree');
  await mkdir(worktree);
  const alias = join(f.home, 'alias');
  await symlink(worktree, alias);
  const older = join(f.project, 'older.jsonl');
  await writeFile(older, JSON.stringify({ cwd: await realpath(worktree) }) + '\n');
  await utimes(older, 1, 1);
  await writeFile(
    f.file,
    JSON.stringify({ cwd: await realpath(worktree) }) + '\n' + 'x'.repeat(16 * 1024 * 1024),
  );
  await writeFile(join(f.project, 'other.jsonl'), JSON.stringify({ cwd: '/different' }));
  expect(await discoverClaudeRef(f.home, alias)).toBe('conversation');
  expect(observed.reads).toEqual([16_384, 16_384, 16_384]);
  expect(await discoverClaudeRef(f.home, '/vanished')).toBeNull();
});

it('streams oversized records, yields to timers, and coalesces concurrent scans', async () => {
  const f = await fixture();
  const text = '🙂\\"\n'.repeat(1024 * 1024);
  await writeFile(f.file, row(7, text) + row(11));
  let ticked = false;
  const timer = setTimeout(() => {
    ticked = true;
  }, 0);
  try {
    const first = claudeUsage(f.home);
    const second = claudeUsage(f.home);
    expect(second).toBe(first);
    expect(await first).toEqual({
      ...emptyUsage(),
      input_tokens: 18,
      output_tokens: 4,
      message_count: 2,
    });
    expect(ticked).toBe(true);
    expect(Math.max(...observed.reads)).toBe(64 * 1024);
    observed.reads.length = 0;
    expect(await claudeUsage(f.home)).toMatchObject({ input_tokens: 18 });
    expect(observed.reads).toEqual([]);
  } finally {
    clearTimeout(timer);
  }
}, 20000);

it('invalidates replacement, same-size rewrite, truncation, append and deleted-file observations', async () => {
  const f = await fixture();
  await writeFile(f.file, row(1));
  expect(await claudeUsage(f.home)).toMatchObject({ input_tokens: 1 });
  const before = await stat(f.file);
  const replacement = join(f.project, 'replacement');
  await writeFile(replacement, row(9));
  await utimes(replacement, before.atime, before.mtime);
  await rename(replacement, f.file);
  expect(await claudeUsage(f.home)).toMatchObject({ input_tokens: 9 });
  await writeFile(f.file, row(5));
  await utimes(f.file, before.atime, before.mtime);
  expect(await claudeUsage(f.home)).toMatchObject({ input_tokens: 5 });
  await appendFile(f.file, row(2).slice(0, -5));
  expect(await claudeUsage(f.home)).toMatchObject({ input_tokens: 5, message_count: 1 });
  await appendFile(f.file, row(2).slice(-5));
  expect(await claudeUsage(f.home)).toMatchObject({ input_tokens: 7, message_count: 2 });
  await writeFile(f.file, '');
  expect(await claudeUsage(f.home)).toEqual(emptyUsage());
  await rm(f.file);
  expect(await claudeUsage(f.home)).toBeNull();
});

it('does not cache a file that changes during an observation and recovers after malformed large rows', async () => {
  const f = await fixture();
  await writeFile(f.file, row(3) + '{"payload":"' + 'x'.repeat(128 * 1024) + '\n' + row(5));
  observed.afterRead = async () => {
    observed.afterRead = undefined;
    await appendFile(f.file, row(7));
  };
  expect(await claudeUsage(f.home)).toMatchObject({ input_tokens: 8, message_count: 2 });
  observed.reads.length = 0;
  expect(await claudeUsage(f.home)).toMatchObject({ input_tokens: 15, message_count: 3 });
  expect(observed.reads.length).toBeGreaterThan(0);
});

it.each([
  row(4),
  '{"type":"assistant","message":{"usage":{"input_tokens":3,"input_tokens":null}}}',
  '{"type":"assistant","message":{"usage":{"input_tokens":3}},"message":false}',
  '{"type":"assistant","message":{"usage":{"input_tokens":3}},"type":{}}',
  '{"type":"assistant","message":{"usage":{"input_tokens":3,"input_tokens":{}}}}',
  '{"type":"assistant","message.usage":{"input_tokens":8}}',
  '{"message":{"usage":{"input_tokens":1e3}},"type":"assistant"}',
])('large-record projection matches parsed JSON: %s', async (source) => {
  const record = new UsageRecord();
  try {
    for (let i = 0; i < source.length; i += 3) await record.write(source.slice(i, i + 3));
    expect(await record.finish()).toEqual(recordUsage(JSON.parse(source)));
  } finally {
    record.dispose();
  }
});

it('awaits asynchronous usage at the actual account HTTP boundary', async () => {
  const f = await fixture();
  await writeFile(f.file, row(12));
  const routes = accountRoutes({
    accounts: { get: () => ({ id: 1, agent_type: 'claude-code', logged_in: false }) },
    adapters: { get: () => ({ usageStats: () => claudeUsage(f.home) }) },
    sessions: {
      usageForAccount: () => ({
        session_count: 1,
        active_session_count: 0,
        last_activity_at: null,
      }),
    },
  } as unknown as AccountRouteDeps);
  const response = await routes.request('/1/usage');
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    agent_usage: { input_tokens: 12, message_count: 1 },
  });
});

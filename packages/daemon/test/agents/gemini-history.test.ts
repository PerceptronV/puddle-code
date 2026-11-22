import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import type { Account } from '@puddle/shared';
import { geminiCli } from '../../src/agents/gemini-cli/index.js';

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-gemini-history-'));
  onTestFinished(() => rmSync(home, { recursive: true, force: true }));
  const root = join(home, '.gemini');
  const chats = join(root, 'tmp', 'project', 'chats');
  mkdirSync(chats, { recursive: true });
  writeFileSync(join(root, 'projects.json'), JSON.stringify({ projects: { '/work': 'project' } }));
  const account = { config_dir: home } as Account;
  return { chats, discover: () => geminiCli.conversationDiscovery!.discover(account) };
}

it('omits Gemini metadata-only JSON and JSONL sessions, then discovers their native ids', async () => {
  const { chats, discover } = setup();
  const metadata = {
    sessionId: 'native-id',
    projectHash: 'project',
    startTime: '2026-11-21T00:00:00Z',
  };
  const legacy = join(chats, 'session-timestamp-short.json');
  const current = join(chats, 'session-timestamp-other.jsonl');
  writeFileSync(legacy, JSON.stringify({ ...metadata, messages: [] }));
  writeFileSync(current, JSON.stringify({ ...metadata, sessionId: 'current-id' }) + '\n');
  expect(await discover()).toEqual([]);
  writeFileSync(
    legacy,
    JSON.stringify({ ...metadata, messages: [{ type: 'user', content: 'Hello' }] }),
  );
  writeFileSync(
    current,
    JSON.stringify({ ...metadata, sessionId: 'current-id' }) +
      '\n' +
      JSON.stringify({
        id: 'message',
        type: 'gemini',
        content: '',
        toolCalls: [{ name: 'tool' }],
      }) +
      '\n',
  );
  expect((await discover()).map((row) => row.ref).sort()).toEqual(['current-id', 'native-id']);
});

it('retains unfamiliar or truncated Gemini records instead of declaring them empty', async () => {
  const { chats, discover } = setup();
  writeFileSync(
    join(chats, 'unknown.jsonl'),
    JSON.stringify({ type: 'future-message', content: 'work' }),
  );
  writeFileSync(join(chats, 'partial.json'), '{"sessionId":');
  expect((await discover()).map((row) => row.ref).sort()).toEqual(['partial', 'unknown']);
});

it('retains the full native id for a legacy chat larger than the bounded inspection window', async () => {
  const { chats, discover } = setup();
  writeFileSync(
    join(chats, 'session-short.json'),
    JSON.stringify({
      sessionId: 'full-native-id',
      messages: [{ type: 'user', content: 'x'.repeat(100_000) }],
    }),
  );
  expect(await discover()).toEqual([expect.objectContaining({ ref: 'full-native-id' })]);
});

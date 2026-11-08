import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentNativeTurn } from '@puddle/shared';
import type { LifecycleLaunchContext } from '../../../src/agents/adapter.js';
import { prepareHeadless } from '../../../src/agents/headless/control.js';
import type { HeadlessDriver } from '../../../src/agents/headless/codec.js';
import { claudeDriver } from '../../../src/agents/claude-code/headless.js';
import { codexDriver } from '../../../src/agents/codex/headless.js';
import { geminiDriver } from '../../../src/agents/gemini-cli/headless.js';
import { openCodeDriver } from '../../../src/agents/opencode/headless.js';
import { waitFor } from '../daemon-fixtures.js';

export const headlessCleanups: Array<() => Promise<void>> = [];
export const ref = randomUUID();
export const context: LifecycleLaunchContext = {
  account: {
    id: 1,
    profile_id: '0123456789',
    agent_type: 'fake',
    label: 'test',
    config_dir: '/account',
    logged_in: true,
    skip_permissions_default: false,
    created_at: '',
  },
  opts: { sessionId: ref, worktreePath: '/work', skipPermissions: false },
  args: [],
  signalNonce: randomUUID(),
  signalUrl: 'http://127.0.0.1/agent-signal',
};

export const fixtures = [
  {
    name: 'claude-code',
    driver: claudeDriver,
    records: [
      { type: 'system', subtype: 'init', session_id: ref },
      {
        type: 'assistant',
        parent_tool_use_id: 'child-tool',
        session_id: 'child',
        message: { content: [{ type: 'text', text: 'unrelated child' }] },
      },
      { type: 'result', subtype: 'success', is_error: false, session_id: ref, result: 'answer' },
    ],
  },
  {
    name: 'codex',
    driver: codexDriver,
    records: [
      { type: 'thread.started', thread_id: ref },
      { type: 'item.completed', item: { type: 'reasoning', text: 'private reasoning' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'answer' } },
      { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } },
    ],
  },
  {
    name: 'gemini-cli',
    driver: geminiDriver,
    records: [
      { type: 'init', session_id: ref },
      { type: 'message', role: 'user', content: 'question' },
      { type: 'message', role: 'assistant', content: 'ans', delta: true },
      { type: 'message', role: 'assistant', content: 'wer', delta: true },
      { type: 'result', status: 'success' },
    ],
  },
  {
    name: 'opencode',
    driver: openCodeDriver,
    records: [
      { type: 'step_start', sessionID: ref },
      { type: 'text', sessionID: ref, part: { text: 'I will inspect it' } },
      { type: 'step_finish', sessionID: ref, part: { reason: 'tool-calls' } },
      { type: 'text', sessionID: ref, part: { text: 'answer' } },
      { type: 'step_finish', sessionID: ref, part: { reason: 'stop' } },
    ],
  },
] as const;

export async function bridge(
  records: readonly unknown[],
  code = 0,
  delay = 0,
  native = codexDriver(context),
  before = '',
  overrides: Partial<LifecycleLaunchContext> = {},
) {
  const directory = mkdtempSync(join(tmpdir(), 'pudl-test-'));
  const script = join(directory, 'agent.cjs');
  // Large replies exceed Linux's per-argument limit when embedded in node -e.
  writeFileSync(
    script,
    `
      process.stdin.resume();
      process.stdin.on('end', () => {
        ${before}
        for (const event of ${JSON.stringify(records)}) console.log(JSON.stringify(event));
        setTimeout(() => { process.exitCode = ${code}; }, ${delay});
      });`,
  );
  const bound: string[] = [];
  const events: AgentNativeTurn[] = [];
  const gaps: Array<[string, string]> = [];
  const driver: HeadlessDriver = {
    ...native,
    binary: process.execPath,
    env: { ...native.env, PUDL_TEST: 'isolated' },
    command: () => ({
      args: [script],
      stdin: 'prompt',
    }),
  };
  const resource = await prepareHeadless(
    {
      ...context,
      ...overrides,
      reportNativeTurn: (event) => {
        events.push(event);
        overrides.reportNativeTurn?.(event);
      },
      reportNativeTurnGap: (ref, id) => {
        gaps.push([ref, id]);
        overrides.reportNativeTurnGap?.(ref, id);
      },
      bindConversation: async (value) => {
        await overrides.bindConversation?.(value);
        bound.push(value);
      },
    },
    driver,
  );
  const child = spawn(resource.binary!, resource.args, {
    cwd: directory,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = once(child, 'close');
  let output = '';
  child.stdout.on('data', (data) => {
    output += String(data);
  });
  headlessCleanups.push(async () => {
    await resource.dispose();
    await closed;
    rmSync(directory, { recursive: true, force: true });
  });
  await waitFor(() => resource.control!.ready);
  return {
    directory,
    control: resource.control!,
    bound,
    events,
    gaps,
    dispose: () => resource.dispose(),
    output: () => output,
  };
}

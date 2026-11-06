import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { atomicPrivateJson } from '@puddle/shared/node';
import {
  claudeHookCommand,
  installClaudeHookDispatcher,
  routeClaudeJob,
} from '../../../src/agents/claude-code/jobs/hooks.js';
import type { LifecycleLaunchContext } from '../../../src/agents/adapter.js';
const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const config = mkdtempSync(join(tmpdir(), 'puddle-job-hooks-'));
  homes.push(config);
  const helpers = join(config, 'helpers');
  mkdirSync(helpers, { mode: 0o700 });
  const job = join(config, 'jobs', '12345678');
  mkdirSync(job, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(helpers, 'puddle-signal.mjs'),
    `let input=''; for await (const chunk of process.stdin) input+=chunk; process.stdout.write(JSON.stringify({nonce:process.env.PUDDLE_AGENT_SIGNAL_NONCE,job:process.env.CLAUDE_JOB_DIR,args:process.argv.slice(2),input}));`,
    { mode: 0o400 },
  );
  installClaudeHookDispatcher(config);
  const context = {
    account: { config_dir: config },
    signalNonce: 'copy-owner',
    signalUrl: 'http://127.0.0.1:1/signal',
    env: {
      PUDDLE_AGENT_HELPER_DIR: helpers,
      PUDDLE_AGENT_HELPER_NODE: process.execPath,
      PUDDLE_AGENT_TURN_STATE_DIR: helpers,
    },
  } as unknown as LifecycleLaunchContext;
  const run = (background: boolean, helper = 'puddle-signal.mjs') =>
    new Promise<string>((resolve, reject) => {
      const child = spawn(
        '/bin/sh',
        ['-c', claudeHookCommand(config, helper, 'lifecycle', 'session_start')],
        {
          env: {
            ...process.env,
            ...context.env,
            PUDDLE_AGENT_SIGNAL_NONCE: 'original-owner',
            ...(background ? { CLAUDE_JOB_DIR: job } : { CLAUDE_JOB_DIR: '' }),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
      });
      child.once('error', reject);
      child.once('exit', () => resolve(output));
      child.stdin.end('{"session_id":"synthetic-ref"}');
    });
  return { config, job, context, run };
}
it('routes an attached copy through its pinned owner while leaving foreground dispatch intact', async () => {
  const f = fixture();
  expect(await f.run(true)).toBe(''); // No fallback to inherited original nonce.
  const unroute = routeClaudeJob(f.context, '12345678');
  expect(JSON.parse(await f.run(true))).toEqual({
    nonce: 'copy-owner',
    args: ['lifecycle', 'session_start'],
    input: '{"session_id":"synthetic-ref"}',
  });
  expect(JSON.parse(await f.run(false)).nonce).toBe('original-owner');
  unroute();
  expect(await f.run(true)).toBe('');
});
it('retains a replacement route and refuses unrecognised helper dispatch', async () => {
  const f = fixture();
  const unroute = routeClaudeJob(f.context, '12345678');
  const file = join(f.job, '.puddle-runtime-route.json');
  const replacement = { ...JSON.parse(readFileSync(file, 'utf8')), nonce: 'replacement' };
  atomicPrivateJson(file, replacement);
  unroute();
  expect(JSON.parse(await f.run(true)).nonce).toBe('replacement');
  expect(await f.run(true, 'unrecognised.mjs')).toBe('');
});

import type { Account } from '@puddle/shared';
import { claudeCode } from '../../../src/agents/claude-code/index.js';
import type { LifecycleLaunchContext } from '../../../src/agents/adapter.js';
import { prepareClaudeJob } from '../../../src/agents/claude-code/jobs/launch.js';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { claudeJobs, inspectClaudeJob } from '../../../src/agents/claude-code/jobs/store.js';
import { claudeJobRequest } from '../../../src/agents/claude-code/jobs/control.js';

const homes: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function home() {
  const path = mkdtempSync(join(tmpdir(), 'puddle-claude-jobs-'));
  homes.push(path);
  return path;
}
const ref = '12345678-1111-4111-8111-111111111111';
const parent = '23456789-1111-4111-8111-111111111111';
const state = {
  sessionId: ref,
  forkSessionId: ref,
  forkParentSessionId: parent,
  interactiveLineage: true,
  cwd: '/synthetic/work',
  createdAt: '2026-11-06T00:00:00.000Z',
  updatedAt: '2026-11-06T00:01:00.000Z',
  state: 'working',
  backend: 'daemon',
  intent: 'Synthetic copy',
  providerEnv: { SECRET: 'never export' },
};
it('reads copy ancestry without publishing native environment or treating saved state as liveness', async () => {
  const root = home(),
    path = join(root, 'jobs', '12345678');
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, 'state.json'), JSON.stringify(state));
  expect(await claudeJobs(root)).toEqual([
    {
      id: '12345678',
      ref,
      parentRef: parent,
      cwd: state.cwd,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      state: 'working',
      backend: 'daemon',
      title: 'Synthetic copy',
    },
  ]);
  writeFileSync(join(path, 'state.json'), JSON.stringify({ ...state, sessionId: parent }));
  expect((await claudeJobs(root))[0]?.parentRef).toBeNull(); // /clear changes the job's conversation.
});
it('refuses incomplete, oversized and linked job metadata', async () => {
  const root = home(),
    path = join(root, 'jobs', '12345678');
  mkdirSync(path, { recursive: true });
  const file = join(path, 'state.json');
  writeFileSync(file, '{');
  await expect(claudeJobs(root)).rejects.toThrow();
  writeFileSync(file, ' '.repeat(1024 * 1024 + 1));
  await expect(claudeJobs(root)).rejects.toThrow(/unavailable/);
  rmSync(file);
  symlinkSync(join(root, 'elsewhere'), file);
  await expect(claudeJobs(root)).rejects.toThrow();
});
async function control(reply: (socket: Socket) => void) {
  const socket = join(home(), 'control.sock'),
    calls: unknown[] = [];
  const server = createServer((peer) => {
    peer.once('data', (data) => {
      calls.push(JSON.parse(data.toString()));
      reply(peer);
    });
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  chmodSync(socket, 0o600);
  return {
    socket,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
it('never retries an uncertain exact-job stop', async () => {
  const native = await control((peer) => peer.destroy());
  try {
    await expect(claudeJobRequest(native, { op: 'kill', short: '12345678' })).rejects.toThrow(
      /lost/,
    );
    expect(native.calls).toEqual([{ proto: 1, op: 'kill', short: '12345678' }]);
  } finally {
    await native.close();
  }
});
it('validates bounded correlated native replies across chunks', async () => {
  const native = await control((peer) => {
    peer.write('{"ok":true,');
    peer.end('"op":"ping","proto":1}\n');
  });
  try {
    await expect(claudeJobRequest(native, { op: 'ping' })).resolves.toMatchObject({ proto: 1 });
  } finally {
    await native.close();
  }
  const mismatch = await control((peer) => peer.end('{"ok":true,"op":"kill"}\n'));
  try {
    await expect(claudeJobRequest(mismatch, { op: 'ping' })).rejects.toThrow(/exact request/);
  } finally {
    await mismatch.close();
  }
});

it('separates immutable job identity from the current conversation and refuses unavailable observations', async () => {
  const root = home(),
    path = join(root, 'jobs', '12345678'),
    bin = join(root, 'bin');
  mkdirSync(path, { recursive: true });
  mkdirSync(bin);
  writeFileSync(join(path, 'state.json'), JSON.stringify(state));
  const executable = join(bin, 'claude');
  const live = {
    kind: 'background',
    id: '12345678',
    sessionId: parent,
    cwd: state.cwd,
    pid: process.pid,
    startedAt: Date.now(),
    state: 'blocked',
  };
  const respond = (value: unknown) =>
    writeFileSync(
      executable,
      `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(JSON.stringify([value]))});\n`,
      { mode: 0o700 },
    );
  respond(live);
  vi.stubEnv('PATH', bin);
  const account = { config_dir: root } as Account;
  await expect(claudeCode.resumeRuntimeProtocol!(parent, account)).resolves.toEqual({
    major: 1,
    minor: 1,
  });
  await expect(claudeCode.resumeRuntimeProtocol!(ref, account)).resolves.toBeNull();
  respond({ ...live, state: 'working', pid: null });
  await expect(claudeCode.resumeRuntimeProtocol!(parent, account)).resolves.toEqual({
    major: 1,
    minor: 1,
  });
  respond(live);
  expect(await inspectClaudeJob(root, ref, { PATH: bin })).toBeNull();
  expect(await inspectClaudeJob(root, parent, { PATH: bin })).toMatchObject({
    id: '12345678',
    launchRef: ref,
    ref: parent,
    parentRef: null,
    pid: process.pid,
  });
  respond({ ...live, state: 'stopped', pid: null });
  await expect(claudeCode.resumeRuntimeProtocol!(parent, account)).resolves.toBeNull();
  await expect(
    prepareClaudeJob({
      account: { config_dir: root },
      resumeRef: parent,
      env: { PATH: bin },
    } as LifecycleLaunchContext),
  ).resolves.toBeNull();
  writeFileSync(executable, `#!${process.execPath}\nprocess.stdout.write('unavailable');\n`, {
    mode: 0o700,
  });
  await expect(claudeCode.resumeRuntimeProtocol!(parent, account)).rejects.toThrow(
    'refusing a duplicate',
  );
  await expect(inspectClaudeJob(root, parent, { PATH: bin })).rejects.toThrow(
    'refusing a duplicate',
  );
});

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  startSshAskpass,
  type RunningSshAskpass,
  type SshAskpassRequest,
} from '../src/ssh-askpass.js';

let home: string;
let bridge: RunningSshAskpass;
const children: ChildProcess[] = [];
const signals: AbortSignal[] = [];
const prompt = vi.fn((_request: SshAskpassRequest, signal: AbortSignal): Promise<string | null> => {
  signals.push(signal);
  return new Promise<null>((resolve) => signal.addEventListener('abort', () => resolve(null)));
});

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'puddle-askpass-test-'));
  signals.length = 0;
  prompt.mockClear();
  const helperPath = join(home, 'helper.cjs');
  buildSync({
    entryPoints: [fileURLToPath(new URL('../src/askpass-helper.ts', import.meta.url))],
    outfile: helperPath,
    platform: 'node',
    format: 'cjs',
  });
  bridge = await startSshAskpass({ home, electronPath: process.execPath, helperPath, prompt });
});
afterEach(async () => {
  for (const child of children.splice(0)) child.kill();
  await bridge?.close();
  rmSync(home, { recursive: true, force: true });
});

const env = () => ({ ...process.env, PUDDLE_DESKTOP_SSH_TARGET: 'user@host' });
const startHelper = () => {
  const child = spawn(bridge.program, ['Password:'], { env: env(), stdio: 'pipe' });
  children.push(child);
  return child;
};

describe('SSH askpass bridge and helper', () => {
  it('relays the target and cancels the prompt when the helper disconnects', async () => {
    const child = startHelper();
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    expect(prompt.mock.calls[0][0]).toEqual({
      target: 'user@host',
      prompt: 'Password:',
      kind: 'secret',
    });
    expect(signals[0].aborted).toBe(false);
    child.kill();
    await vi.waitFor(() => expect(signals[0].aborted).toBe(true));
  });

  it('closes an orphaned helper request when its SSH parent exits', async () => {
    // This fake SSH process owns the real helper, then dies without killing it.
    const parent = spawn(
      process.execPath,
      [
        '-e',
        `
      const { spawn } = require('node:child_process');
      const helper = spawn(process.argv[1], ['Password:'], { stdio: 'ignore' });
      process.send(helper.pid);
      setInterval(() => {}, 1000);
    `,
        bridge.program,
      ],
      { env: env(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
    );
    children.push(parent);
    const [helperPid] = await once(parent, 'message');
    try {
      await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
      parent.kill();
      await vi.waitFor(() => expect(signals[0].aborted).toBe(true), { timeout: 4000 });
    } finally {
      try {
        process.kill(helperPid as number, 'SIGTERM');
      } catch {
        /* Already exited. */
      }
    }
  });

  it('cancels pending authentication on bridge shutdown and lets the helper exit', async () => {
    const child = startHelper();
    const exited = once(child, 'exit');
    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    await bridge.close();
    expect(signals[0].aborted).toBe(true);
    expect((await exited)[0]).toBe(1);
  });

  it('passes a live response only to its helper', async () => {
    prompt.mockImplementationOnce(async () => 'test answer');
    const child = startHelper();
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += String(chunk);
    });
    expect((await once(child, 'exit'))[0]).toBe(0);
    expect(output).toBe('test answer\n');
  });

  it('returns cancellation to SSH without writing a password', async () => {
    prompt.mockResolvedValueOnce(null);
    const child = startHelper();
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += String(chunk);
    });
    expect((await once(child, 'exit'))[0]).toBe(1);
    expect(output).toBe('');
  });
});

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { collectExecOutput } from '../../src/lib/transport/exec-output.js';
import { LocalTransport } from '../../src/lib/transport/local.js';
import { SshTransport, shellQuote } from '../../src/lib/transport/ssh.js';
import { showLogs } from '../../src/lib/logs.js';

const home = mkdtempSync(join(tmpdir(), 'puddle-exec-output-'));
beforeAll(() => {
  vi.stubEnv('FAKE_SSH_HOME', home);
  vi.stubEnv('PUDDLE_HOME', home);
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});
const command = (code: string) => `exec ${shellQuote(process.execPath)} -e ${shellQuote(code)}`;

describe.each(['local', 'ssh'] as const)('%s output collection', (kind) => {
  const transport = () =>
    kind === 'local'
      ? new LocalTransport()
      : new SshTransport('host.example', {
          sshBinary: fileURLToPath(new URL('../helpers/fake-ssh.mjs', import.meta.url)),
        });
  it('delivers all streamed bytes without retaining stdout and bounds stderr', async () => {
    let bytes = 0;
    const result = await transport().exec(
      command(
        "process.stdout.write('x'.repeat(8 * 1024 * 1024)); process.stderr.write('e'.repeat(256 * 1024) + 'last diagnostic');",
      ),
      {
        capture: 'stream',
        onStdout: (chunk) => {
          bytes += chunk.length;
        },
      },
    );
    expect(bytes).toBe(8 * 1024 * 1024);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toHaveLength(64 * 1024);
    expect(result.stderr.endsWith('last diagnostic')).toBe(true);
  });
  it('preserves full default capture, callbacks, stdin and nonzero status', async () => {
    let streamed = '';
    const input = 'synthetic input\n'.repeat(10000);
    const result = await transport().exec(
      command(
        "process.stdin.pipe(process.stdout); process.stdin.on('end', () => { process.stderr.write('e'.repeat(70000)); process.exitCode = 7; });",
      ),
      {
        stdin: input,
        onStdout: (chunk) => {
          streamed += chunk;
        },
      },
    );
    expect(result).toEqual({ code: 7, stdout: input, stderr: 'e'.repeat(70000) });
    expect(streamed).toBe(input);
  });
  it('preserves UTF-8 characters split across writes', async () => {
    let streamed = '';
    const result = await transport().exec(
      command(
        'process.stdout.write(Buffer.from([0xe7])); setTimeout(() => process.stdout.write(Buffer.from([0x95, 0x8c])), 20);',
      ),
      {
        onStdout: (chunk) => {
          streamed += chunk;
        },
      },
    );
    expect(result.stdout).toBe('界');
    expect(streamed).toBe('界');
  });
  it('keeps timeout and early stdin-close behaviour', async () => {
    const result = await transport().exec(command('setTimeout(() => {}, 300);'), {
      timeoutMs: 150,
      capture: 'stream',
    });
    expect(result.code).toBe(-1);
    const early = await transport().exec('exit 4', { stdin: 'x'.repeat(1024 * 1024) });
    expect(early.code).toBe(4);
  });
});

it('returns spawn errors through the shared collector', async () => {
  const child = spawn(join(home, 'missing-executable'), [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const result = await collectExecOutput(child, { capture: 'stream', timeoutMs: 1000 });
  expect(result.code).toBe(-1);
  expect(result.stderr).toContain('ENOENT');
  expect(result.stdout).toBe('');
});

it.each([undefined, 'synthetic-session'])(
  'opts log viewing out of capture (%s)',
  async (session) => {
    const transport = new LocalTransport();
    const exec = vi.spyOn(transport, 'exec').mockResolvedValue({ code: 0, stdout: '', stderr: '' });
    await showLogs(transport, { session, follow: true, write: () => {} });
    expect(exec.mock.calls[0]?.[1]?.capture).toBe('stream');
  },
);

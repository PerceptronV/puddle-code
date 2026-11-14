import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HostControlClient } from '../../shared/src/node/host-control.js';
import { SshTransport, shellQuote } from '../../cli/src/lib/transport/ssh.js';
import { openTunnel, type Tunnel } from '../../cli/src/lib/transport/tunnel.js';
import { startSshAskpass, type RunningSshAskpass } from '../src/ssh-askpass.js';

let home: string;
let master: string;
let killFile: string;
let upstream: Server | undefined;
let ssh: SshTransport;
let bridge: RunningSshAskpass;
let tunnel: Tunnel | undefined;
let authority: HostControlClient | undefined;
const prompts: Array<{ signal: AbortSignal; answer(value: string | null): void }> = [];

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'puddle-ssh-reconnect-'));
  master = join(home, 'master');
  killFile = join(home, 'kill-forward');
  prompts.length = 0;
  vi.stubEnv('PUDDLE_HOME', join(home, 'client'));
  vi.stubEnv('FAKE_SSH_HOME', home);
  vi.stubEnv('FAKE_SSH_PASSWORD_MASTER', master);
  vi.stubEnv('FAKE_SSH_KILL', killFile);
  const helperPath = join(home, 'askpass.cjs');
  buildSync({
    entryPoints: [fileURLToPath(new URL('../src/askpass-helper.ts', import.meta.url))],
    outfile: helperPath,
    platform: 'node',
    format: 'cjs',
  });
  bridge = await startSshAskpass({
    home,
    electronPath: process.execPath,
    helperPath,
    prompt: (_request, signal) =>
      new Promise((resolve) => {
        prompts.push({ signal, answer: resolve });
        signal.addEventListener('abort', () => resolve(null), { once: true });
      }),
  });
  const fakeSsh = fileURLToPath(
    new URL('../../cli/test/helpers/password-ssh.mjs', import.meta.url),
  );
  const sshBinary = join(home, 'ssh');
  writeFileSync(
    sshBinary,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fakeSsh)} "$@"\n`,
    { mode: 0o700 },
  );
  ssh = new SshTransport('user@fixture', {
    sshBinary,
    platform: 'darwin',
    askpassProgram: bridge.program,
  });
  upstream = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  writeFileSync(master, 'authenticated');
  tunnel = await openTunnel(ssh, address.port, {
    sshBinary,
    healthIntervalMs: 100,
    downGraceMs: 50,
  });
});

afterEach(async () => {
  authority?.close();
  authority = undefined;
  await tunnel?.close();
  tunnel = undefined;
  await bridge?.close();
  if (upstream) await new Promise<void>((resolve) => upstream!.close(() => resolve()));
  upstream = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(home, { recursive: true, force: true });
});

async function expireMaster() {
  rmSync(master);
  writeFileSync(killFile, '');
  await vi.waitFor(() => expect(prompts).toHaveLength(1), { timeout: 5000 });
  rmSync(killFile);
}

it('keeps one password request while the control channel retries during tunnel re-authentication', async () => {
  let restored = false;
  tunnel!.onAvailability((available) => (restored = available));
  await expireMaster();
  authority = new HostControlClient(async () => ssh.openChannel('cat'));
  void authority.establish().catch(() => {});
  // Give the independent one-second authority retry loop multiple attempts,
  // as if the user were still typing into the tunnel's password dialogue.
  await new Promise((resolve) => setTimeout(resolve, 2200));
  expect(prompts).toHaveLength(1);
  expect(prompts[0].signal.aborted).toBe(false);
  prompts[0].answer('fixture-password');
  await vi.waitFor(() => expect(restored).toBe(true), { timeout: 5000 });
}, 15_000);

it('cancels old re-authentication before a refreshed connection asks for a password', async () => {
  await expireMaster();
  await tunnel!.close();
  tunnel = undefined;
  await vi.waitFor(() => expect(prompts[0].signal.aborted).toBe(true), { timeout: 5000 });
  const replacement = ssh.open();
  await vi.waitFor(() => expect(prompts).toHaveLength(2), { timeout: 5000 });
  expect(prompts[1].signal.aborted).toBe(false);
  prompts[1].answer('fixture-password');
  await replacement;
}, 15_000);

it('does not start authentication if the tunnel closes during its master check', async () => {
  let finish!: (alive: boolean) => void;
  const checking = new Promise<boolean>((resolve) => {
    finish = resolve;
  });
  const check = vi.spyOn(ssh, 'isAlive').mockReturnValue(checking);
  const open = vi.spyOn(ssh, 'open');
  rmSync(master);
  writeFileSync(killFile, '');
  try {
    await vi.waitFor(() => expect(check).toHaveBeenCalledOnce(), { timeout: 5000 });
    await tunnel!.close();
    tunnel = undefined;
  } finally {
    finish(false);
  }
  await checking;
  expect(open).not.toHaveBeenCalled();
  expect(prompts).toHaveLength(0);
}, 10_000);

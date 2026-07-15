import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon, type RunningDaemon } from '../../daemon/src/daemon.js';
import { connectRemote } from '../src/lib/connect.js';
import { findFreePort } from '../src/lib/net.js';
import type { RunningCockpit } from '../src/lib/cockpit.js';
import { SshTransport } from '../src/lib/transport/ssh.js';

const FAKE_SSH = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'fake-ssh.mjs');

function withAssets(): string {
  const dir = mkdtempSync(join(tmpdir(), 'puddle-cli-assets-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>puddle</title>');
  return dir;
}

describe('SshTransport argv shapes', () => {
  it('uses ControlMaster multiplexing on POSIX clients', () => {
    const ssh = new SshTransport('alice@devbox', { platform: 'darwin' });
    const argv = ssh.args('alice@devbox', 'true').join(' ');
    expect(argv).toContain('ControlMaster=auto');
    expect(argv).toContain('ControlPersist=10m');
    expect(argv).toContain('cm-%C');
  });

  it('drops every Control* option on Windows (no multiplexing there)', () => {
    const ssh = new SshTransport('alice@devbox', { platform: 'win32' });
    expect(ssh.args('alice@devbox', 'true').join(' ')).not.toContain('Control');
    expect(ssh.hasControlMaster).toBe(false);
  });
});

describe('puddle connect against a fake ssh + real daemon', () => {
  const fakeClientHome = mkdtempSync(join(tmpdir(), 'puddle-cli-client-'));
  const fakeHostHome = mkdtempSync(join(tmpdir(), 'puddle-cli-hosthome-'));
  const hostPuddle = join(fakeHostHome, '.puddle');
  const killFile = join(fakeHostHome, 'kill-tunnel');
  let daemon: RunningDaemon;
  let cockpit: RunningCockpit;
  let daemonPort: number;

  beforeAll(async () => {
    chmodSync(FAKE_SSH, 0o755);
    process.env.FAKE_SSH_HOME = fakeHostHome;
    process.env.FAKE_SSH_KILL = killFile;
    // The CLIENT ~/.puddle (control sockets) must not collide with the host's.
    process.env.PUDDLE_HOME = join(fakeClientHome, '.puddle');

    // A "remote" daemon: pre-installed under the fake host home, on a fixed
    // port recorded in its config.json — exactly what connect discovers.
    daemonPort = await findFreePort();
    mkdirSync(hostPuddle, { recursive: true });
    writeFileSync(join(hostPuddle, 'config.json'), JSON.stringify({ port: daemonPort }) + '\n');
    daemon = await startDaemon({ home: hostPuddle, adapters: [], version: 'remote-test' });
    mkdirSync(join(hostPuddle, 'bin', 'versions', '9.9.9'), { recursive: true });
    symlinkSync('versions/9.9.9', join(hostPuddle, 'bin', 'current'));

    cockpit = await connectRemote({
      host: 'alice@devbox',
      assetsDir: withAssets(),
      sshBinary: FAKE_SSH,
      platform: 'darwin',
    });
  }, 30_000);

  afterAll(async () => {
    await cockpit?.stop();
    await daemon?.stop();
    delete process.env.FAKE_SSH_HOME;
    delete process.env.FAKE_SSH_KILL;
    delete process.env.PUDDLE_HOME;
  });

  const viaCockpit = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${cockpit.origin}${path}`, { headers });

  it('lands a working cockpit: UI + proxied API through the tunnel', async () => {
    expect(daemonPort).toBe(daemon.port); // config.json really drove the bind
    expect(await (await viaCockpit('/')).text()).toContain('puddle');
    const version = await viaCockpit('/api/version', {
      authorization: `Bearer ${daemon.token}`,
    });
    expect(version.status).toBe(200);
    expect(((await version.json()) as { version: string }).version).toBe('remote-test');
  });

  it('builds the browser URL with ?host= and the token fragment', () => {
    expect(cockpit.browserUrl).toBe(
      `${cockpit.origin}/?host=${encodeURIComponent('alice@devbox')}#token=${daemon.token}`,
    );
  });

  it('reconnects the tunnel after it drops, on the same local port', async () => {
    const events: string[] = [];
    cockpit.onEvent((e) => events.push(e.t));
    writeFileSync(killFile, ''); // the fake forward exits when this appears
    await waitUntil(() => events.includes('tunnel-down'), 5000);
    rmSync(killFile); // let the respawn survive
    await waitUntil(() => events.includes('tunnel-up'), 15_000);
    const version = await viaCockpit('/api/version', {
      authorization: `Bearer ${daemon.token}`,
    });
    expect(version.status).toBe(200);
  }, 25_000);
});

async function waitUntil(cond: () => boolean, ms: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitUntil timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon, type RunningDaemon } from '../../daemon/test/helpers/authorised-daemon.js';
import { acquireAuthority } from '../src/lib/auth/connection-authority.js';
import { inspectHost } from '../src/lib/auth/control-channel.js';
import { openTunnel } from '../src/lib/transport/tunnel.js';
import { loopbackSsh } from '../test/helpers/loopback-ssh.js';
import { DaemonClient } from '../src/lib/connection/daemon-client.js';

// Leave room for OpenSSH's temporary suffix within macOS's Unix ControlPath limit.
const temporary = mkdtempSync(
  join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'puddle-ssh-'),
);
const hostHome = join(temporary, 'host');
let daemon: RunningDaemon | undefined;
let ssh: Awaited<ReturnType<typeof loopbackSsh>>;
let legacy: Server | undefined;

beforeAll(async () => {
  mkdirSync(hostHome, { mode: 0o700 });
  ssh = await loopbackSsh(hostHome);
  daemon = await startDaemon({ home: hostHome, port: 0, adapters: [], version: 'ssh-fixture' });
  mkdirSync(join(hostHome, 'bin/current/bin'), { recursive: true });
  symlinkSync(process.execPath, join(hostHome, 'bin/current/bin/node'));
});
afterAll(async () => {
  legacy?.closeAllConnections();
  await new Promise<void>((resolve) => (legacy ? legacy.close(() => resolve()) : resolve()));
  await daemon?.stop();
  await ssh?.close();
  rmSync(temporary, { recursive: true, force: true });
});

describe.each(['darwin', 'win32'] as const)('real OpenSSH with platform=%s', (platform) => {
  it('keeps independent leases over shared and dedicated SSH connections', async () => {
    const transport = ssh.transport(platform);
    await transport.open();
    const first = await acquireAuthority(transport);
    const second = await acquireAuthority(transport);
    const tunnel = await openTunnel(transport, daemon!.port, { sshBinary: ssh.binary });
    try {
      const a = new DaemonClient(tunnel.localPort, first);
      const b = new DaemonClient(tunnel.localPort, second);
      expect((await a.version()).version).toBe('ssh-fixture');
      const stolen = first.credential();
      first.close();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(
        (
          await fetch(`http://127.0.0.1:${daemon!.port}/api/version`, {
            headers: { authorization: `Bearer ${stolen}` },
          })
        ).status,
      ).toBe(401);
      expect((await b.version()).version).toBe('ssh-fixture');
      expect(ssh.output()).not.toContain(second.credential());
    } finally {
      first.close();
      second.close();
      await tunnel.close();
      transport.dispose();
    }
  });
});

it('inspects legacy credentials only inside the remote helper', async () => {
  await daemon!.stop();
  // Prevent the afterAll cleanup from closing the same database a second time.
  daemon = undefined;
  const master = 'd'.repeat(64);
  legacy = createServer((req, res) => {
    expect(req.headers.authorization).toBe(`Bearer ${master}`);
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify(
        req.url === '/api/version' ? { version: '0.1.13', protocol: { major: 17, minor: 3 } } : [],
      ),
    );
  });
  const port = await new Promise<number>((resolve) =>
    legacy!.listen(0, '127.0.0.1', () => resolve((legacy!.address() as { port: number }).port)),
  );
  writeFileSync(join(hostHome, 'token'), master + '\n', { mode: 0o600 });
  writeFileSync(join(hostHome, 'runtime.json'), JSON.stringify({ port }));
  const transport = ssh.transport();
  const result = await inspectHost(transport);
  expect(result).toMatchObject({
    t: 'inspection',
    liveSessions: 0,
    version: { protocol: { major: 17 } },
  });
  expect(JSON.stringify(result)).not.toContain(master);
  expect(ssh.output()).not.toContain(master);
});

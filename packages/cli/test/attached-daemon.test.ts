import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttachedDaemon } from '../src/lib/attached-daemon.js';
import { findFreePort } from '../src/lib/net.js';
import { SshTransport } from '../src/lib/transport/ssh.js';

const FAKE_SSH = join(dirname(fileURLToPath(import.meta.url)), 'helpers', 'fake-ssh.mjs');

describe('SSH-attached daemon', () => {
  const clientHome = mkdtempSync(join(tmpdir(), 'puddle-attached-client-'));
  const hostHome = mkdtempSync(join(tmpdir(), 'puddle-attached-host-'));
  const puddleHome = join(hostHome, '.puddle');
  let attached: AttachedDaemon;

  beforeAll(async () => {
    chmodSync(FAKE_SSH, 0o755);
    process.env.PUDDLE_HOME = join(clientHome, '.puddle');
    process.env.FAKE_SSH_HOME = hostHome;
    const port = await findFreePort();
    const token = 'b'.repeat(64);
    mkdirSync(join(puddleHome, 'bin', 'versions', 'test'), { recursive: true });
    mkdirSync(join(puddleHome, 'logs'), { recursive: true });
    writeFileSync(join(puddleHome, 'token'), `${token}\n`);
    writeFileSync(join(puddleHome, 'config.json'), `${JSON.stringify({ port })}\n`);

    const serverFile = join(hostHome, 'fake-puddled.mjs');
    writeFileSync(
      serverFile,
      `import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const home = process.env.PUDDLE_HOME;
const args = process.argv.slice(2);
const at = args.indexOf('--port');
const configured = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')).port;
const port = at === -1 ? configured : Number(args[at + 1]);
const db = join(home, 'puddle.db');
if (!existsSync(db)) writeFileSync(db, 'durable-state');
const server = createServer((_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end('{"version":"test","protocol":{"major":1,"minor":0}}');
});
server.listen(port, '127.0.0.1', () => {
  writeFileSync(join(home, 'runtime.json'), JSON.stringify({ port, pid: process.pid }));
});
const stop = () => server.close(() => {
  rmSync(join(home, 'runtime.json'), { force: true });
  process.exit(0);
});
process.on('SIGTERM', stop);
process.on('SIGHUP', stop);
`,
    );
    const launcher = join(puddleHome, 'bin', 'versions', 'test', 'puddled');
    writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${serverFile}" "$@"\n`);
    chmodSync(launcher, 0o755);
    symlinkSync('versions/test', join(puddleHome, 'bin', 'current'));

    const ssh = new SshTransport('alice@devbox', {
      platform: 'darwin',
      sshBinary: FAKE_SSH,
    });
    attached = new AttachedDaemon(ssh);
  });

  afterAll(async () => {
    await attached?.stop();
    delete process.env.PUDDLE_HOME;
    delete process.env.FAKE_SSH_HOME;
  });

  // A full workspace run can briefly starve the fake SSH subprocesses on CI.
  it('restarts with the cockpit while leaving host data intact', async () => {
    const endpoint = await attached.start();
    expect(endpoint.daemonLifetime).toBe('cockpit');
    expect(existsSync(join(puddleHome, 'runtime.json'))).toBe(true);
    expect(existsSync(join(puddleHome, 'puddled.pid'))).toBe(true);
    expect(readFileSync(join(puddleHome, 'puddle.db'), 'utf8')).toBe('durable-state');

    await endpoint.lease?.stop();
    expect(existsSync(join(puddleHome, 'runtime.json'))).toBe(false);
    expect(existsSync(join(puddleHome, 'puddled.pid'))).toBe(false);
    expect(readFileSync(join(puddleHome, 'puddle.db'), 'utf8')).toBe('durable-state');

    await endpoint.lease?.ensureRunning();
    expect(existsSync(join(puddleHome, 'runtime.json'))).toBe(true);
    expect(readFileSync(join(puddleHome, 'puddle.db'), 'utf8')).toBe('durable-state');
  }, 60_000);
});

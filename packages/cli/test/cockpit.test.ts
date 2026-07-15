import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon, type RunningDaemon } from '../../daemon/src/daemon.js';
import { ensureDaemon } from '../src/lib/cockpit.js';
import { findFreePort } from '../src/lib/net.js';
import { startUiServer } from '../src/lib/serve/ui-server.js';
import { LocalTransport } from '../src/lib/transport/local.js';

describe('ensureDaemon identity probe', () => {
  let daemon: RunningDaemon;
  let daemonPort: number;

  beforeAll(async () => {
    daemonPort = await findFreePort();
    const homeA = mkdtempSync(join(tmpdir(), 'puddle-cockpit-a-'));
    writeFileSync(join(homeA, 'config.json'), JSON.stringify({ port: daemonPort }) + '\n');
    daemon = await startDaemon({ home: homeA, adapters: [], version: 'identity-test' });
  });
  afterAll(async () => {
    await daemon.stop();
    delete process.env.PUDDLE_HOME;
  });

  it("refuses to treat a daemon that rejects this host's token as ours", async () => {
    // Home B: a different token, but config points at daemon A's port — the
    // shape of the port-collision incident (another cockpit or foreign
    // daemon answering on the expected port).
    const homeB = mkdtempSync(join(tmpdir(), 'puddle-cockpit-b-'));
    mkdirSync(join(homeB, '.puddle'), { recursive: true });
    writeFileSync(join(homeB, '.puddle', 'token'), 'b'.repeat(64) + '\n');
    writeFileSync(
      join(homeB, '.puddle', 'config.json'),
      JSON.stringify({ port: daemonPort, configVersion: 2 }) + '\n',
    );
    process.env.PUDDLE_HOME = join(homeB, '.puddle');

    await expect(ensureDaemon(new LocalTransport(), {})).rejects.toMatchObject({
      code: 'port_in_use',
      message: expect.stringContaining('rejects this host'),
    });
  });

  it("accepts the daemon when the token matches (probe = 'ok')", async () => {
    process.env.PUDDLE_HOME = daemon.paths.home;
    const endpoint = await ensureDaemon(new LocalTransport(), {});
    expect(endpoint).toMatchObject({ port: daemonPort, token: daemon.token, bootstrapped: false });
  });
});

describe('UI server avoids the daemon port', () => {
  it('skips avoidPort during auto-pick even when that port is free', async () => {
    const assets = mkdtempSync(join(tmpdir(), 'puddle-avoid-assets-'));
    writeFileSync(join(assets, 'index.html'), '<!doctype html>');
    const start = await findFreePort();
    const ui = await startUiServer({
      assetsDir: assets,
      port: start,
      avoidPort: start, // the daemon's port: must be skipped, not taken
      target: { host: '127.0.0.1', port: 1 },
    });
    expect(ui.port).not.toBe(start);
    expect(ui.port).toBeGreaterThan(start);
    await ui.close();
  });
});

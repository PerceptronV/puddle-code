import { once } from 'node:events';
import { connect } from 'node:net';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { PROTOCOL_VERSION, REMOTE_PROTOCOL_VERSION } from '@puddle/shared';
import { ipcPath } from '@puddle/shared/node';
import { startConnectorManager } from '../../src/manager.js';
import { inspectConnectorManager } from '../../../daemon/src/updates/preflight/connector.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

it('reports only fresh host process metadata on the existing private manager socket', async () => {
  const home = mkdtempSync(join(tmpdir(), 'puddle-manager-inspection-'));
  const path = ipcPath(home, 'remote');
  cleanups.push(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(dirname(path), { recursive: true, force: true });
  });
  const manager = await startConnectorManager(home);
  cleanups.push(() => manager.close());
  const first = await inspectConnectorManager(home);
  const second = await inspectConnectorManager(home);
  expect(first).toMatchObject({
    t: 'inspection',
    ready: true,
    pid: process.pid,
    node_path: realpathSync(process.execPath),
    application: PROTOCOL_VERSION,
    remote: REMOTE_PROTOCOL_VERSION,
  });
  expect(second?.instance).toBe(first?.instance);
  expect(second?.nonce).not.toBe(first?.nonce);
  expect(first).not.toHaveProperty('profiles');
  expect(first).not.toHaveProperty('credential');
  for (const request of [{ t: 'disable' }, { t: 'inspect', nonce: 'x'.repeat(2048) }]) {
    const socket = connect(path);
    const closed = once(socket, 'close');
    let response = '';
    socket.on('data', (chunk) => {
      response += String(chunk);
    });
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    await closed;
    expect(response).toBe('');
  }
  expect((await inspectConnectorManager(home))?.ready).toBe(true);
});

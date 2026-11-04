import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ipcPath, jsonLines, listenPrivate } from '@puddle/shared/node';
import {
  HostUpdateConnector,
  inspectConnectorManager,
} from '../../../src/updates/preflight/connector.js';
import { candidateFixture } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});

function fixture(component: 'daemon' | 'runtime' = 'daemon') {
  const f = candidateFixture(component);
  const directory = dirname(ipcPath(f.home, 'remote'));
  cleanups.push(async () => rmSync(directory, { recursive: true, force: true }));
  const inspector = new HostUpdateConnector(f.home, f.home);
  return { ...f, inspector };
}

it('distinguishes an unconfigured host from an offline or ambiguous connector installation', async () => {
  const f = fixture();
  expect(await f.inspector.inspect(f.operation)).toEqual({
    state: 'absent',
    identity: null,
    blockers: [],
  });
  mkdirSync(join(f.home, 'remote'));
  expect(await f.inspector.inspect(f.operation)).toMatchObject({
    state: 'unknown',
    blockers: [{ code: 'connector_inventory_unknown', target: 'connector' }],
  });
  const runtime = fixture('runtime');
  mkdirSync(join(runtime.home, 'remote'));
  expect(await runtime.inspector.inspect(runtime.operation)).toEqual({
    state: 'not-required',
    identity: null,
    blockers: [],
  });
});

it('never interprets an old manager closing its socket as proof of absence', async () => {
  const f = fixture();
  const server = await listenPrivate(ipcPath(f.home, 'remote'), (socket) => socket.destroy());
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await expect(inspectConnectorManager(f.home)).rejects.toThrow();
  expect((await f.inspector.inspect(f.operation)).state).toBe('unknown');
});

it('corroborates fresh manager metadata with its exact immutable release and excludes nonces from identity', async () => {
  const f = fixture();
  mkdirSync(join(f.root, 'bin'));
  mkdirSync(join(f.root, 'daemon'));
  writeFileSync(join(f.root, 'bin/node'), 'fixture metadata only');
  writeFileSync(join(f.root, 'daemon/connector.mjs'), 'fixture metadata only');
  const identity = {
    instance: randomUUID(),
    pid: process.pid,
    ready: true,
    version: f.capabilities.version,
    application: f.capabilities.application,
    remote: f.capabilities.remote,
    release_path: realpathSync(f.root),
    node_path: realpathSync(join(f.root, 'bin/node')),
    entry_path: realpathSync(join(f.root, 'daemon/connector.mjs')),
  };
  let wrongNonce = false;
  const server = await listenPrivate(ipcPath(f.home, 'remote'), (socket) => {
    const stop = jsonLines(
      socket,
      (request) => {
        const nonce = (request as { nonce: string }).nonce;
        socket.end(
          JSON.stringify({
            ...identity,
            t: 'inspection',
            nonce: wrongNonce ? randomUUID() : nonce,
          }) + '\n',
        );
      },
      () => socket.destroy(),
    );
    socket.on('close', stop);
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const observed = await f.inspector.inspect(f.operation);
  expect(observed).toEqual({ state: 'running', identity, blockers: [] });
  expect(await f.inspector.inspect(f.operation)).toEqual(observed);
  wrongNonce = true;
  expect((await f.inspector.inspect(f.operation)).state).toBe('unknown');
  wrongNonce = false;
  identity.ready = false;
  expect((await f.inspector.inspect(f.operation)).state).toBe('unknown');
  identity.ready = true;
  const pinnedNode = identity.node_path;
  identity.node_path = process.execPath;
  expect((await f.inspector.inspect(f.operation)).state).toBe('unknown');
  identity.node_path = pinnedNode;
  identity.remote++;
  expect((await f.inspector.inspect(f.operation)).state).toBe('unknown');
});

import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { runtimeStateSchema, runtimeSupervisorSchema, sessionSchema } from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { createIdentity, identityPeer } from '../../../../remote-transport/src/index.js';
import { DeviceStore } from '../../../../connector/src/devices.js';
import { inspectConnectorManager } from '../../../src/updates/preflight/connector.js';
import { readRuntime } from '../../../src/runtime-file.js';
import { readRuntimeJson, runtimeDirectory } from '../../../src/runtime/ownership/storage.js';
import { HostUpdateOperations } from '../../../src/updates/operations/store.js';
import { readHostUpdateAdoption } from '../../../src/updates/checkpoints/adoption.js';
import { runtimeDatabase } from '../../helpers/runtime-database.js';
import { retainRuntimeHome, terminal } from '../../helpers/runtime-fixture.js';
import {
  continuityRelease,
  continuitySupervisor,
  installer,
} from '../../helpers/update-continuity/release.js';
import { continuityRelay } from '../../helpers/update-continuity/remote/relay.js';
import { continuityBrowser } from '../../helpers/update-continuity/remote/client.js';
import { sh } from '../../helpers/git-fixtures.js';

it('replaces the bundled daemon and connector through encrypted maintenance while preserving the original runtime and shell', async () => {
  const f = runtimeDatabase();
  const browsers: Awaited<ReturnType<typeof continuityBrowser>>[] = [];
  const relay = await continuityRelay(f.home);
  const env = {
    ...(await continuitySupervisor(f.home)),
    NODE_EXTRA_CA_CERTS: relay.certPath,
    PUDDLE_REPO: 'fixture/puddle',
  };
  const services = join(f.home, 'test-services');
  const run = (file: string, args: string[]) =>
    promisify(execFile)(file, args, { env, timeout: 60_000, maxBuffer: 1024 * 1024 });
  const manager = (...args: string[]) => run(join(services, 'systemctl'), ['--user', ...args]);
  const diagnostics = () =>
    readdirSync(services)
      .filter((file) => file.endsWith('.log'))
      .map((file) => `${file}: ${readFileSync(join(services, file), 'utf8').slice(-5000)}`)
      .concat(
        browsers.map(
          (browser, index) =>
            `browser ${index} terminal events: ${JSON.stringify(
              browser.received
                .filter(
                  (entry) =>
                    entry.t === 'event' &&
                    ['output', 'replay', 'error', 'exit'].includes(entry.message.t),
                )
                .slice(-8),
            ).slice(-5000)}`,
        ),
      )
      .join('\n');
  const wait = async (check: () => boolean | Promise<boolean>, label: string, timeout = 45_000) => {
    const deadline = Date.now() + timeout;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error(`${label}\n${diagnostics()}`);
      await delay(30);
    }
  };
  const state = (id: string) =>
    runtimeStateSchema.parse(readRuntimeJson(join(runtimeDirectory(f.home, id), 'state.json')));
  const ownerPid = (id: string) => {
    const supervisor = runtimeSupervisorSchema.parse(
      readRuntimeJson(join(runtimeDirectory(f.home, id), 'supervisor.json')),
    );
    return Number(readFileSync(join(services, `${supervisor.name}.pid`), 'utf8'));
  };
  const browserIdentity = await createIdentity();
  const hostIdentity = await createIdentity();
  const directory = join(f.home, 'remote/profiles', f.profile.id);
  let devices: DeviceStore | undefined;
  try {
    f.runtimes.finish(f.binding.runtime_id, 'exited', () =>
      f.sessions.setStatus(f.session.id, 'exited'),
    );
    await f.reconciler.close();
    f.controller.release();
    sh(f.home, 'init', '-b', 'main');
    const stagingArchive = {
      version: '0.4.1',
      path: join(f.home, 'test-archives/0.4.1/release.tar.gz'),
    };
    const options = { connector: true, stagingArchive };
    const archive = await continuityRelease(f.home, '0.4.0', false, undefined, options);
    await continuityRelease(f.home, '0.4.1', false, undefined, options);
    await run('/bin/sh', [
      installer,
      '--version',
      '0.4.0',
      '--tarball',
      archive,
      '--sums',
      `${archive}.sha256`,
      '--component',
      'daemon',
      '--no-supervisor',
    ]);
    writeFileSync(join(f.home, 'supervisor'), 'systemd\n', { mode: 0o600 });
    // A fresh host-owned release catalogue avoids external release polling; only
    // stage downloads are replaced with exact local archive/checksum inputs.
    const catalogueTime = Date.now();
    atomicPrivateJson(join(f.home, 'updates/release-check.json'), {
      format: 1,
      check: {
        repository: 'fixture/puddle',
        state: 'ready',
        checked_at: catalogueTime,
        succeeded_at: catalogueTime,
        latest: { version: '0.4.1', host_asset: true },
      },
    });
    atomicPrivateJson(join(directory, 'config.json'), {
      ...relay.registration,
      service: relay.service,
      app: relay.app,
      enabled: true,
    });
    atomicPrivateJson(join(directory, 'identity.json'), [...hostIdentity]);
    devices = new DeviceStore(directory);
    const browserPeer = identityPeer(browserIdentity);
    const device = devices.enrol(
      devices.invite().invitation,
      browserPeer,
      relay.registration.account,
      'Continuity browser',
    );
    devices.approve(device.id);
    devices.setMaintenance(device.id, true, relay.registration.account, relay.registration.host);
    const grant = devices.maintenanceClaim(
      device.id,
      browserPeer,
      relay.registration.account,
      relay.registration.host,
    );
    const unitDirectory = join(f.home, '.config/systemd/user');
    mkdirSync(unitDirectory, { recursive: true });
    writeFileSync(
      join(unitDirectory, 'puddle-connector.service'),
      `[Unit]\nDescription=Isolated connector fixture\n[Service]\nExecStart="${f.home}/bin/current/bin/node" "${f.home}/bin/current/daemon/connector.mjs"\nRestart=on-failure\n`,
      { mode: 0o600 },
    );
    await manager('start', 'puddled.service');
    await wait(() => !!readRuntime(f.paths), 'Original daemon readiness');
    await manager('start', 'puddle-connector.service');
    await wait(
      async () => relay.online() && !!(await inspectConnectorManager(f.home))?.ready,
      'Original connector readiness',
    );
    const firstConnector = (await inspectConnectorManager(f.home))!;
    expect(firstConnector.version).toBe('0.4.0');
    const firstDaemon = readRuntime(f.paths)!.pid;
    const connectBrowser = async () => {
      const browser = await continuityBrowser({
        ...relay,
        ...relay.registration,
        hostPeer: identityPeer(hostIdentity),
        identity: browserIdentity,
      });
      browsers.push(browser);
      expect(browser.admitted).toMatchObject({ t: 'admitted', device: device.id });
      return browser;
    };
    const first = await connectBrowser();
    const create = async (browser: typeof first) => {
      const response = await browser.request('POST', '/api/sessions', {
        project_id: f.project.id,
        kind: 'terminal',
        cwd: '.',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      const session = sessionSchema.parse(response.body);
      return { session, owner: f.runtimes.ownerOf(session.id)! };
    };
    const original = await create(first);
    const main = terminal(state(original.owner.runtime_id));
    const originalOwnerPid = ownerPid(original.owner.runtime_id);
    await first.stream();
    await first.terminal({
      t: 'attach',
      session: original.session.id,
      term: 'agent',
      cols: 90,
      rows: 25,
    });
    await first.terminal({
      t: 'stdin',
      session: original.session.id,
      term: 'agent',
      data: 'set +H\nstty -echo; preserved=encrypted_upgrade; cd /; sleep 180 & background=$!; printf "before:%s:%s:%s\\n" "$preserved" "$PWD" "$background"\n',
    });
    await wait(() => first.text().includes('before:encrypted_upgrade:/:'), 'Original shell state');
    const background = /before:encrypted_upgrade:\/:(\d+)/.exec(first.text())![1]!;
    const prepared = await first.maintenance({
      action: 'prepare',
      targets: [
        { component: 'daemon', version: '0.4.1' },
        { component: 'runtime', version: '0.4.1' },
      ],
    });
    if (prepared.kind !== 'result' || !prepared.result.ok || !prepared.result.operation)
      throw new Error(JSON.stringify(prepared));
    const reviewed = await first.maintenance({
      action: 'inspect',
      reference: { id: prepared.result.operation.id, revision: prepared.result.operation.revision },
    });
    expect(reviewed, diagnostics()).toMatchObject({
      kind: 'result',
      result: { ok: true, review: { can_apply: true } },
    });
    if (
      reviewed.kind !== 'result' ||
      !reviewed.result.ok ||
      !reviewed.result.operation ||
      !reviewed.result.review?.fingerprint
    )
      throw new Error(JSON.stringify(reviewed));
    const operation = reviewed.result.operation;
    const store = new HostUpdateOperations(f.home);
    // Deliberately discard this reply. Wait for durable consumption before closing
    // transport so the replacement must finish without browser-side replay.
    const applyId = await first.dropApplyReply({
      action: 'apply',
      reference: { id: operation.id, revision: operation.revision },
      fingerprint: reviewed.result.review.fingerprint,
    });
    await wait(() => !!store.read(operation.id)?.dispatch_id, 'Accepted encrypted dispatch');
    first.close();
    await wait(
      () => ['complete', 'recovery_required'].includes(store.read(operation.id)!.phase),
      'Independent update completion',
      60_000,
    );
    expect(store.read(operation.id), diagnostics()).toMatchObject({
      phase: 'complete',
      verification: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(
      first.received.some((message) => message.t === 'response' && message.id === applyId),
    ).toBe(false);
    await wait(
      async () => relay.online() && (await inspectConnectorManager(f.home))?.version === '0.4.1',
      'Replacement connector reconnect',
    );
    const replacementConnector = (await inspectConnectorManager(f.home))!;
    expect(replacementConnector.pid).not.toBe(firstConnector.pid);
    expect(replacementConnector.instance).not.toBe(firstConnector.instance);
    expect(readRuntime(f.paths)!.pid).not.toBe(firstDaemon);
    expect(
      devices.maintenanceClaim(
        device.id,
        browserPeer,
        relay.registration.account,
        relay.registration.host,
      ),
    ).toEqual(grant);
    const next = await connectBrowser();
    const status = await next.maintenance({ action: 'status', id: operation.id });
    expect(status).toMatchObject({
      kind: 'status',
      status: {
        daemon_version: '0.4.1',
        result: { operation: { id: operation.id, phase: 'complete', dispatched: true } },
        catalogue: { releases: { repository: null } },
      },
    });
    expect(
      next.requests
        .filter((request) => request.path.startsWith('/api/host/updates'))
        .map((request) => request.method),
    ).toEqual(['GET']);
    expect(ownerPid(original.owner.runtime_id)).toBe(originalOwnerPid);
    expect(terminal(state(original.owner.runtime_id))).toMatchObject({
      pid: main.pid,
      generation: main.generation,
    });
    expect(readHostUpdateAdoption(f.home, operation.id).owners).toContainEqual(
      expect.objectContaining({ runtime_id: original.owner.runtime_id, state: 'running' }),
    );
    expect(f.runtimes.ownerOf(original.session.id)).toMatchObject({
      runtime_id: original.owner.runtime_id,
      build: '0.4.0',
      release_path: original.owner.release_path,
    });
    await next.stream();
    await next.terminal({
      t: 'attach',
      session: original.session.id,
      term: 'agent',
      cols: 90,
      rows: 25,
    });
    await next.terminal({
      t: 'stdin',
      session: original.session.id,
      term: 'agent',
      data: 'kill -0 "$background" && printf "after:%s:%s:%s\\n" "$preserved" "$PWD" "$background"\n',
    });
    await wait(
      () => next.text().includes(`after:encrypted_upgrade:/:${background}`),
      'Preserved encrypted shell state',
    );
    const fresh = await create(next);
    expect(fresh.owner).toMatchObject({
      build: '0.4.1',
      release_path: realpathSync(join(f.home, 'bin/runtime-current')),
    });
    expect(fresh.owner.runtime_id).not.toBe(original.owner.runtime_id);
    const mutations = readFileSync(join(services, 'mutations'), 'utf8').split('\n');
    for (const component of ['puddled', 'puddle-connector']) {
      expect(
        mutations.filter((line) => line.startsWith(`stop ${component}.service `)),
      ).toHaveLength(1);
      expect(
        mutations.filter((line) => line.startsWith(`start ${component}.service `)),
      ).toHaveLength(2);
    }
    expect(mutations.filter((line) => line.startsWith('start puddle-update-'))).toHaveLength(1);
    expect(
      browsers
        .flatMap((browser) => browser.requests)
        .filter(
          (request) =>
            request.method === 'POST' &&
            request.path === '/api/host/updates' &&
            (request.body as { action?: string })?.action === 'apply',
        ),
    ).toHaveLength(1);
  } catch (error) {
    throw new Error(diagnostics(), { cause: error });
  } finally {
    for (const browser of browsers) browser.close();
    try {
      for (const name of ['puddle-connector.service', 'puddled.service'])
        if (existsSync(join(services, `${name}.pid`))) await manager('stop', name);
      for (const file of readdirSync(services).filter(
        (name) =>
          name.endsWith('.pid') &&
          !['puddled.service.pid', 'puddle-connector.service.pid'].includes(name),
      ))
        await manager('stop', file.slice(0, -4));
    } catch (error) {
      retainRuntimeHome(f.home);
      // eslint-disable-next-line no-unsafe-finally -- Preserve executables unless all isolated jobs have ended.
      throw new Error(`Remote update fixture cleanup failed; retained ${f.home}`, { cause: error });
    } finally {
      devices?.close();
      f.db.close();
      await relay.close();
    }
  }
}, 180_000);

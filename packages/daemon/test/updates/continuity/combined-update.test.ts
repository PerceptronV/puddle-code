import { execFile } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  hostStageReceiptSchema,
  runtimeStateSchema,
  runtimeSupervisorSchema,
  sessionSchema,
  type HostUpdateOperation,
  type WsServerMessage,
} from '@puddle/shared';
import { ipcPath } from '@puddle/shared/node';
import { HostControlClient } from '@puddle/shared/node/host-control';
import {
  readRuntimeController,
  readRuntimeJson,
  runtimeDirectory,
} from '../../../src/runtime/ownership/storage.js';
import { HostUpdateOperations } from '../../../src/updates/operations/store.js';
import { readHostUpdateAdoption } from '../../../src/updates/checkpoints/adoption.js';
import { readHostUpdateCheckpoint } from '../../../src/updates/checkpoints/store.js';
import { readRuntime } from '../../../src/runtime-file.js';
import { runtimeDatabase } from '../../helpers/runtime-database.js';
import { retainRuntimeHome, terminal } from '../../helpers/runtime-fixture.js';
import {
  continuityRelease,
  continuitySupervisor,
  installer,
} from '../../helpers/update-continuity/release.js';
import { sh } from '../../helpers/git-fixtures.js';

it('upgrades bundled daemon and runtime through host authority while the existing shell keeps its process state', async () => {
  const f = runtimeDatabase();
  const controls: HostControlClient[] = [];
  const sockets: WebSocket[] = [];
  const env = await continuitySupervisor(f.home);
  const services = join(f.home, 'test-services');
  const run = (file: string, args: string[]) =>
    promisify(execFile)(file, args, { env, timeout: 45_000, maxBuffer: 1024 * 1024 });
  const manager = (...args: string[]) => run(join(services, 'systemctl'), ['--user', ...args]);
  const reference = ({ id, revision }: HostUpdateOperation) => ({ id, revision });
  const authority = async () => {
    const client = new HostControlClient(async () => connect(ipcPath(f.home, 'host')));
    controls.push(client);
    await client.establish();
    return client;
  };
  const diagnostics = () =>
    readdirSync(services)
      .filter((file) => file.endsWith('.log'))
      .map((file) => `${file}: ${readFileSync(join(services, file), 'utf8').slice(-4000)}`)
      .join('\n');
  const wait = async (condition: () => boolean, label: string, timeout = 30_000) => {
    const deadline = Date.now() + timeout;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`${label}\n${diagnostics()}`);
      await delay(30);
    }
  };
  const install = async (
    archive: string,
    version: string,
    component: 'daemon' | 'runtime',
    stage = false,
  ) =>
    run('/bin/sh', [
      installer,
      '--version',
      version,
      '--tarball',
      archive,
      '--sums',
      `${archive}.sha256`,
      '--component',
      component,
      ...(stage ? ['--stage-only'] : ['--no-supervisor']),
    ]);
  const create = async (control: HostControlClient) => {
    const response = await fetch(`http://127.0.0.1:${control.port}/api/sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${control.credential()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ project_id: f.project.id, kind: 'terminal', cwd: '.' }),
      signal: AbortSignal.timeout(30_000),
    });
    const body: unknown = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(201);
    const session = sessionSchema.parse(body);
    const owner = f.runtimes.ownerOf(session.id)!;
    return { session, owner };
  };
  const state = (id: string) =>
    runtimeStateSchema.parse(readRuntimeJson(join(runtimeDirectory(f.home, id), 'state.json')));
  const ownerPid = (id: string) => {
    const record = runtimeSupervisorSchema.parse(
      readRuntimeJson(join(runtimeDirectory(f.home, id), 'supervisor.json')),
    );
    return Number(readFileSync(join(services, `${record.name}.pid`), 'utf8'));
  };
  const viewer = async (control: HostControlClient, session: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${control.port}/ws`);
    sockets.push(ws);
    const messages: WsServerMessage[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(String(data)) as WsServerMessage));
    await once(ws, 'open');
    const send = (message: object) => ws.send(JSON.stringify(message));
    const resource = control.resource(() => ws.terminate());
    ws.once('close', () => resource.release());
    send({ t: 'auth', token: control.credential(), resource: resource.id });
    await wait(
      () => messages.some((message) => message.t === 'authenticated'),
      'Viewer authentication failed',
    );
    send({ t: 'attach', session, term: 'agent', cols: 90, rows: 25 });
    await wait(() => messages.some((message) => message.t === 'replay'), 'Viewer replay failed');
    return {
      messages,
      text: () =>
        messages
          .flatMap((message) =>
            message.t === 'output' || message.t === 'replay' ? [message.data] : [],
          )
          .join(''),
      input: (data: string) => send({ t: 'stdin', session, term: 'agent', data }),
    };
  };
  try {
    // Reuse the normal placement/database fixture; all live owners below are
    // created through production HTTP SessionService and the installed selector.
    f.runtimes.finish(f.binding.runtime_id, 'exited', () =>
      f.sessions.setStatus(f.session.id, 'exited'),
    );
    await f.reconciler.close();
    f.controller.release();
    sh(f.home, 'init', '-b', 'main');
    const previousArchive = await continuityRelease(f.home, '0.3.14');
    await install(previousArchive, '0.3.14', 'daemon');
    await install(previousArchive, '0.3.14', 'runtime');
    writeFileSync(join(f.home, 'supervisor'), 'systemd\n', { mode: 0o600 });
    await manager('start', 'puddled.service');
    await wait(() => !!readRuntime(f.paths), 'Original daemon did not become ready');
    const firstControl = await authority();
    expect(firstControl.version?.version).toBe('0.3.14');
    const originalDaemon = readRuntime(f.paths)!.pid;
    const originalController = readRuntimeController(f.home);
    const original = await create(firstControl);
    const main = terminal(state(original.owner.runtime_id));
    const originalOwnerPid = ownerPid(original.owner.runtime_id);
    const firstViewer = await viewer(firstControl, original.session.id);
    firstViewer.input(
      'set +H\nstty -echo; preserved=before_upgrade; cd /; sleep 120 & background=$!; printf "before:%s:%s:%s\\n" "$preserved" "$PWD" "$background"\n',
    );
    await wait(
      () => firstViewer.text().includes('before:before_upgrade:/:'),
      'Original shell did not accept input',
    ).catch((error: unknown) => {
      throw new Error(JSON.stringify(firstViewer.messages), { cause: error });
    });
    const background = /before:before_upgrade:\/:(\d+)/.exec(firstViewer.text())![1]!;

    const archive = await continuityRelease(f.home, '0.4.0');
    const begun = await firstControl.hostUpdate({
      action: 'begin',
      targets: [
        { component: 'daemon', version: '0.4.0' },
        { component: 'runtime', version: '0.4.0' },
      ],
    });
    expect(begun.ok).toBe(true);
    let operation = begun.operation!;
    for (const component of ['daemon', 'runtime'] as const) {
      const output = await install(archive, '0.4.0', component, true);
      const line = output.stdout
        .split('\n')
        .find((value) => value.startsWith('PUDDLE_HOST_STAGE '))!;
      const receipt = hostStageReceiptSchema.parse(
        JSON.parse(line.slice('PUDDLE_HOST_STAGE '.length)),
      );
      const staged = await firstControl.hostUpdate({
        action: 'stage',
        reference: reference(operation),
        receipt,
      });
      expect(staged.ok).toBe(true);
      operation = staged.operation!;
    }
    const reviewed = await firstControl.hostUpdate({
      action: 'inspect',
      reference: reference(operation),
      frontend: PROTOCOL_VERSION,
    });
    expect(reviewed, JSON.stringify(reviewed)).toMatchObject({
      ok: true,
      review: { can_apply: true },
    });
    if (!reviewed.ok || !reviewed.review?.fingerprint) throw new Error('No approved update review');
    const applied = await firstControl.hostUpdate({
      action: 'apply',
      reference: reference(reviewed.operation!),
      fingerprint: reviewed.review!.fingerprint!,
      frontend: PROTOCOL_VERSION,
    });
    expect(applied, JSON.stringify(applied)).toMatchObject({ ok: true });
    firstControl.close();
    const store = new HostUpdateOperations(f.home);
    await wait(
      () => ['complete', 'recovery_required'].includes(store.read(operation.id)!.phase),
      'Combined update did not finish',
      45_000,
    );
    expect(store.read(operation.id), diagnostics()).toMatchObject({
      phase: 'complete',
      verification: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const adoption = readHostUpdateAdoption(f.home, operation.id);
    const checkpoint = readHostUpdateCheckpoint(f.home, operation.id);
    expect(adoption.daemon.pid).not.toBe(originalDaemon);
    expect(adoption.daemon.controller.epoch).toBeGreaterThan(originalController.epoch);
    expect(adoption.owners).toContainEqual(
      expect.objectContaining({ runtime_id: original.owner.runtime_id, state: 'running' }),
    );
    expect(checkpoint.owners).toContainEqual(
      expect.objectContaining({
        identity: expect.objectContaining({ runtime_id: original.owner.runtime_id }),
      }),
    );
    const nextControl = await authority();
    expect(nextControl.version?.version).toBe('0.4.0');
    expect(ownerPid(original.owner.runtime_id)).toBe(originalOwnerPid);
    process.kill(originalOwnerPid, 0);
    expect(terminal(state(original.owner.runtime_id))).toMatchObject({
      pid: main.pid,
      generation: main.generation,
    });
    expect(f.runtimes.ownerOf(original.session.id)).toMatchObject({
      runtime_id: original.owner.runtime_id,
      release_path: original.owner.release_path,
      build: '0.3.14',
    });
    const nextViewer = await viewer(nextControl, original.session.id);
    expect(nextViewer.text()).toContain(`before:before_upgrade:/:${background}`);
    nextViewer.input(
      'kill -0 "$background" && printf "after:%s:%s:%s\\n" "$preserved" "$PWD" "$background"\n',
    );
    await wait(
      () => nextViewer.text().includes(`after:before_upgrade:/:${background}`),
      'Adopted shell lost its state',
    );
    const fresh = await create(nextControl);
    expect(fresh.owner).toMatchObject({
      build: '0.4.0',
      release_path: realpathSync(join(f.home, 'bin/runtime-current')),
    });
    expect(fresh.owner.runtime_id).not.toBe(original.owner.runtime_id);
    expect(fresh.owner.release_path).not.toBe(original.owner.release_path);
    const mutations = readFileSync(join(services, 'mutations'), 'utf8').split('\n');
    expect(mutations.filter((line) => line.startsWith('stop puddled.service '))).toHaveLength(1);
    expect(mutations.filter((line) => line.startsWith('start puddled.service '))).toHaveLength(2);
    expect(mutations.filter((line) => line.startsWith('start puddler-'))).toHaveLength(2);
  } finally {
    for (const control of controls) control.close();
    for (const ws of sockets) ws.terminate();
    try {
      if (existsSync(join(services, 'puddled.service.pid')))
        await manager('stop', 'puddled.service');
      for (const file of readdirSync(services).filter(
        (name) => name.endsWith('.pid') && name !== 'puddled.service.pid',
      ))
        await manager('stop', file.slice(0, -4));
    } catch (error) {
      retainRuntimeHome(f.home);
      // eslint-disable-next-line no-unsafe-finally -- Keep executable trees if isolated process cleanup cannot be confirmed.
      throw new Error(`Upgrade fixture cleanup failed; retained ${f.home}`, { cause: error });
    } finally {
      f.db.close();
    }
  }
}, 120_000);

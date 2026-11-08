import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { connect as connectSocket } from 'node:net';
import { once } from 'node:events';
import {
  realpathSync,
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  huddleOwnerLaunchSchema,
  HUDDLE_RUNTIME_CAPABILITIES,
  type HuddleOwnerLaunch,
} from '@puddle/shared';
import { atomicPrivateJson, ipcPath } from '@puddle/shared/node';
import { HuddleRevisionStore } from '../../../src/runtime/huddle/state/revisions.js';
import { huddleRevisionDigest } from '../../../src/huddle/definitions/revision.js';
import { resolveHuddleRuntimeRelease } from '../../../src/runtime/huddle/control/release.js';
import { runtimeRelease } from '../../helpers/runtime-release.js';
import { HuddleOwnerClient } from '../../../src/runtime/huddle/transport/client.js';
import {
  acquireRuntimeControllerWhenAvailable,
  runtimeDirectory,
} from '../../../src/runtime/ownership/storage.js';
import { acquireHostClaim } from '../../../src/security/claims.js';
import { withInterval } from '../../helpers/huddle/interval.js';
import { schedulerSnapshot } from '../../helpers/huddle/scheduler.js';
import {
  prepare,
  launchOwner,
  controllers,
  bundleDir,
  children,
  environment,
} from '../../helpers/runtime-fixture.js';
import { readRuntimeFrames, writeRuntimeFrame } from '../../../src/runtime/transport/framing.js';

const clients: HuddleOwnerClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = performance.now() + 10_000;
  while (!(await check())) {
    if (performance.now() >= deadline) throw new Error('Huddle fixture observation timed out');
    await sleep(20);
  }
}
function fixture(source: string, concurrency = 1, interval = false) {
  const base = prepare();
  if (interval) {
    base.home = realpathSync(base.home);
    base.launch.identity.canonical_worktree_path = base.home;
  }
  const huddleId = randomBytes(16).toString('hex');
  const snapshot = schedulerSnapshot(huddleId, source);
  snapshot.definition.execution.concurrency = concurrency;
  snapshot.definition.nodes.find((node) => node.id === 'worker')!.concurrency = concurrency;
  snapshot.files['huddle.json'] = JSON.stringify(snapshot.definition);
  snapshot.digest = huddleRevisionDigest(snapshot.files, snapshot.components);
  if (interval) {
    withInterval(snapshot);
    const root = join(base.home, '.puddle', 'huddle', huddleId);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'huddle.json'), snapshot.files['huddle.json']!);
  }
  const launch = huddleOwnerLaunchSchema.parse({
    format: 1,
    role: 'huddle',
    contract: 1,
    capabilities: HUDDLE_RUNTIME_CAPABILITIES,
    identity: base.launch.identity,
    scope: {
      hostId: 'fixture',
      runtimeId: base.launch.identity.runtime_id,
      profileId: base.launch.identity.profile_id,
      projectId: base.launch.identity.project_id,
      sessionId: base.launch.identity.session_id,
      huddleId,
    },
    secret: base.launch.secret,
    build: 'runtime-test',
    lifetime: 'service',
    initial: {
      id: randomUUID(),
      revision: snapshot.digest,
      worktree: base.home,
      variables: {},
      bindings: {},
    },
  });
  const directory = runtimeDirectory(base.home, launch.identity.runtime_id);
  new HuddleRevisionStore(base.home, launch.identity.runtime_id, huddleId).publish(snapshot);
  atomicPrivateJson(join(directory, 'launch.json'), launch);
  return { ...base, launch, directory };
}
async function connect(
  f: ReturnType<typeof fixture>,
  launch: HuddleOwnerLaunch = f.launch,
  controller = f.controller.record,
) {
  const client = await HuddleOwnerClient.open(f.home, launch, controller);
  clients.push(client);
  return client;
}
async function start(f: ReturnType<typeof fixture>) {
  const child = launchOwner(f.home, f.launch.identity.runtime_id);
  await until(() => {
    if (child.child.exitCode !== null) throw new Error(child.errors());
    return existsSync(join(f.directory, 'huddle-owner.json'));
  });
  let client: HuddleOwnerClient | undefined;
  await until(async () => {
    try {
      client = await connect(f);
      return true;
    } catch (error) {
      if (child.child.exitCode !== null) throw error;
      return false;
    }
  });
  return { ...child, client: client! };
}
async function arm(client: HuddleOwnerClient) {
  await client.request({
    t: 'arm',
    expectedGeneration: client.state!.control.generation,
    autoStart: false,
  });
}
const wrap = (source: string) =>
  `import {HuddleNode} from 'puddlang/huddle'; import fs from 'node:fs'; export default HuddleNode({contract:'./node.json', async run({inputs}) { ${source} }});`;

describe('independent huddle owner process', () => {
  it('admits interval events without a controller, then interrupts and rearms future occurrences', async () => {
    const f = fixture(wrap('return {completed: inputs.value};'), 1, true);
    const { client, child } = await start(f);
    await arm(client);
    client.close();
    f.controller.release();
    await sleep(2300);
    const replacement = await acquireRuntimeControllerWhenAvailable(f.home);
    controllers.push(replacement);
    const observer = await connect(f, f.launch, replacement.record);
    const records = () => observer.request({ t: 'records', collection: 'executions', after: 0 });
    await until(async () => {
      const response = await records();
      if (response.t === 'records') {
        const failed = response.rows.find((row) =>
          ['failed', 'interrupted'].includes(JSON.parse(row.body).state),
        );
        if (failed) throw new Error(failed.body);
      }
      const inspected = await observer.request({ t: 'inspect' });
      if (inspected.t === 'state' && inspected.state.failure)
        throw new Error(inspected.state.failure);
      return (
        response.t === 'records' &&
        response.rows.filter((row) => JSON.parse(row.body).state === 'completed').length >= 2
      );
    });
    await observer.request({ t: 'interrupt' });
    const before = await records();
    expect(before.t).toBe('records');
    await sleep(1200);
    const paused = await records();
    expect(paused).toMatchObject({ rows: before.t === 'records' ? before.rows : [] });
    await arm(observer);
    await until(async () => {
      const response = await records();
      return (
        response.t === 'records' &&
        before.t === 'records' &&
        response.rows.length > before.rows.length
      );
    });
    await observer.request({ t: 'shutdown' });
    await until(() => child.exitCode !== null);
    expect(child.exitCode).toBe(0);
  });

  it('stops timer admission visibly if the definition disappears', async () => {
    const f = fixture(wrap('return {completed: inputs.value};'), 1, true);
    const { client } = await start(f);
    await arm(client);
    unlinkSync(join(f.home, '.puddle', 'huddle', f.launch.scope.huddleId, 'huddle.json'));
    await until(async () => {
      const state = await client.request({ t: 'inspect' });
      return state.t === 'state' && state.state.failure !== null;
    });
    const records = await client.request({ t: 'records', collection: 'executions', after: 0 });
    expect(records).toMatchObject({ t: 'records', rows: [] });
    await client.request({ t: 'shutdown' });
  });

  it('wakes an active scheduler when a new root can use another worker slot', async () => {
    const f = fixture(
      wrap(
        `fs.writeFileSync(inputs.value.marker, 'x'); while (inputs.value.release && !fs.existsSync(inputs.value.release)) await new Promise(r => setTimeout(r, 10)); return {completed: 42};`,
      ),
      2,
    );
    const { client } = await start(f);
    await arm(client);
    const first = join(f.home, 'first');
    const second = join(f.home, 'second');
    const release = join(f.home, 'release');
    await client.request({
      t: 'run',
      node: 'run',
      eventId: 'first',
      data: { marker: first, release },
    });
    await until(() => existsSync(first));
    await client.request({ t: 'run', node: 'run', eventId: 'second', data: { marker: second } });
    await until(() => existsSync(second));
    expect(existsSync(release)).toBe(false);
    writeFileSync(release, 'go');
  });
  it('refuses a launch without the common host memory grant before consuming its intent', async () => {
    const f = fixture(wrap('return {completed: 42};'));
    const child = spawn(
      process.execPath,
      [join(bundleDir, 'puddler.mjs'), '--home', f.home, '--runtime', f.launch.identity.runtime_id],
      {
        env: environment(f.home),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      },
    );
    children.push(child);
    let errors = '';
    child.stderr.on('data', (chunk: Buffer) => {
      errors += chunk.toString();
    });
    await once(child, 'exit');
    expect(child.exitCode).not.toBe(0);
    expect(errors).toContain('no complete pre-dispatch memory admission');
    expect(existsSync(join(f.directory, 'consumed.json'))).toBe(false);
    expect(existsSync(join(f.directory, 'huddle.sqlite'))).toBe(false);
  });

  it('refuses a changed pinned build before consuming the launch', async () => {
    const f = fixture(wrap('return {completed: 42};'));
    atomicPrivateJson(join(f.directory, 'launch.json'), { ...f.launch, build: 'other-build' });
    const owner = launchOwner(f.home, f.launch.identity.runtime_id);
    await once(owner.child, 'exit');
    expect(owner.child.exitCode).not.toBe(0);
    expect(owner.errors()).toContain('differs from its pinned launch');
    expect(existsSync(join(f.directory, 'consumed.json'))).toBe(false);
  });

  it('refuses unsupported definition capabilities before consuming the launch', async () => {
    const f = fixture(wrap('return {completed: 42};'));
    atomicPrivateJson(join(f.directory, 'launch.json'), {
      ...f.launch,
      capabilities: { ...f.launch.capabilities, definition: 2 },
    });
    const owner = launchOwner(f.home, f.launch.identity.runtime_id);
    await once(owner.child, 'exit');
    expect(owner.child.exitCode).not.toBe(0);
    expect(owner.errors()).toContain('unsupported runtime capabilities');
    expect(existsSync(join(f.directory, 'consumed.json'))).toBe(false);
  });

  it('observes one accepted run after its acknowledgement is discarded', async () => {
    const f = fixture(
      wrap(`fs.appendFileSync(inputs.value + '/effects', 'x'); return {completed: 42};`),
    );
    const { client } = await start(f);
    await arm(client);
    client.close();
    const socket = connectSocket(ipcPath(f.home, `runtime:${f.launch.identity.runtime_id}`));
    socket.on('error', () => socket.destroy());
    await once(socket, 'connect');
    try {
      const state = new Promise<{ commandCursor: number }>((resolve, reject) => {
        const stop = readRuntimeFrames(
          socket,
          (raw) => {
            const reply = raw as { t: string; state: { commandCursor: number } };
            stop();
            if (reply.t !== 'state') reject(new Error('Fixture handshake failed'));
            else resolve(reply.state);
          },
          reject,
        );
      });
      writeRuntimeFrame(socket, {
        t: 'hello',
        id: randomUUID(),
        role: 'huddle',
        contract: 1,
        identity: f.launch.identity,
        secret: f.launch.secret,
        controllerId: f.controller.record.id,
        controllerEpoch: f.controller.record.epoch,
      });
      const handshake = await state;
      // Stop consuming replies before issuing the mutation. Execution proves admission separately.
      socket.pause();
      writeRuntimeFrame(socket, {
        t: 'run',
        id: randomUUID(),
        sequence: handshake.commandCursor + 1,
        node: 'run',
        eventId: 'lost-reply',
        data: f.home,
      });
      await until(() => existsSync(join(f.home, 'effects')));
    } finally {
      socket.destroy();
    }
    const observer = await connect(f);
    const result = await observer.request({ t: 'records', collection: 'executions', after: 0 });
    expect(result.t === 'records' && result.rows.length).toBe(1);
    expect(readFileSync(join(f.home, 'effects'), 'utf8')).toBe('x');
    const duplicate = await observer.request({
      t: 'run',
      node: 'run',
      eventId: 'lost-reply',
      data: f.home,
    });
    expect(duplicate).toMatchObject({ t: 'run', duplicate: true });
    expect(readFileSync(join(f.home, 'effects'), 'utf8')).toBe('x');
  });

  it('finishes a captured script without a controller and adopts it once after replacement', async () => {
    const f = fixture(
      wrap(
        `fs.writeFileSync(inputs.value + '/entered', 'yes'); while (!fs.existsSync(inputs.value + '/release')) await new Promise(r => setTimeout(r, 10)); fs.appendFileSync(inputs.value + '/effects', 'once\n'); return {completed: 42};`.replace(
          "'once\n'",
          "'once\\n'",
        ),
      ),
    );
    const { client, child } = await start(f);
    expect(client.state?.control.state).toBe('stopped');
    await arm(client);
    const admitted = await client.request({ t: 'run', node: 'run', eventId: 'one', data: f.home });
    expect(admitted.t).toBe('run');
    await until(() => existsSync(join(f.home, 'entered')));
    const incarnation = client.state!.identity.incarnation;
    client.close();
    f.controller.release();
    writeFileSync(join(f.home, 'release'), 'go');
    await until(() => existsSync(join(f.home, 'effects')));
    const replacement = await acquireRuntimeControllerWhenAvailable(f.home);
    controllers.push(replacement);
    // An unsupported new default blocks future huddles, not adoption of this pinned live owner.
    runtimeRelease(f.home, '0.0.1', '1.0').select();
    expect(() => resolveHuddleRuntimeRelease(f.home)).toThrow(/capability metadata/);
    const observer = await connect(f, f.launch, replacement.record);
    expect(observer.state?.identity.incarnation).toBe(incarnation);
    await until(async () => {
      const result = await observer.request({ t: 'records', collection: 'executions', after: 0 });
      return (
        result.t === 'records' &&
        result.rows.some((row) => JSON.parse(row.body).state === 'completed')
      );
    });
    const duplicate = await observer.request({
      t: 'run',
      node: 'run',
      eventId: 'one',
      data: f.home,
    });
    expect(duplicate).toMatchObject({
      t: 'run',
      duplicate: true,
      executionId: admitted.t === 'run' ? admitted.executionId : '',
    });
    expect(readFileSync(join(f.home, 'effects'), 'utf8')).toBe('once\n');
    expect(() => acquireHostClaim(f.home, `runtime:${f.launch.identity.runtime_id}`)).toThrow();
    const exited = once(child, 'exit');
    await observer.request({ t: 'shutdown' });
    await exited;
    expect(JSON.parse(readFileSync(join(f.directory, 'huddle-owner.json'), 'utf8')).state).toBe(
      'exited',
    );
    const claim = acquireHostClaim(f.home, `runtime:${f.launch.identity.runtime_id}`);
    claim.release();
    const replay = launchOwner(f.home, f.launch.identity.runtime_id);
    await once(replay.child, 'exit');
    expect(replay.child.exitCode).not.toBe(0);
    expect(replay.errors()).toMatch(/EEXIST/);
    expect(readFileSync(join(f.home, 'effects'), 'utf8')).toBe('once\n');
  });

  it('rejects a wrong secret, changed scope and a released controller epoch', async () => {
    const f = fixture(wrap('return {completed: 42};'));
    const { client } = await start(f);
    await expect(connect(f, { ...f.launch, secret: '0'.repeat(64) })).rejects.toThrow(/fenced/);
    await expect(
      connect(f, { ...f.launch, identity: { ...f.launch.identity, profile_id: 'aaaaaaaaaa' } }),
    ).rejects.toThrow(/fenced/);
    f.controller.release();
    await expect(client.request({ t: 'inspect' })).rejects.toThrow(/fenced/);
    const replacement = await acquireRuntimeControllerWhenAvailable(f.home);
    controllers.push(replacement);
    const next = await connect(f, f.launch, replacement.record);
    expect(next.state?.identity).toEqual(f.launch.identity);
  });

  it('interrupts a busy script without ending its owner and never starts cancelled queued roots', async () => {
    const f = fixture(wrap(`fs.appendFileSync(inputs.value + '/entered', 'x'); for (;;) {}`));
    const { client, child } = await start(f);
    await arm(client);
    await client.request({ t: 'run', node: 'run', eventId: 'active', data: f.home });
    await until(() => existsSync(join(f.home, 'entered')));
    await client.request({ t: 'run', node: 'run', eventId: 'queued', data: f.home });
    const interrupted = await client.request({ t: 'interrupt' });
    expect(interrupted).toMatchObject({
      t: 'state',
      state: { liveWorkers: false, control: { state: 'interrupted' } },
    });
    expect(child.exitCode).toBeNull();
    const result = await client.request({ t: 'records', collection: 'executions', after: 0 });
    expect(result.t === 'records' && result.rows.map((row) => JSON.parse(row.body).state)).toEqual([
      'interrupted',
      'cancelled',
    ]);
    await arm(client);
    expect(readFileSync(join(f.home, 'entered'), 'utf8')).toBe('x');
  });
});

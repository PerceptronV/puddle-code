import { execFile } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { build } from 'esbuild';
import WebSocket from 'ws';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { runtimeStateSchema, type Session, type WsServerMessage } from '@puddle/shared';
import { ipcPath } from '@puddle/shared/node';
import { AttachedDaemon } from '../../../../cli/src/lib/connection/attached-daemon.js';
import {
  acquireAuthority,
  type HostConnection,
} from '../../../../cli/src/lib/auth/connection-authority.js';
import { SshTransport, shellQuote } from '../../../../cli/src/lib/transport/ssh.js';
import { findFreePort } from '../../../../cli/src/lib/transport/net.js';
import { RuntimeStore } from '../../../src/db/stores/runtimes.js';
import { continuityRelease } from '../../helpers/update-continuity/release.js';
import { retainRuntimeHome, terminal } from '../../helpers/runtime-fixture.js';

const execute = promisify(execFile);
let scratch: string;
let release: string;
let retained = false;
const helper = (name: string) =>
  fileURLToPath(new URL(`../../helpers/runtime/attached/${name}.ts`, import.meta.url));
beforeAll(async () => {
  scratch = mkdtempSync(
    join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'puddle-attached-lifetime-'),
  );
  await continuityRelease(scratch, '0.4.0', true, {
    puddled: helper('daemon'),
    puddler: fileURLToPath(new URL('../../../src/runtime/index.ts', import.meta.url)),
  });
  release = join(scratch, 'test-archives/0.4.0/puddled-v0.4.0');
  // The fake SSH endpoint supplies a sanitised environment for each distinct HOME.
  for (const name of ['puddled', 'puddler'])
    writeFileSync(
      join(release, name),
      `#!/bin/sh\nexec ${shellQuote(join(release, 'bin/node'))} ${shellQuote(join(release, `daemon/${name}.mjs`))} "$@"\n`,
      { mode: 0o700 },
    );
  await build({
    entryPoints: [helper('ssh')],
    outfile: join(scratch, 'ssh.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    logLevel: 'warning',
  });
});
afterAll(() => {
  if (scratch && !retained) rmSync(scratch, { recursive: true, force: true });
});

// These are process/channel acceptance tests, not proof of native SSH logout,
// PAM/cgroup policy, permanent detached persistence or service-manager updates.
it.each([
  { reap: false, autoResume: true },
  { reap: true, autoResume: true },
  { reap: true, autoResume: false },
])(
  'attached closure and reconnect (reap=$reap, autoResume=$autoResume)',
  async ({ reap, autoResume }) => {
    const userHome = join(scratch, `${reap}-${autoResume}`);
    const home = join(userHome, '.puddle');
    mkdirSync(join(home, 'bin'), { recursive: true, mode: 0o700 });
    mkdirSync(join(home, 'logs'));
    symlinkSync(dirname(release), join(home, 'bin/versions'));
    symlinkSync(release, join(home, 'bin/current'));
    symlinkSync(release, join(home, 'bin/runtime-current'));
    writeFileSync(join(home, 'supervisor'), 'nohup\n', { mode: 0o600 });
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({ configVersion: 3, port: await findFreePort(), autoResume, agentPath: '' }),
    );
    const git = (args: string[]) =>
      execute('/usr/bin/git', args, {
        env: {
          HOME: userHome,
          PATH: '/usr/bin:/bin',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
      });
    const sshBinary = join(userHome, 'ssh');
    writeFileSync(
      sshBinary,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(scratch, 'ssh.mjs'))} ${shellQuote(userHome)} "$@"\n`,
      { mode: 0o700 },
    );
    // win32 selects dedicated channels and avoids creating a ControlMaster socket
    // under the test runner's real client home. Host bundles retain native platform.
    const transport = new SshTransport('fixture', { sshBinary, platform: 'win32' });
    const attached = new AttachedDaemon(transport);
    const controls: HostConnection[] = [];
    const sockets: WebSocket[] = [];
    const processes = new Map<number, string>();
    let db: Database.Database | undefined;
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
        throw error;
      }
    };
    const identity = async (pid: number) =>
      (await execute('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='])).stdout;
    const track = async (pid: number) => {
      processes.set(pid, await identity(pid));
      return pid;
    };
    const wait = async (condition: () => boolean | Promise<boolean>, label: string) => {
      const deadline = Date.now() + 20_000;
      while (!(await condition())) {
        if (Date.now() > deadline)
          throw new Error(
            `${label}\n${readFileSync(join(home, 'logs/puddled.out.log'), 'utf8').slice(-4000)}`,
          );
        await delay(40);
      }
    };
    const api = async <T>(control: HostConnection, path: string, body?: object): Promise<T> => {
      const response = await fetch(`http://127.0.0.1:${control.port}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          authorization: `Bearer ${control.credential()}`,
          'content-type': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      const value: unknown = await response.json();
      expect(
        response.ok,
        `${path}: ${JSON.stringify(value)}\n${readFileSync(join(home, 'logs/puddled.out.log'), 'utf8').slice(-4000)}`,
      ).toBe(true);
      return value as T;
    };
    const viewer = async (control: HostConnection, session: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${control.port}/ws`);
      sockets.push(ws);
      const messages: WsServerMessage[] = [];
      ws.on('message', (raw) => messages.push(JSON.parse(String(raw)) as WsServerMessage));
      await once(ws, 'open');
      const resource = control.resource(() => ws.terminate());
      ws.on('close', () => resource.release());
      const send = (value: object) => ws.send(JSON.stringify(value));
      send({ t: 'auth', token: control.credential(), resource: resource.id });
      await wait(() => messages.some((message) => message.t === 'authenticated'), 'Viewer auth');
      send({ t: 'attach', session, term: 'agent', cols: 90, rows: 25 });
      await wait(() => messages.some((message) => message.t === 'replay'), 'Viewer replay');
      return {
        input: (data: string) => send({ t: 'stdin', session, term: 'agent', data }),
        text: () =>
          messages
            .flatMap((message) =>
              message.t === 'output' || message.t === 'replay' ? [message.data] : [],
            )
            .join(''),
      };
    };
    const state = (id: string) =>
      runtimeStateSchema.parse(
        JSON.parse(readFileSync(join(home, 'runtimes', id, 'state.json'), 'utf8')),
      );
    const ownerPid = async (id: string) => {
      const output = (await execute('/bin/ps', ['-axo', 'pid=,command='])).stdout;
      const rows = output
        .split('\n')
        .filter((line) => line.includes(`--home ${home} --runtime ${id}`));
      expect(rows).toHaveLength(1);
      return track(Number(rows[0]!.trim().split(/\s+/)[0]));
    };
    const signalExact = async (pid: number, signal: NodeJS.Signals) => {
      if (!alive(pid)) return;
      try {
        expect(await identity(pid)).toBe(processes.get(pid));
        process.kill(pid, signal);
      } catch (error) {
        // The owner may have reaped its shell between the two observations.
        if (alive(pid)) throw error;
      }
    };
    const cleanup = async () => {
      for (const socket of sockets) socket.terminate();
      for (const control of controls) control.close();
      db?.close();
      try {
        await attached.stop();
        // Discover a launch that succeeded before an earlier assertion failed.
        const prefix = `${join(release, 'bin/node')} ${join(release, 'daemon/puddler.mjs')} --home ${home} --runtime `;
        const output = (await execute('/bin/ps', ['-axo', 'pid=,command='])).stdout;
        for (const line of output.split('\n')) {
          const match = /^\s*(\d+)\s+(.+)$/.exec(line);
          if (match?.[2]?.startsWith(prefix) && !processes.has(Number(match[1])))
            await track(Number(match[1]));
        }
        for (const [pid] of processes) await signalExact(pid, 'SIGTERM');
        await wait(
          () => [...processes.keys()].every((pid) => !alive(pid)),
          'Fixture process cleanup',
        );
        for (const name of existsSync(join(home, 'runtimes'))
          ? readdirSync(join(home, 'runtimes'))
          : [])
          rmSync(dirname(ipcPath(home, `runtime:${name}`)), { recursive: true, force: true });
        rmSync(dirname(ipcPath(home, 'host')), { recursive: true, force: true });
      } catch (error) {
        retained = true;
        retainRuntimeHome(home);
        throw new Error(`Attached lifetime cleanup uncertain; retained ${scratch}`, {
          cause: error,
        });
      } finally {
        transport.dispose();
      }
    };
    try {
      const endpoint = await attached.start();
      controls.push(endpoint.authority);
      expect(endpoint.daemonLifetime).toBe('frontend');
      db = new Database(join(home, 'puddle.db'), { readonly: true });
      const runtimes = new RuntimeStore(db);
      const projectPath = join(userHome, 'project');
      mkdirSync(projectPath);
      await git(['init', '-b', 'main', projectPath]);
      writeFileSync(join(projectPath, 'kept.txt'), 'retained\n');
      await git(['-C', projectPath, 'add', '.']);
      await git([
        '-C',
        projectPath,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-m',
        'seed',
      ]);
      const profile = await api<{ id: string }>(endpoint.authority, '/api/profiles', {
        name: 'attached',
      });
      const repo = await api<{ id: number }>(endpoint.authority, '/api/repos', {
        path: projectPath,
        fetch_enabled: false,
      });
      const project = await api<{ id: string }>(endpoint.authority, '/api/projects', {
        profile_id: profile.id,
        repo_id: repo.id,
        name: 'Attached',
      });
      const session = await api<Session>(endpoint.authority, '/api/sessions', {
        project_id: project.id,
        kind: 'terminal',
        cwd: '.',
      });
      const original = runtimes.ownerOf(session.id)!;
      const first = await viewer(endpoint.authority, session.id);
      const originalOwner = await ownerPid(original.runtime_id);
      await wait(() => state(original.runtime_id).terminals.length > 0, 'Original terminal');
      const originalShell = terminal(state(original.runtime_id));
      await track(originalShell.pid!);
      expect(state(original.runtime_id).lifetime).toBe('host_session');
      first.input(
        'set +H\nstty -echo; kept=attached; cd /; printf "before:%s:%s\\n" "$$" "$kept"\n',
      );
      await wait(
        () => first.text().includes(`before:${originalShell.pid}:attached`),
        'Original shell',
      );
      const marker = join(userHome, 'input-once');
      const completed = join(userHome, 'input-completed');
      first.input(
        `printf x >> ${shellQuote(marker)}; read ignored; printf done >> ${shellQuote(completed)}\n`,
      );
      await wait(() => existsSync(marker), 'Input side effect');
      expect(existsSync(completed)).toBe(false);
      await attached.stop();
      endpoint.authority.close();
      expect(existsSync(join(home, 'runtime.json'))).toBe(false);
      expect(alive(originalOwner)).toBe(true);
      expect(alive(originalShell.pid!)).toBe(true);
      if (reap) {
        // Deterministic external reaper, not a claim about this host's SSH/PAM policy.
        // Kill exactly the fixture's known shell and owner after the channel closes.
        await signalExact(originalShell.pid!, 'SIGKILL');
        await signalExact(originalOwner, 'SIGKILL');
        await wait(() => !alive(originalOwner) && !alive(originalShell.pid!), 'Reaped owner');
      }
      await attached.ensureRunning();
      const current = await acquireAuthority(transport);
      controls.push(current);
      if (reap && !autoResume) {
        await wait(
          async () =>
            (await api<Session>(current, `/api/sessions/${session.id}`)).status === 'interrupted',
          'Manual resumable placement',
        );
        expect(runtimes.live()).toEqual([]);
        await api(current, `/api/sessions/${session.id}/resume`, {});
      }
      await wait(() => runtimes.ownerOf(session.id)?.state === 'running', 'Reconnected placement');
      const resumed = runtimes.ownerOf(session.id)!;
      await wait(() => state(resumed.runtime_id).terminals.length > 0, 'Resumed terminal');
      const nextShell = terminal(state(resumed.runtime_id));
      await track(nextShell.pid!);
      const nextOwner = await ownerPid(resumed.runtime_id);
      expect(runtimes.live()).toHaveLength(1);
      if (reap) {
        expect(resumed.runtime_id).not.toBe(original.runtime_id);
        expect(nextOwner).not.toBe(originalOwner);
        expect(nextShell.pid).not.toBe(originalShell.pid);
      } else {
        expect(resumed.runtime_id).toBe(original.runtime_id);
        expect(nextOwner).toBe(originalOwner);
        expect(nextShell).toMatchObject({
          pid: originalShell.pid,
          generation: originalShell.generation,
        });
      }
      const next = await viewer(current, session.id);
      if (!reap) next.input('\n');
      else expect(existsSync(completed)).toBe(false);
      next.input('printf "after:%s:%s:%s\\n" "$$" "${kept-unset}" "$PWD"\n');
      await wait(
        () => next.text().includes(`after:${nextShell.pid}:${reap ? 'unset:' : 'attached:/'}`),
        'Reconnected shell state',
      );
      expect(readFileSync(marker, 'utf8')).toBe('x');
      expect(readFileSync(join(projectPath, 'kept.txt'), 'utf8')).toBe('retained\n');
      // A second healthy reconnect adopts; it neither starts a competing owner nor
      // retransmits prior viewer input whose acknowledgement may have been lost.
      await attached.ensureRunning();
      const observer = await acquireAuthority(transport);
      controls.push(observer);
      expect((await api<Session>(observer, `/api/sessions/${session.id}`)).id).toBe(session.id);
      expect(runtimes.live()).toHaveLength(1);
      expect(await ownerPid(resumed.runtime_id)).toBe(nextOwner);
      expect(readFileSync(marker, 'utf8')).toBe('x');
    } finally {
      await cleanup();
    }
  },
);

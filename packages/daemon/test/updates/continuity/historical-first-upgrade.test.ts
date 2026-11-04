import { execFile } from 'node:child_process';
import { once } from 'node:events';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { build } from 'esbuild';
import WebSocket from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  runtimeStateSchema,
  type Session,
  type WsServerMessage,
} from '@puddle/shared';
import { ipcPath } from '@puddle/shared/node';
import { HostControlClient } from '@puddle/shared/node/host-control';
import { DATABASE_SCHEMA_VERSION } from '../../../src/db/migrations/index.js';
import { RuntimeStore } from '../../../src/db/stores/runtimes.js';
import { terminal, retainRuntimeHome } from '../../helpers/runtime-fixture.js';
import {
  continuityRelease,
  continuitySupervisor,
  installer,
} from '../../helpers/update-continuity/release.js';
import {
  HISTORICAL_COMMIT,
  historicalRelease,
  repository,
} from '../../helpers/legacy-transition/historical/source.js';

type Control = Pick<
  HostControlClient,
  'port' | 'version' | 'establish' | 'credential' | 'resource' | 'close'
>;
const execute = promisify(execFile);
const enabled = process.env.PUDDLE_TEST_HISTORICAL_UPGRADE === '1';

/** Dedicated opt-in acceptance: needs the retained historical Git object, never downloads it. */
describe.runIf(enabled)('actual v0.3.14 source first upgrade', () => {
  let scratch: string;
  let historical: Awaited<ReturnType<typeof historicalRelease>>;
  let archive: string;
  let launcher: string;
  let retained = false;
  beforeAll(async () => {
    scratch = mkdtempSync(
      join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'puddle-historical-upgrade-'),
    );
    historical = await historicalRelease(scratch);
    archive = await continuityRelease(scratch, '0.4.0');
    launcher = join(scratch, 'current-launcher.mjs');
    await build({
      entryPoints: [
        fileURLToPath(
          new URL('../../helpers/legacy-transition/historical/launcher.ts', import.meta.url),
        ),
      ],
      outfile: launcher,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      alias: {
        '@puddle/shared/node/host-control': join(
          repository,
          'packages/shared/src/node/host-control.ts',
        ),
        '@puddle/shared/node': join(repository, 'packages/shared/src/node/security.ts'),
        '@puddle/shared': join(repository, 'packages/shared/src/index.ts'),
      },
      banner: {
        js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
      },
      logLevel: 'warning',
    });
    copyFileSync(installer, join(scratch, 'install.sh'));
  }, 90_000);
  afterAll(() => {
    if (scratch && !retained) rmSync(scratch, { recursive: true, force: true });
  });

  it.each([true, false])(
    'declines without disruption, then upgrades and resumes once (autoResume=%s)',
    async (autoResume) => {
      const userHome = join(scratch, autoResume ? 'automatic-user' : 'manual-user');
      const home = join(userHome, '.puddle');
      mkdirSync(home, { recursive: true, mode: 0o700 });
      const env = {
        ...(await continuitySupervisor(home)),
        HOME: userHome,
        USER: 'puddle-historical-fixture',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      };
      const services = join(home, 'test-services');
      renameSync(join(services, 'systemctl'), join(services, 'systemctl-worker'));
      await build({
        entryPoints: [
          fileURLToPath(
            new URL('../../helpers/legacy-transition/historical/supervisor.ts', import.meta.url),
          ),
        ],
        outfile: join(services, 'systemctl'),
        bundle: true,
        platform: 'node',
        format: 'esm',
        banner: { js: `#!${process.execPath}` },
        logLevel: 'warning',
      });
      const { chmodSync } = await import('node:fs');
      chmodSync(join(services, 'systemctl'), 0o700);
      writeFileSync(join(services, 'loginctl'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      const run = (file: string, args: string[]) =>
        execute(file, args, { env, cwd: userHome, timeout: 90_000, maxBuffer: 1024 * 1024 });
      const manager = (...args: string[]) => run(join(services, 'systemctl'), ['--user', ...args]);
      const diagnostics = () =>
        readdirSync(services)
          .filter((name) => name.endsWith('.log'))
          .map((name) => `${name}: ${readFileSync(join(services, name), 'utf8').slice(-4000)}`)
          .join('\n');
      const wait = async (condition: () => boolean, label: string, timeout = 30_000) => {
        const deadline = Date.now() + timeout;
        while (!condition()) {
          if (Date.now() >= deadline) throw new Error(`${label}\n${diagnostics()}`);
          await delay(30);
        }
      };
      const controls: Control[] = [];
      const sockets: WebSocket[] = [];
      const socketDirectories = new Set<string>([dirname(ipcPath(home, 'host'))]);
      let db: Database.Database | undefined;
      const descendants = new Map<number, string>();
      const processIdentity = async (pid: number) =>
        (await execute('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='])).stdout;
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
          throw error;
        }
      };
      const runtime = () =>
        JSON.parse(readFileSync(join(home, 'runtime.json'), 'utf8')) as {
          pid: number;
          port: number;
        };
      const api = async <T>(control: Control, path: string, body?: object): Promise<T> => {
        const response = await fetch(`http://127.0.0.1:${control.port}${path}`, {
          method: body ? 'POST' : 'GET',
          headers: {
            authorization: `Bearer ${control.credential()}`,
            'content-type': 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(20_000),
        });
        const value: unknown = await response.json();
        expect(response.ok, JSON.stringify(value)).toBe(true);
        return value as T;
      };
      const viewer = async (control: Control, session: string) => {
        const ws = new WebSocket(`ws://127.0.0.1:${control.port}/ws`);
        sockets.push(ws);
        const messages: WsServerMessage[] = [];
        ws.on('message', (raw) => messages.push(JSON.parse(String(raw)) as WsServerMessage));
        await once(ws, 'open');
        const resource = control.resource(() => ws.terminate());
        ws.on('close', () => resource.release());
        const send = (value: object) => ws.send(JSON.stringify(value));
        send({ t: 'auth', token: control.credential(), resource: resource.id });
        await wait(
          () => messages.some((message) => message.t === 'authenticated'),
          'Viewer not authenticated',
        );
        send({ t: 'attach', session, term: 'agent', cols: 90, rows: 25 });
        await wait(
          () => messages.some((message) => message.t === 'replay'),
          'Viewer has no replay',
        );
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
      const launch = async (decision: 'approve' | 'decline' | 'observe') => {
        const result = await run(process.execPath, [launcher, decision, archive]);
        return JSON.parse(result.stdout.trim()) as {
          ok: boolean;
          bootstrapped?: boolean;
          code?: string;
          prompts: Array<{
            liveSessions: number;
            daemon: { version: string; protocol: { major: number; minor: number } };
          }>;
          version?: { version: string; protocol: { major: number; minor: number } };
        };
      };
      const cleanup = async () => {
        for (const socket of sockets) socket.terminate();
        for (const control of controls) control.close();
        db?.close();
        let uncertain = false;
        for (const file of readdirSync(services)
          .filter((name) => name.endsWith('.pid'))
          .sort(
            (a, b) => Number(a === 'puddled.service.pid') - Number(b === 'puddled.service.pid'),
          )) {
          const pid = Number(readFileSync(join(services, file), 'utf8'));
          try {
            if (!alive(pid)) continue;
            const command = (await execute('/bin/ps', ['-p', String(pid), '-o', 'command=']))
              .stdout;
            if (!command.includes(home)) throw new Error('Fixture process identity changed');
            await manager('stop', file.slice(0, -4));
            if (alive(pid)) throw new Error('Fixture service remains alive');
          } catch {
            uncertain = true;
          }
        }
        if (uncertain) {
          retained = true;
          retainRuntimeHome(home);
          throw new Error(`Historical fixture cleanup is uncertain; retained ${scratch}`);
        }
        for (const [pid, identity] of descendants) {
          if (!alive(pid)) continue;
          try {
            if ((await processIdentity(pid)) !== identity)
              throw new Error('Fixture descendant identity changed');
            process.kill(pid, 'SIGTERM');
            await wait(() => !alive(pid), 'Fixture descendant did not stop', 10_000);
          } catch {
            retained = true;
            retainRuntimeHome(home);
            throw new Error(`Historical descendant cleanup is uncertain; retained ${scratch}`);
          }
        }
        for (const directory of socketDirectories)
          rmSync(directory, { recursive: true, force: true });
      };
      try {
        const reservation = createServer();
        await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
        const address = reservation.address();
        if (!address || typeof address === 'string') throw new Error('No isolated port');
        await new Promise<void>((resolve) => reservation.close(() => resolve()));
        writeFileSync(
          join(home, 'config.json'),
          JSON.stringify({ configVersion: 3, port: address.port, autoResume, agentPath: '' }),
        );
        await run('/bin/sh', [
          historical.installer,
          '--version',
          '0.3.14',
          '--tarball',
          historical.archive,
          '--sums',
          `${historical.archive}.sha256`,
          '--no-supervisor',
        ]);
        const previous = realpathSync(join(home, 'bin/current'));
        expect(previous).toBe(join(home, 'bin/versions/0.3.14'));
        expect(existsSync(join(home, 'bin/runtime-current'))).toBe(false);
        await manager('start', 'puddled.service');
        await wait(() => existsSync(join(home, 'runtime.json')), 'Historical daemon did not start');
        const { HostControlClient: HistoricalControl } = (await import(
          pathToFileURL(historical.control).href
        )) as {
          HostControlClient: new (open: () => Promise<ReturnType<typeof connect>>) => Control;
        };
        const old = new HistoricalControl(async () => connect(ipcPath(home, 'host')));
        controls.push(old);
        await old.establish();
        expect(old.version).toEqual({ version: '0.3.14', protocol: { major: 25, minor: 6 } });
        db = new Database(join(home, 'puddle.db'), { readonly: true });
        expect(db.pragma('user_version', { simple: true })).toBe(28);
        const worktree = join(userHome, 'project');
        mkdirSync(worktree);
        await run('/usr/bin/git', ['-C', worktree, 'init', '-b', 'main']);
        writeFileSync(join(worktree, 'retained.txt'), 'historical work survives\n');
        await run('/usr/bin/git', ['-C', worktree, 'add', '.']);
        await run('/usr/bin/git', [
          '-C',
          worktree,
          '-c',
          'user.name=Fixture',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '-m',
          'seed',
        ]);
        const profile = await api<{ id: string }>(old, '/api/profiles', {
          name: 'historical-profile',
        });
        const repo = await api<{ id: number }>(old, '/api/repos', {
          path: worktree,
          fetch_enabled: false,
        });
        const project = await api<{ id: string }>(old, '/api/projects', {
          profile_id: profile.id,
          repo_id: repo.id,
          name: 'Historical project',
        });
        const session = await api<Session>(old, '/api/sessions', {
          project_id: project.id,
          kind: 'terminal',
          cwd: '.',
        });
        const originalDaemon = runtime().pid;
        const oldViewer = await viewer(old, session.id);
        oldViewer.input(
          'set +H\nstty -echo; historical=before_upgrade; sleep 120 & historical_job=$!; printf "historical:%s:%s:%s:%s\\n" "$$" "$historical" "$PWD" "$historical_job"\n',
        );
        await wait(
          () => /historical:\d+:before_upgrade:/.test(oldViewer.text()),
          'Historical shell did not answer',
        ).catch((error: unknown) => {
          throw new Error(oldViewer.text(), { cause: error });
        });
        const original = /historical:(\d+):before_upgrade:([^\r\n]+):(\d+)/.exec(oldViewer.text())!;
        const originalShell = Number(original[1]);
        const background = Number(original[3]);
        descendants.set(originalShell, await processIdentity(originalShell));
        descendants.set(background, await processIdentity(background));
        const placement = db.prepare('SELECT * FROM sessions WHERE id=?').get(session.id) as Record<
          string,
          unknown
        >;
        const declined = await launch('decline');
        expect(declined).toMatchObject({
          ok: false,
          code: 'upgrade_failed',
          prompts: [
            { liveSessions: 1, daemon: { version: '0.3.14', protocol: { major: 25, minor: 6 } } },
          ],
        });
        expect(runtime().pid).toBe(originalDaemon);
        expect(alive(originalShell)).toBe(true);
        expect(alive(background)).toBe(true);
        expect(realpathSync(join(home, 'bin/current'))).toBe(previous);
        expect(existsSync(join(home, 'bin/runtime-current'))).toBe(false);
        expect(db.pragma('user_version', { simple: true })).toBe(28);
        oldViewer.input('printf "declined:%s:%s:%s\\n" "$$" "$historical" "$PWD"\n');
        await wait(
          () =>
            oldViewer.text().includes(`declined:${originalShell}:before_upgrade:${original[2]}`),
          'Declined upgrade disturbed the old shell',
        );
        const approved = await launch('approve');
        expect(approved).toMatchObject({
          ok: true,
          bootstrapped: true,
          version: { version: '0.4.0', protocol: PROTOCOL_VERSION },
        });
        expect(approved.prompts).toHaveLength(1);
        expect(runtime().pid).not.toBe(originalDaemon);
        await wait(
          () => !alive(originalDaemon) && !alive(originalShell),
          'Historical processes did not end',
        );
        expect(existsSync(previous)).toBe(true);
        const selected = realpathSync(join(home, 'bin/current'));
        expect(realpathSync(join(home, 'bin/runtime-current'))).toBe(selected);
        expect(db.pragma('user_version', { simple: true })).toBe(DATABASE_SCHEMA_VERSION);
        expect(db.pragma('foreign_key_check')).toEqual([]);
        const current = new HostControlClient(async () => connect(ipcPath(home, 'host')));
        controls.push(current);
        await current.establish();
        const runtimes = new RuntimeStore(db);
        if (!autoResume) {
          expect((await api<Session>(current, `/api/sessions/${session.id}`)).status).toBe(
            'interrupted',
          );
          expect(runtimes.live()).toEqual([]);
          await api(current, `/api/sessions/${session.id}/resume`, {});
        }
        await wait(
          () => runtimes.ownerOf(session.id)?.state === 'running',
          'Placement did not resume independently',
        );
        const owner = runtimes.ownerOf(session.id)!;
        socketDirectories.add(dirname(ipcPath(home, `runtime:${owner.runtime_id}`)));
        expect(owner).toMatchObject({
          launch_session_id: session.id,
          active_session_id: session.id,
          build: '0.4.0',
          release_path: selected,
        });
        const state = () =>
          runtimeStateSchema.parse(
            JSON.parse(
              readFileSync(join(home, 'runtimes', owner.runtime_id, 'state.json'), 'utf8'),
            ),
          );
        await wait(
          () => state().terminals.some((item) => item.term === 'agent'),
          'Resumed shell unavailable',
        );
        const resumedShell = terminal(state());
        const newViewer = await viewer(current, session.id);
        newViewer.input('printf "resumed:%s:%s\\n" "$$" "$PWD"\n');
        await wait(() => /resumed:\d+:/.test(newViewer.text()), 'Resumed shell did not answer');
        const newPid = Number(/resumed:(\d+):/.exec(newViewer.text())![1]);
        descendants.set(newPid, await processIdentity(newPid));
        expect(newPid).not.toBe(originalShell);
        expect(readFileSync(join(worktree, 'retained.txt'), 'utf8')).toBe(
          'historical work survives\n',
        );
        const retainedPlacement = db
          .prepare('SELECT * FROM sessions WHERE id=?')
          .get(session.id) as Record<string, unknown>;
        for (const key of [
          'id',
          'project_id',
          'worktree_path',
          'canonical_worktree_path',
          'branch',
          'base_branch',
          'created_at',
        ])
          expect(retainedPlacement[key], key).toEqual(placement[key]);
        const again = await launch('observe');
        expect(again).toMatchObject({ ok: true, bootstrapped: false, prompts: [] });
        expect(runtimes.live()).toHaveLength(1);
        expect(runtimes.ownerOf(session.id)?.runtime_id).toBe(owner.runtime_id);
        expect(terminal(state()).generation).toBe(resumedShell.generation);
        expect(
          db
            .prepare("SELECT count(*) AS count FROM events WHERE session_id=? AND type='resumed'")
            .get(session.id),
        ).toEqual({ count: 1 });
        await api(current, `/api/sessions/${session.id}/kill`, {});
        await wait(() => !alive(newPid), 'Replacement shell did not stop');
        console.log(
          `Historical ${HISTORICAL_COMMIT}: declined preserved old PID/state; approved upgraded 25.6→26, autoResume=${autoResume}, placement resumed exactly once`,
        );
      } finally {
        await cleanup();
      }
    },
    150_000,
  );
});

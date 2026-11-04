import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { runtimeLaunchSchema, runtimeSupervisorSchema } from '@puddle/shared';
import { ipcPath } from '@puddle/shared/node';
import { HostControlClient } from '@puddle/shared/node/host-control';
import { openDatabase, type Db } from '../../../src/db/db.js';
import { DATABASE_SCHEMA_VERSION } from '../../../src/db/migrations/index.js';
import { RuntimeStore } from '../../../src/db/stores/runtimes.js';
import { SessionStore } from '../../../src/db/stores/sessions.js';
import { readRuntimeJson, runtimeDirectory } from '../../../src/runtime/ownership/storage.js';
import { readRuntime } from '../../../src/runtime-file.js';
import { legacyDatabase } from '../../helpers/legacy-transition/database.js';
import { retainRuntimeHome } from '../../helpers/runtime-fixture.js';
import {
  continuityRelease,
  continuitySupervisor,
  installer,
} from '../../helpers/update-continuity/release.js';

it.each([true, false])(
  'migrates historical schema 28 and resumes the exact native placement through the default runtime (autoResume=%s)',
  async (autoResume) => {
    const home = mkdtempSync(
      join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'puddle-legacy-transition-'),
    );
    const f = legacyDatabase(home, autoResume);
    const historical = new Database(f.paths.dbFile, { readonly: true });
    expect(historical.pragma('user_version', { simple: true })).toBe(28);
    expect(
      historical.prepare("SELECT name FROM sqlite_master WHERE name = 'runtime_bindings'").get(),
    ).toBeUndefined();
    const placement = historical
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .get(f.session) as Record<string, unknown>;
    const conversation = historical.prepare('SELECT * FROM agent_conversations WHERE id = 1').get();
    historical.close();
    const env = await continuitySupervisor(home);
    const services = join(home, 'test-services');
    const run = (file: string, args: string[]) =>
      promisify(execFile)(file, args, { env, timeout: 45_000, maxBuffer: 1024 * 1024 });
    const manager = (...args: string[]) => run(join(services, 'systemctl'), ['--user', ...args]);
    const controls: HostControlClient[] = [];
    const sidecarPids: number[] = [];
    const sockets = new Set<string>();
    let db: Db | undefined;
    const diagnostics = () =>
      readdirSync(services)
        .filter((file) => file.endsWith('.log'))
        .map((file) => readFileSync(join(services, file), 'utf8').slice(-5000))
        .join('\n');
    const wait = async (condition: () => boolean, label: string) => {
      const deadline = Date.now() + 30_000;
      while (!condition()) {
        if (Date.now() >= deadline) throw new Error(`${label}\n${diagnostics()}`);
        await delay(30);
      }
    };
    const authority = async () => {
      const control = new HostControlClient(async () => connect(ipcPath(home, 'host')));
      controls.push(control);
      await control.establish();
      return control;
    };
    try {
      // Current code plus the existing fake provider registry; only the database
      // is historical. This is not acceptance of a real released provider binary.
      const archive = await continuityRelease(home, '0.4.0', false, {
        puddled: fileURLToPath(
          new URL('../../helpers/legacy-transition/daemon.ts', import.meta.url),
        ),
        puddler: fileURLToPath(
          new URL('../../helpers/legacy-transition/owner.ts', import.meta.url),
        ),
      });
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
      expect(realpathSync(join(home, 'bin/runtime-current'))).toBe(
        realpathSync(join(home, 'bin/current')),
      );
      writeFileSync(join(home, 'supervisor'), 'systemd\n', { mode: 0o600 });
      await manager('start', 'puddled.service');
      await wait(
        () => existsSync(join(home, 'test-daemon-ready.json')),
        'Migrated daemon did not finish startup',
      );
      db = openDatabase(f.paths.dbFile, { migrate: false });
      expect(db.pragma('user_version', { simple: true })).toBe(DATABASE_SCHEMA_VERSION);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      const runtimes = new RuntimeStore(db);
      const sessions = new SessionStore(db);
      const control = await authority();
      if (!autoResume) {
        expect(sessions.get(f.session).status).toBe('interrupted');
        expect(runtimes.live()).toEqual([]);
        const response = await fetch(
          `http://127.0.0.1:${control.port}/api/sessions/${f.session}/resume`,
          {
            method: 'POST',
            headers: { authorization: `Bearer ${control.credential()}` },
            signal: AbortSignal.timeout(30_000),
          },
        );
        expect(response.status, await response.text()).toBe(200);
      }
      await wait(
        () => runtimes.ownerOf(f.session)?.state === 'running',
        'Legacy placement did not acquire a runtime owner',
      );
      const owner = runtimes.ownerOf(f.session)!;
      expect(owner).toMatchObject({
        active_session_id: f.session,
        launch_session_id: f.session,
        account_id: 1,
        conversation_id: 1,
        build: '0.4.0',
        release_path: realpathSync(join(home, 'bin/runtime-current')),
      });
      const directory = runtimeDirectory(home, owner.runtime_id);
      sockets.add(dirname(ipcPath(home, `runtime:${owner.runtime_id}`)));
      const launch = runtimeLaunchSchema.parse(readRuntimeJson(join(directory, 'launch.json')));
      expect(launch.provider).toMatchObject({ resume_ref: 'legacy-native-ref' });
      expect(launch.identity).toMatchObject({
        session_id: f.session,
        canonical_worktree_path: realpathSync(f.worktree),
      });
      expect(launch.capture_env).toMatchObject({
        enabled: true,
        values: { CAPTURED_FOR_TEST: 'legacy-value' },
      });
      await wait(
        () => existsSync(join(f.account, `${f.session}.signals.json`)),
        'Migrated provider did not prepare its lifecycle sidecar',
      );
      const signals = readRuntimeJson(join(f.account, `${f.session}.signals.json`)) as {
        captured: string;
        pid: number;
      };
      sidecarPids.push(signals.pid);
      expect(signals.captured).toBe('legacy-value');
      expect(sessions.get(f.session)).toMatchObject({
        agent_session_ref: 'legacy-native-ref',
        account_id: 1,
      });
      expect(sessions.get(f.missingRef).status).toBe('interrupted');
      expect(runtimes.ownerOf(f.missingRef)).toBeNull();
      const retainedPlacement = db
        .prepare('SELECT * FROM sessions WHERE id = ?')
        .get(f.session) as Record<string, unknown>;
      for (const key of [
        'id',
        'project_id',
        'account_id',
        'conversation_id',
        'worktree_path',
        'canonical_worktree_path',
        'branch',
        'base_branch',
        'title',
        'created_at',
        'session_env',
      ])
        expect(retainedPlacement[key], key).toEqual(placement[key]);
      expect(db.prepare('SELECT * FROM agent_conversations WHERE id = 1').get()).toEqual(
        conversation,
      );
      expect(db.prepare('SELECT active_session FROM layouts').get()).toEqual({
        active_session: f.session,
      });
      expect(db.prepare("SELECT payload FROM events WHERE type = 'created'").get()).toEqual({
        payload: '{"source":"legacy-fixture"}',
      });
      expect(readFileSync(join(f.paths.sessionLogDir(f.session), 'legacy.log'), 'utf8')).toBe(
        'earlier terminal output\n',
      );
      expect(readFileSync(join(f.account, 'native-catalogue-fixture.json'), 'utf8')).toBe(
        '{"legacy-native-ref":"retained"}\n',
      );

      const supervisor = runtimeSupervisorSchema.parse(
        readRuntimeJson(join(directory, 'supervisor.json')),
      );
      const ownerPid = readFileSync(join(services, `${supervisor.name}.pid`), 'utf8');
      const firstDaemon = readRuntime(f.paths)!.pid;
      control.close();
      await manager('stop', 'puddled.service');
      rmSync(join(home, 'test-daemon-ready.json'));
      await manager('start', 'puddled.service');
      await wait(
        () => existsSync(join(home, 'test-daemon-ready.json')),
        'Replacement daemon did not adopt migrated runtime',
      );
      expect(readRuntime(f.paths)!.pid).not.toBe(firstDaemon);
      expect(runtimes.ownerOf(f.session)?.runtime_id).toBe(owner.runtime_id);
      expect(readFileSync(join(services, `${supervisor.name}.pid`), 'utf8')).toBe(ownerPid);
      expect(
        readFileSync(join(services, 'mutations'), 'utf8')
          .split('\n')
          .filter((line) => line.startsWith('start puddler-')),
      ).toHaveLength(1);
    } catch (error) {
      const smoke = join(home, 'logs/install-smoke.log');
      throw new Error(`${diagnostics()}\n${existsSync(smoke) ? readFileSync(smoke, 'utf8') : ''}`, {
        cause: error,
      });
    } finally {
      for (const control of controls) control.close();
      try {
        if (existsSync(join(services, 'puddled.service.pid')))
          await manager('stop', 'puddled.service');
        for (const file of readdirSync(services).filter(
          (name) => name.endsWith('.pid') && name !== 'puddled.service.pid',
        ))
          await manager('stop', file.slice(0, -4));
        for (const pid of sidecarPids) {
          await wait(() => {
            try {
              process.kill(pid, 0);
              return false;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true;
              throw error;
            }
          }, 'Fake provider sidecar did not stop');
        }
      } catch (error) {
        retainRuntimeHome(home);
        // eslint-disable-next-line no-unsafe-finally -- Retain executable trees unless fixture process absence is confirmed.
        throw new Error(`Legacy transition fixture cleanup failed; retained ${home}`, {
          cause: error,
        });
      } finally {
        db?.close();
      }
      sockets.add(dirname(ipcPath(home, 'host')));
      for (const directory of sockets) rmSync(directory, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  },
  120_000,
);

import { once } from 'node:events';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { compilationRunResponseSchema } from '@puddle/shared';
import { CompilationSettingsStore } from '../../../src/db/stores/compilation-settings.js';
import { commandTemplate } from '../../../src/compilation/command-template.js';
import { readRuntimeJson, runtimeDirectory } from '../../../src/runtime/ownership/storage.js';
import { runtimeDatabase } from '../../helpers/runtime-database.js';
import { launchOwner } from '../../helpers/runtime-fixture.js';
import { sh } from '../../helpers/git-fixtures.js';
import { waitFor } from '../../helpers/daemon-fixtures.js';

it('keeps programme execution and managed files through replacement, then prunes only after clean exit', async () => {
  const f = runtimeDatabase();
  let daemon: ReturnType<typeof launchOwner> | undefined;
  let ready: { port: number; token: string } | undefined;
  const request = (path: string, body?: object) =>
    fetch(`http://127.0.0.1:${ready!.port}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ready!.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(20_000),
    });
  const start = async () => {
    rmSync(join(f.home, 'test-daemon-ready.json'), { force: true });
    daemon = launchOwner(
      f.home,
      f.binding.runtime_id,
      'daemon-owner.mjs',
      `${dirname(process.execPath)}:/usr/bin:/bin`,
    );
    await waitFor(() => {
      if (daemon!.child.exitCode !== null) throw new Error(daemon!.errors());
      try {
        ready = readRuntimeJson(join(f.home, 'test-daemon-ready.json')) as typeof ready;
        return true;
      } catch {
        return false;
      }
    });
  };
  const stop = async () => {
    const ended = once(daemon!.child, 'exit');
    daemon!.child.kill('SIGTERM');
    expect((await ended)[0]).toBe(0);
  };
  const run = async () => {
    const response = await request('/api/compilation/run', {
      source: { session: f.session.id, path: 'programme.js' },
      project_id: f.project.id,
      profile_id: f.profile.id,
    });
    const result = await response.json();
    expect(response.status, JSON.stringify(result)).toBe(200);
    return compilationRunResponseSchema.parse(result).terminal!;
  };
  const kill = async (id: string) => {
    const response = await request(`/api/sessions/${id}/kill`);
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  };
  const launches = () => Number(readFileSync(join(f.home, 'programme-launches'), 'utf8'));
  try {
    f.runtimes.finish(f.binding.runtime_id, 'exited', () =>
      f.sessions.setStatus(f.session.id, 'exited'),
    );
    sh(f.home, 'init', '-b', 'main');
    writeFileSync(join(f.home, 'test-enable-runtime-launcher'), '');
    // The first programme stays alive with in-memory state; subsequent runs finish.
    writeFileSync(
      join(f.home, 'programme.js'),
      `
      const fs = require('node:fs');
      const path = require('node:path');
      const countFile = path.join(process.cwd(), 'programme-launches');
      const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0;
      fs.writeFileSync(countFile, String(count + 1));
      if (count === 0) {
        let tick = 0;
        const file = path.join(process.argv[2], 'alive.json');
        setInterval(() => {
          fs.writeFileSync(file + '.next', JSON.stringify({pid: process.pid, tick: ++tick}));
          fs.renameSync(file + '.next', file);
        }, 20);
      }
    `,
    );
    new CompilationSettingsStore(f.db).setDefault(
      f.profile.id,
      'javascript',
      'on_demand',
      commandTemplate(process.execPath, ['{{source}}', '{{output_dir}}']),
    );
    f.controller.release();
    await start();
    const first = await run();
    const owner = f.runtimes.selectedOwner(first.id)!;
    const { directory } = f.db
      .prepare('SELECT directory FROM runtime_code_runs WHERE runtime_id = ?')
      .get(owner.runtime_id) as { directory: string };
    expect(f.runtimes.hasUnreleasedCodeRun(directory)).toBe(true);
    const heartbeat = () =>
      JSON.parse(readFileSync(join(directory, 'alive.json'), 'utf8')) as {
        pid: number;
        tick: number;
      };
    await waitFor(() => existsSync(join(directory, 'alive.json')));
    const before = heartbeat();
    await stop();
    await waitFor(() => heartbeat().tick > before.tick);
    expect(heartbeat().pid).toBe(before.pid);
    await start();
    // New CodeProvider instances must respect the old owner's durable reference.
    for (let i = 0; i < 7; i++) {
      const session = await run();
      await waitFor(() => launches() === i + 2);
      await kill(session.id);
    }
    expect(heartbeat().pid).toBe(before.pid);
    expect(heartbeat().tick).toBeGreaterThan(before.tick);
    expect(f.runtimes.get(owner.runtime_id)?.state).toBe('running');
    await kill(first.id);
    expect(f.runtimes.hasUnreleasedCodeRun(directory)).toBe(false);
    const resumed = await request(`/api/sessions/${first.id}/resume`);
    expect(resumed.status).toBe(200);
    await resumed.arrayBuffer();
    expect(f.runtimes.selectedOwner(first.id)?.runtime_id).not.toBe(owner.runtime_id);
    const last = await run();
    await waitFor(() => launches() === 9);
    await kill(last.id);
    await waitFor(() => !existsSync(directory));
    expect(existsSync(dirname(directory))).toBe(true);
    await kill(first.id);
    expect(launches()).toBe(9); // Explicit terminal resume never repeats the programme.
    await stop();
  } finally {
    for (const owner of f.runtimes.live()) {
      try {
        const { pid } = readRuntimeJson(
          join(runtimeDirectory(f.home, owner.runtime_id), 'test-supervisor-pid.json'),
        ) as { pid: number };
        process.kill(pid, 'SIGTERM');
      } catch {
        /* Only this test's fake supervisor children. */
      }
    }
    if (daemon && daemon.child.exitCode === null && daemon.child.signalCode === null) await stop();
    await f.reconciler.close();
    f.db.close();
  }
});

import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeIdentity } from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { readRuntimeJson, runtimeDirectory } from '../../src/runtime/storage.js';
import { acquireRuntimeClaim } from '../../src/runtime/claims.js';
import {
  runtimeServiceDefinition,
  startRuntimeService,
  removeRuntimeService,
} from '../../src/runtime/supervisor.js';
import type {
  CompilationCommand,
  CompilationCommandRunner,
} from '../../src/compilation/process.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'puddle-runtime-service-'));
  homes.push(home);
  const entryPath = join(home, 'puddler $build & test.mjs');
  writeFileSync(entryPath, '', { mode: 0o600 });
  const identity: RuntimeIdentity = {
    runtime_id: randomUUID(),
    incarnation: randomUUID(),
    launch_id: randomUUID(),
    profile_id: '1111111111',
    project_id: '2222222222',
    session_id: randomUUID(),
    canonical_worktree_path: home,
  };
  const commands: CompilationCommand[] = [];
  const run: CompilationCommandRunner = async (command) => {
    commands.push(command);
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { home, entryPath, identity, commands, run };
}

describe('independent runtime supervision', () => {
  it('registers one systemd unit with no daemon lifetime dependency or restart policy', async () => {
    const { home, entryPath, identity, commands, run } = fixture();
    const options = { kind: 'systemd' as const, nodePath: process.execPath, entryPath, run };
    const record = await startRuntimeService(home, identity, options);
    expect(commands.map((command) => command.args.slice(0, 2))).toEqual([
      ['--user', 'link'],
      ['--user', 'daemon-reload'],
      ['--user', 'start'],
    ]);
    const definition = readFileSync(commands[0]!.args[2]!, 'utf8');
    expect(definition).toContain('Restart=no');
    expect(definition).toContain('KillMode=control-group');
    expect(definition).toContain('$$build');
    expect(definition).not.toMatch(/puddled\.service|PartOf=|BindsTo=|WantedBy=/);
    expect(record.state).toBe('dispatched');
    await startRuntimeService(home, identity, options);
    expect(commands).toHaveLength(3);
  });

  it('bootstraps a single launchd job with literal XML arguments and no keep-alive', async () => {
    const { home, entryPath, identity, commands, run } = fixture();
    const record = await startRuntimeService(home, identity, {
      kind: 'launchd',
      nodePath: process.execPath,
      entryPath,
      uid: 501,
      run,
    });
    expect(commands).toHaveLength(1);
    expect(commands[0]!.args.slice(0, 2)).toEqual(['bootstrap', 'gui/501']);
    const definition = readFileSync(commands[0]!.args[2]!, 'utf8');
    expect(definition).toContain('<key>KeepAlive</key><false/>');
    expect(definition).toContain('<key>AbandonProcessGroup</key><false/>');
    expect(definition).toContain('$build &amp; test.mjs');
    expect(definition).not.toContain('dev.puddle.puddled');
    expect(record.state).toBe('dispatched');
  });

  it('does not dispatch again after losing the supervisor acknowledgement', async () => {
    const { home, entryPath, identity } = fixture();
    let calls = 0;
    const run: CompilationCommandRunner = async () => {
      calls++;
      throw new Error('Unknown result');
    };
    const options = { kind: 'launchd' as const, nodePath: process.execPath, entryPath, run };
    await expect(startRuntimeService(home, identity, options)).rejects.toThrow('Unknown result');
    expect((await startRuntimeService(home, identity, options)).state).toBe('dispatching');
    expect(calls).toBe(1);
  });

  it('will not unregister a live owner and fences delayed launches during collection', async () => {
    const { home, entryPath, identity, commands, run } = fixture();
    const record = await startRuntimeService(home, identity, {
      kind: 'launchd',
      nodePath: process.execPath,
      entryPath,
      run,
    });
    const owner = acquireRuntimeClaim(home, `runtime:${identity.runtime_id}`);
    try {
      expect(await removeRuntimeService(home, identity, run)).toBe('owned');
    } finally {
      owner.release();
    }
    expect(commands).toHaveLength(1);
    expect(await removeRuntimeService(home, identity, run)).toBe('removed');
    expect(commands[1]!.args).toEqual(['print', `${record.domain}/${record.name}`]);
    expect(commands[2]!.args).toEqual(['bootout', `${record.domain}/${record.name}`]);
    expect(
      JSON.parse(readFileSync(join(home, 'runtimes', identity.runtime_id, 'retired.json'), 'utf8'))
        .identity,
    ).toEqual(identity);
    expect(await removeRuntimeService(home, identity, run)).toBe('removed');
    expect(commands).toHaveLength(3);
  });

  it.each(['runtime-launch', 'runtime-dispatch'])(
    'keeps an in-flight %s claim protected',
    async (key) => {
      const f = fixture();
      const claim = acquireRuntimeClaim(f.home, `${key}:${f.identity.runtime_id}`);
      try {
        expect(await removeRuntimeService(f.home, f.identity, f.run)).toBe('owned');
        expect(f.commands).toHaveLength(0);
      } finally {
        claim.release();
      }
      expect(await removeRuntimeService(f.home, f.identity, f.run)).toBe('absent');
      await expect(
        startRuntimeService(f.home, f.identity, {
          kind: 'launchd',
          nodePath: process.execPath,
          entryPath: f.entryPath,
          run: f.run,
        }),
      ).rejects.toThrow(/retired/);
      expect(f.commands).toHaveLength(0);
    },
  );

  it('recovers a lost launchd bootout reply only after positive absence inspection', async () => {
    const f = fixture();
    await startRuntimeService(f.home, f.identity, {
      kind: 'launchd',
      nodePath: process.execPath,
      entryPath: f.entryPath,
      run: f.run,
    });
    let absent = false;
    const run: CompilationCommandRunner = async (command) => {
      if (command.args[0] === 'bootout') {
        absent = true;
        throw new Error('Lost reply');
      }
      return { exitCode: absent ? 113 : 0, stdout: '', stderr: '' };
    };
    expect(await removeRuntimeService(f.home, f.identity, run)).toBe('removed');
    expect(
      (
        readRuntimeJson(
          join(runtimeDirectory(f.home, f.identity.runtime_id), 'supervisor.json'),
        ) as { state: string }
      ).state,
    ).toBe('removed');
  });

  it.each([1, 3, 5, 125])(
    'does not mistake launchd inspection error %s for missing registration',
    async (exitCode) => {
      const f = fixture();
      await startRuntimeService(f.home, f.identity, {
        kind: 'launchd',
        nodePath: process.execPath,
        entryPath: f.entryPath,
        run: f.run,
      });
      const run: CompilationCommandRunner = async () => ({
        exitCode,
        stdout: '',
        stderr: 'unavailable',
      });
      await expect(removeRuntimeService(f.home, f.identity, run)).rejects.toThrow(/inspect/);
      expect(
        (
          readRuntimeJson(
            join(runtimeDirectory(f.home, f.identity.runtime_id), 'supervisor.json'),
          ) as { state: string }
        ).state,
      ).toBe('dispatched');
      expect(await removeRuntimeService(f.home, f.identity, f.run)).toBe('removed');
    },
  );

  it('recovers already-removed systemd registration without accepting incomplete or active observations', async () => {
    const f = fixture();
    await startRuntimeService(f.home, f.identity, {
      kind: 'systemd',
      nodePath: process.execPath,
      entryPath: f.entryPath,
      run: f.run,
    });
    let stdout = 'LoadState=not-found\nActiveState=active\nSubState=running\n';
    const run: CompilationCommandRunner = async (command) => ({
      exitCode: command.args[1] === 'daemon-reload' ? 0 : 4,
      stdout: command.args[1] === 'show' ? stdout : '',
      stderr: '',
    });
    await expect(removeRuntimeService(f.home, f.identity, run)).rejects.toThrow(/failed/);
    stdout = 'LoadState=not-found\n';
    await expect(removeRuntimeService(f.home, f.identity, run)).rejects.toThrow(/failed/);
    stdout = 'LoadState=not-found\nActiveState=inactive\nSubState=dead\n';
    expect(await removeRuntimeService(f.home, f.identity, run)).toBe('removed');
  });

  it('rejects a registration targeting another runtime even with matching launch metadata', async () => {
    const f = fixture();
    const record = await startRuntimeService(f.home, f.identity, {
      kind: 'launchd',
      nodePath: process.execPath,
      entryPath: f.entryPath,
      run: f.run,
    });
    atomicPrivateJson(join(runtimeDirectory(f.home, f.identity.runtime_id), 'supervisor.json'), {
      ...record,
      name: record.name.replace(f.identity.runtime_id, randomUUID()),
    });
    await expect(removeRuntimeService(f.home, f.identity, f.run)).rejects.toThrow(/target/);
    expect(f.commands).toHaveLength(1);
  });

  it('rejects line breaks in service paths before invoking a host command', async () => {
    const { home, entryPath, identity, commands, run } = fixture();
    await expect(
      startRuntimeService(home, identity, {
        kind: 'systemd',
        nodePath: process.execPath,
        entryPath: entryPath + '\nRestart=always',
        run,
      }),
    ).rejects.toThrow(/Invalid/);
    expect(commands).toHaveLength(0);
    const record = await startRuntimeService(home, identity, {
      kind: 'systemd',
      nodePath: process.execPath,
      entryPath,
      run,
    });
    expect(() => runtimeServiceDefinition('relative', record)).toThrow(/Invalid/);
  });
});

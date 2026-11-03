import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import type { RuntimeIdentity } from '@puddle/shared';
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
    expect(commands[1]!.args).toEqual(['bootout', `${record.domain}/${record.name}`]);
    expect(
      JSON.parse(readFileSync(join(home, 'runtimes', identity.runtime_id, 'retired.json'), 'utf8'))
        .identity,
    ).toEqual(identity);
    expect(await removeRuntimeService(home, identity, run)).toBe('removed');
    expect(commands).toHaveLength(2);
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

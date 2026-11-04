import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimeAssetsSchema } from '@puddle/shared';
import { pinRuntimeAssets } from '../../../src/runtime/execution/assets.js';
import {
  installHookDispatcher,
  managedHookCommand,
  writeManagedHelper,
} from '../../../src/agents/managed-helpers.js';
import { installOpenCodePlugin } from '../../../src/agents/opencode/plugin.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function directory(parent?: string, name = 'puddle-assets-'): string {
  if (!parent) {
    const home = mkdtempSync(join(tmpdir(), name));
    homes.push(home);
    return home;
  }
  const path = join(parent, name);
  mkdirSync(path, { mode: 0o700 });
  return path;
}
function run(command: string, env: Record<string, string> = {}, cwd?: string): string {
  return execFileSync('/bin/sh', ['-c', command], {
    env,
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

describe('runtime helper ownership', () => {
  it('pins private source digests and the exact Node executable without overwriting an owner', () => {
    const home = directory();
    const source = 'process.stdout.write("owned");';
    const env = pinRuntimeAssets(home, { 'puddle-signal.mjs': source });
    const record = runtimeAssetsSchema.parse(
      JSON.parse(readFileSync(join(home, 'assets.json'), 'utf8')),
    );
    expect(record).toEqual({
      format: 1,
      node_path: realpathSync(process.execPath),
      files: {
        'puddle-signal.mjs': createHash('sha256').update(source).digest('hex'),
      },
    });
    expect(env['PUDDLE_AGENT_HELPER_NODE']).toBe(record.node_path);
    expect(statSync(join(home, 'helpers/puddle-signal.mjs')).mode & 0o777).toBe(0o400);
    expect(statSync(join(home, 'hook-state')).mode & 0o777).toBe(0o700);
    expect(() => pinRuntimeAssets(home, { 'puddle-signal.mjs': 'replacement' })).toThrow(
      'already pinned',
    );
    expect(readFileSync(join(home, 'helpers/puddle-signal.mjs'), 'utf8')).toBe(source);
  });

  it('bounds asset names, individual files, total bytes and file counts before writing', () => {
    for (const sources of [
      { '../escape.mjs': '' },
      { '/absolute.mjs': '' },
      { 'large.mjs': 'a'.repeat(512 * 1024 + 1) },
      { 'one.mjs': 'a'.repeat(512 * 1024), 'two.mjs': 'b'.repeat(512 * 1024), 'three.mjs': 'c' },
      Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`file-${i}.mjs`, ''])),
    ]) {
      const home = directory();
      expect(() => pinRuntimeAssets(home, sources)).toThrow('Invalid runtime helper assets');
      expect(existsSync(join(home, 'helpers'))).toBe(false);
    }
    const empty = directory();
    expect(pinRuntimeAssets(empty, {})).toEqual({});
    expect(existsSync(join(empty, 'helpers'))).toBe(false);
  });

  it('dispatches two builds from one updated account, preserving literal paths and arguments', () => {
    const home = directory();
    const account = directory(home, "account ' `touch unwanted` $(touch unwanted) $HOME");
    const args = ["quote'", '$(touch unwanted)', '`touch unwanted`', 'with spaces'];
    const source = (version: string) =>
      `process.stdout.write(JSON.stringify({version:${JSON.stringify(version)}, args:process.argv.slice(2), node:process.execPath}));`;
    const old = pinRuntimeAssets(directory(home, 'old'), { 'puddle-signal.mjs': source('old') });
    const next = pinRuntimeAssets(directory(home, 'new'), { 'puddle-signal.mjs': source('new') });
    installHookDispatcher(account);
    writeManagedHelper(join(account, 'puddle-signal.mjs'), source('shared replacement'));
    installHookDispatcher(account);
    const command = managedHookCommand(account, 'puddle-signal.mjs', ...args);
    for (const [version, env] of [
      ['old', old],
      ['new', next],
    ] as const) {
      expect(JSON.parse(run(command, env, home))).toEqual({
        version,
        args,
        node: realpathSync(process.execPath),
      });
    }
    expect(JSON.parse(run(command, {}, home))).toMatchObject({
      version: 'shared replacement',
      args,
    });
    expect(() => run(command, { ...old, PUDDLE_AGENT_HELPER_NODE: '' }, home)).toThrow();
    expect(() => run(command, { ...old, PUDDLE_AGENT_HELPER_NODE: '/bin/false' }, home)).toThrow();
    expect(() =>
      run(command, { ...old, PUDDLE_AGENT_HELPER_DIR: join(home, 'missing') }, home),
    ).toThrow();
    expect(existsSync(join(home, 'unwanted'))).toBe(false);
  });

  it('loads each runtime’s OpenCode plugin even after the account plugin is reinstalled', () => {
    const home = directory();
    const account = directory(home, 'account');
    const plugin = (tag: string) =>
      `export const PuddleSync = async () => ({tag:${JSON.stringify(tag)}});`;
    const old = pinRuntimeAssets(directory(home, 'old'), { 'puddle-sync.mjs': plugin('old') });
    const next = pinRuntimeAssets(directory(home, 'new'), { 'puddle-sync.mjs': plugin('new') });
    installOpenCodePlugin(account);
    installOpenCodePlugin(account);
    writeManagedHelper(
      join(account, 'config/opencode/puddle-managed/puddle-sync.mjs'),
      plugin('fallback'),
    );
    const url = pathToFileURL(join(account, 'config/opencode/plugins/puddle-sync.js')).href;
    const source = `const {PuddleSync} = await import(${JSON.stringify(url)}); console.log((await PuddleSync({})).tag);`;
    const execute = (env: Record<string, string>) =>
      execFileSync(process.execPath, ['--input-type=module', '-e', source], {
        env,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    expect(execute(old)).toBe('old');
    expect(execute(next)).toBe('new');
    expect(execute({})).toBe('fallback');
    expect(() => execute({ ...old, PUDDLE_AGENT_HELPER_DIR: join(home, 'missing') })).toThrow();
  });
});

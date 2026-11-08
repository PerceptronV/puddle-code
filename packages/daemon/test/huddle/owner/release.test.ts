import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runtimeReleaseCapabilities, type RuntimeReleaseCapabilities } from '@puddle/shared';
import { resolveInstalledRuntimeRelease } from '../../../src/runtime/lifecycle/release.js';
import {
  requireHuddleRuntimeSelection,
  resolveHuddleRuntimeRelease,
} from '../../../src/runtime/huddle/control/release.js';
import { runtimeRelease } from '../../helpers/runtime-release.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function home() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'puddle-huddle-release-')));
  homes.push(directory);
  return directory;
}
function release(directory: string, build = '1.2.3') {
  const f = runtimeRelease(directory, build, '1.1');
  mkdirSync(join(f.release, 'daemon', 'huddle'));
  for (const name of ['runner.js', 'sdk.js'])
    writeFileSync(join(f.release, 'daemon', 'huddle', name), '// fixture; never execute\n');
  const capabilities = runtimeReleaseCapabilities(build);
  const file = join(f.release, 'RUNTIME_CAPABILITIES.json');
  const save = (value: RuntimeReleaseCapabilities = capabilities) =>
    writeFileSync(file, JSON.stringify(value));
  save();
  f.select();
  return { ...f, file, capabilities, save };
}

describe('pinned huddle runtime capability admission', () => {
  it('keeps historical runtime selection usable for agent/terminal owners while refusing huddle admission', () => {
    const directory = home();
    runtimeRelease(directory, '1.2.3', '1.0').select();
    expect(resolveInstalledRuntimeRelease(directory).protocol).toEqual({ major: 1, minor: 0 });
    expect(() => resolveHuddleRuntimeRelease(directory)).toThrow(/capability metadata/);
  });
  it('pins complete role and helper identities and detects selector changes even within the same version', () => {
    const directory = home();
    const first = release(directory);
    const pinned = resolveHuddleRuntimeRelease(directory);
    expect(pinned).toMatchObject({
      build: '1.2.3',
      releasePath: first.release,
      huddle: { owner: 1, definition: 1, component: 1, ledger: 1 },
      workerEntry: join(first.release, 'daemon/huddle/runner.js'),
    });
    requireHuddleRuntimeSelection(directory, pinned);
    const replacement = release(directory);
    expect(replacement.release).not.toBe(first.release);
    expect(() => requireHuddleRuntimeSelection(directory, pinned)).toThrow(/changed/);
    expect(pinned.releasePath).toBe(first.release);
  });
  it.each([
    'missing-role',
    'owner',
    'definition',
    'component',
    'ledger',
    'wrong-build',
    'wrong-protocol',
    'unknown-format',
    'oversize',
    'symlink',
    'missing-worker',
    'external-worker',
    'missing-sdk',
  ])('refuses %s metadata/assets without executing the selected runtime', (failure) => {
    const directory = home();
    const f = release(directory);
    if (failure === 'missing-role') f.capabilities.roles = {};
    if (['owner', 'definition', 'component', 'ledger'].includes(failure))
      f.capabilities.roles.huddle![failure as 'owner'] = 2;
    if (failure === 'wrong-build') f.capabilities.version = '4.5.6';
    if (failure === 'wrong-protocol') f.capabilities.protocol.minor++;
    f.save();
    if (failure === 'unknown-format')
      writeFileSync(f.file, JSON.stringify({ ...f.capabilities, format: 2 }));
    if (failure === 'oversize') writeFileSync(f.file, ' '.repeat(32 * 1024 + 1));
    if (failure === 'symlink') {
      const target = join(directory, 'outside.json');
      writeFileSync(target, readFileSync(f.file));
      rmSync(f.file);
      symlinkSync(target, f.file);
    }
    const worker = join(f.release, 'daemon/huddle/runner.js');
    if (failure === 'missing-worker' || failure === 'external-worker') rmSync(worker);
    if (failure === 'external-worker') symlinkSync(join(f.release, 'daemon/puddler.mjs'), worker);
    if (failure === 'missing-sdk') rmSync(join(f.release, 'daemon/huddle/sdk.js'));
    expect(() => resolveHuddleRuntimeRelease(directory)).toThrow();
    expect(resolveInstalledRuntimeRelease(directory).build).toBe('1.2.3');
  });
});

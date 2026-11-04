import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { resolveInstalledRuntimeRelease } from '../../../src/runtime/lifecycle/release.js';
import { runtimeRelease } from '../../helpers/runtime-release.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function home() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'puddle-runtime-release-')));
  homes.push(directory);
  return directory;
}

it('resolves each selection into a complete immutable build and retains previous paths', () => {
  const directory = home();
  const first = runtimeRelease(directory);
  const second = runtimeRelease(directory, '2.3.4', '1.9');
  first.select();
  const pinned = resolveInstalledRuntimeRelease(directory);
  second.select();
  expect(pinned).toEqual({
    build: '1.2.3',
    protocol: { major: 1, minor: 0 },
    releasePath: first.release,
    nodePath: join(first.release, 'bin', 'node'),
    entryPath: join(first.release, 'daemon', 'puddler.mjs'),
  });
  expect(resolveInstalledRuntimeRelease(directory)).toMatchObject({
    build: '2.3.4',
    protocol: { major: 1, minor: 9 },
    releasePath: second.release,
  });
});

it.each(['missing', 'major', 'malformed', 'oversized', 'external-node', 'external-selector'])(
  'rejects a %s runtime selection before any launch',
  (failure) => {
    const directory = home();
    const f = runtimeRelease(directory);
    f.select();
    const protocol = join(f.release, 'RUNTIME_PROTOCOL');
    if (failure === 'missing') rmSync(protocol);
    if (failure === 'major') writeFileSync(protocol, '99.0\n');
    if (failure === 'malformed') writeFileSync(protocol, '1.0\nextra');
    if (failure === 'oversized')
      writeFileSync(join(f.release, 'VERSION'), '1.2.3' + ' '.repeat(1024));
    if (failure === 'external-node') {
      rmSync(join(f.release, 'bin', 'node'));
      symlinkSync(process.execPath, join(f.release, 'bin', 'node'));
    }
    if (failure === 'external-selector') {
      rmSync(join(directory, 'bin', 'runtime-current'));
      symlinkSync(directory, join(directory, 'bin', 'runtime-current'));
    }
    expect(() => resolveInstalledRuntimeRelease(directory)).toThrow();
  },
);

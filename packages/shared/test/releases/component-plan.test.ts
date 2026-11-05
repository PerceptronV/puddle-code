import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
const script = fileURLToPath(new URL('../../../../scripts/plan-release.mjs', import.meta.url));
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'puddle-component-plan-'));
  roots.push(root);
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: root,
      stdio: 'pipe',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.test',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.test',
      },
    });
  git('init', '-q');
  for (const file of [
    'packages/daemon/src/index.ts',
    'packages/daemon/src/runtime/index.ts',
    'packages/daemon/src/updates/worker/index.ts',
    'packages/connector/src/index.ts',
  ])
    put(file, 'console.log(1);');
  put(
    'release-manifest.json',
    JSON.stringify({
      format: 1,
      version: '1.0.0',
      components: { cockpit: '1.0.0', daemon: '1.0.0', runtime: '1.0.0' },
    }),
  );
  git('add', '.');
  git('commit', '-qm', 'baseline');
  git('tag', 'v1.0.0');
  const plan = (version = '1.0.1', base = 'v1.0.0', components = 'auto') =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [script, '--version', version, '--base', base, '--components', components, '--dry-run'],
        { cwd: root, encoding: 'utf8', stdio: 'pipe' },
      ),
    );
  return { put, git, plan };
}
it('skips both hosts for a cockpit-only change', () => {
  const f = fixture();
  f.put('packages/web/src/ui.ts', 'new UI');
  expect(f.plan().components).toEqual({ cockpit: '1.0.1', daemon: '1.0.0', runtime: '1.0.0' });
});
it.each(['daemon', 'runtime'] as const)(
  'publishes only the changed %s import closure',
  (component) => {
    const f = fixture();
    f.put(
      component === 'runtime'
        ? 'packages/daemon/src/runtime/index.ts'
        : 'packages/daemon/src/index.ts',
      'console.log(2);',
    );
    expect(f.plan().components).toEqual({
      cockpit: '1.0.1',
      daemon: '1.0.0',
      runtime: '1.0.0',
      [component]: '1.0.1',
    });
  },
);
it('retains deferred changes by comparing against the last component publication', () => {
  const f = fixture();
  f.put('packages/daemon/src/index.ts', 'console.log(2);');
  f.put('release-manifest.json', JSON.stringify(f.plan('1.0.1', 'v1.0.0', 'cockpit')));
  f.git('add', '.');
  f.git('commit', '-qm', 'deliberately defer host');
  f.git('tag', 'v1.0.1');
  expect(f.plan('1.0.2', 'v1.0.1').components).toEqual({
    cockpit: '1.0.2',
    daemon: '1.0.2',
    runtime: '1.0.0',
  });
});
it('publishes both hosts for a shared installer change', () => {
  const f = fixture();
  f.put('scripts/install.sh', '# changed');
  expect(f.plan().components).toEqual({ cockpit: '1.0.1', daemon: '1.0.1', runtime: '1.0.1' });
});

it('requires a complete transition release before excluding components', () => {
  const f = fixture();
  f.git('rm', 'release-manifest.json');
  f.git('commit', '-qm', 'legacy release');
  f.git('tag', 'v1.0.1');
  expect(() => f.plan('1.0.2', 'v1.0.1', 'cockpit')).toThrow();
  expect(f.plan('1.0.2', 'v1.0.1', 'all').components).toEqual({
    cockpit: '1.0.2',
    daemon: '1.0.2',
    runtime: '1.0.2',
  });
});

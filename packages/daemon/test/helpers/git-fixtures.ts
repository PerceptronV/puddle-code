import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** A repo with one commit on main and identity configured. */
export function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'puddle-repo-'));
  sh(dir, 'init', '-b', 'main');
  sh(dir, 'config', 'user.email', 'alice@example.com');
  sh(dir, 'config', 'user.name', 'alice');
  writeFileSync(join(dir, 'README.md'), '# fixture\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-m', 'initial');
  return dir;
}

/** Clone `src` so the clone has an `origin` remote pointing at it. */
export function cloneRepo(src: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'puddle-clone-'));
  execFileSync('git', ['clone', src, dir], { encoding: 'utf8', stdio: 'pipe' });
  sh(dir, 'config', 'user.email', 'alice@example.com');
  sh(dir, 'config', 'user.name', 'alice');
  return dir;
}

export function commitFile(repo: string, name: string, contents: string): string {
  writeFileSync(join(repo, name), contents);
  sh(repo, 'add', name);
  sh(repo, 'commit', '-m', `add ${name}`);
  return sh(repo, 'rev-parse', 'HEAD');
}

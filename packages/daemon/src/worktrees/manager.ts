import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { Repo } from '@puddle/shared';
import type { RepoStore } from '../db/stores/repos.js';
import type { SessionStore } from '../db/stores/sessions.js';
import { git } from '../git/exec.js';
import type { KeyedMutex } from '../git/mutex.js';
import { ApiError } from '../http/errors.js';
import type { PuddlePaths } from '../paths.js';
import { wordPairName } from './names.js';
import { promptSlug, slugify } from './slug.js';

export interface CreateWorktreeResult {
  worktreePath: string;
  branch: string;
  baseBranch: string;
  baseRef: string;
  /** False when an existing shared worktree was attached rather than created. */
  created: boolean;
}

export class WorktreeManager {
  constructor(
    private readonly deps: {
      paths: PuddlePaths;
      mutex: KeyedMutex;
      repos: RepoStore;
      sessions: SessionStore;
    },
  ) {}

  /**
   * All repo-mutating work runs under the repo mutex. The fetch inside create
   * calls the unmutexed core directly — KeyedMutex is not reentrant.
   */
  create(opts: {
    repo: Repo;
    sessionId: string;
    baseBranch?: string;
    requestedBranch?: string;
    title?: string | null;
    prompt?: string | null;
    branchPrefix: string;
  }): Promise<CreateWorktreeResult> {
    const { repo } = opts;
    return this.deps.mutex.run(`repo:${repo.id}`, async () => {
      const baseBranch = opts.baseBranch ?? repo.default_base_branch;
      await this.fetchCoreQuietly(repo);
      const baseRef = (await this.refExists(repo, `refs/remotes/origin/${baseBranch}`))
        ? `origin/${baseBranch}`
        : baseBranch;
      if (baseRef === baseBranch && !(await this.refExists(repo, `refs/heads/${baseBranch}`))) {
        throw ApiError.badRequest('unknown_base', `base branch '${baseBranch}' does not exist`);
      }
      const branch = await this.pickBranchName(repo, opts);
      const worktreePath = this.deps.paths.sessionWorktreeDir(repo.id, opts.sessionId);
      mkdirSync(dirname(worktreePath), { recursive: true });
      await git(['worktree', 'add', worktreePath, '-b', branch, baseRef], { cwd: repo.path });
      await this.excludePuddleDir(repo);
      mkdirSync(join(worktreePath, '.puddle'), { recursive: true });
      return { worktreePath, branch, baseBranch, baseRef, created: true };
    });
  }

  /**
   * The separate_branch = false path (SPEC §4): one shared worktree per
   * (repo, branch), checked out on the base branch itself. The first such
   * session creates it; later ones attach to the same directory.
   */
  attachShared(opts: { repo: Repo; baseBranch?: string }): Promise<CreateWorktreeResult> {
    const { repo } = opts;
    return this.deps.mutex.run(`repo:${repo.id}`, async () => {
      const branch = opts.baseBranch ?? repo.default_base_branch;
      await this.fetchCoreQuietly(repo);
      const localExists = await this.refExists(repo, `refs/heads/${branch}`);
      if (!localExists) {
        if (!(await this.refExists(repo, `refs/remotes/origin/${branch}`))) {
          throw ApiError.badRequest('unknown_base', `base branch '${branch}' does not exist`);
        }
        // Only a branch that exists solely on the remote gets a fresh local
        // tracking branch; existing local branches are never reset (SPEC §4).
        await git(['branch', '--track', branch, `origin/${branch}`], { cwd: repo.path });
      }

      // Distinct branches can collide on a slug ('a/b' vs 'a.b'): probe -2,
      // -3, … until we find this branch's own dir or a free name.
      for (let n = 1; ; n++) {
        const slug = slugify(branch) + (n === 1 ? '' : `-${n}`);
        const dir = this.deps.paths.sharedWorktreeDir(repo.id, slug);
        if (existsSync(dir)) {
          const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir });
          if (head !== branch) continue;
          return { worktreePath: dir, branch, baseBranch: branch, baseRef: branch, created: false };
        }
        mkdirSync(dirname(dir), { recursive: true });
        // --force: the branch may already be checked out in the canonical
        // clone. The double checkout is exactly what this discouraged mode
        // permits — commits land on the branch either way, but each checkout's
        // index and working tree are its own (SPEC §4).
        await git(['worktree', 'add', '--force', dir, branch], { cwd: repo.path });
        await this.excludePuddleDir(repo);
        mkdirSync(join(dir, '.puddle'), { recursive: true });
        return { worktreePath: dir, branch, baseBranch: branch, baseRef: branch, created: true };
      }
    });
  }

  /** `git branch -D` — only ever called for puddle-created session branches (SPEC §4). */
  deleteBranch(repo: Repo, branch: string): Promise<void> {
    return this.deps.mutex.run(`repo:${repo.id}`, async () => {
      await git(['branch', '-D', branch], { cwd: repo.path });
    });
  }

  /** Removes the worktree; the branch stays in the repo (SPEC §4 archiving). */
  remove(opts: { repo: Repo; worktreePath: string; force?: boolean }): Promise<void> {
    return this.deps.mutex.run(`repo:${opts.repo.id}`, async () => {
      if (!existsSync(opts.worktreePath)) {
        await git(['worktree', 'prune'], { cwd: opts.repo.path }).catch(() => undefined);
        return;
      }
      if (!opts.force && !(await this.isClean(opts.worktreePath))) {
        throw ApiError.conflict(
          'worktree_dirty',
          'worktree has uncommitted changes; archive with force to discard them',
        );
      }
      const args = ['worktree', 'remove', ...(opts.force ? ['--force'] : []), opts.worktreePath];
      await git(args, { cwd: opts.repo.path });
    });
  }

  async isClean(worktreePath: string): Promise<boolean> {
    return (await git(['status', '--porcelain'], { cwd: worktreePath })) === '';
  }

  /** Mutexed fetch for project-open, periodic and manual fetches. Throws on failure. */
  fetchRepo(repo: Repo): Promise<void> {
    return this.deps.mutex.run(`repo:${repo.id}`, () => this.fetchCore(repo));
  }

  /**
   * Worktree dirs on disk that no session row claims. Never deletes (SPEC §4).
   * Matched by full path, not dir name: session worktrees are named by session
   * id, shared worktrees by branch slug.
   */
  findOrphanWorktrees(repo: Repo): string[] {
    const dir = join(this.deps.paths.worktreesDir, String(repo.id));
    if (!existsSync(dir)) return [];
    const known = new Set(this.deps.sessions.allWorktreePaths());
    return readdirSync(dir)
      .map((name) => join(dir, name))
      .filter((path) => !known.has(path));
  }

  private async fetchCore(repo: Repo): Promise<void> {
    if (!repo.fetch_enabled) return;
    if (!(await this.hasOrigin(repo))) return; // no remote → freshness degrades silently (SPEC §4)
    await git(['fetch', 'origin'], { cwd: repo.path });
    this.deps.repos.setLastFetchedAt(repo.id, new Date().toISOString());
  }

  /** Create-time fetch: failures are logged, never block session creation (SPEC §4). */
  private async fetchCoreQuietly(repo: Repo): Promise<void> {
    try {
      await this.fetchCore(repo);
    } catch (e) {
      console.warn(`fetch failed for ${repo.path}: ${(e as Error).message}`);
    }
  }

  private async hasOrigin(repo: Repo): Promise<boolean> {
    const remotes = await git(['remote'], { cwd: repo.path });
    return remotes.split('\n').includes('origin');
  }

  private async refExists(repo: Repo, ref: string): Promise<boolean> {
    try {
      await git(['rev-parse', '--verify', '--quiet', ref], { cwd: repo.path });
      return true;
    } catch {
      return false;
    }
  }

  private async pickBranchName(
    repo: Repo,
    opts: {
      requestedBranch?: string;
      branchPrefix: string;
      title?: string | null;
      prompt?: string | null;
    },
  ): Promise<string> {
    // Human-readable at every fallback: title slug → first words of the
    // prompt → a memorable word pair. Never a uuid fragment.
    const wanted =
      opts.requestedBranch ??
      `${opts.branchPrefix}${slugify(opts.title) || promptSlug(opts.prompt) || wordPairName()}`;
    const refs = await git(
      ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'],
      { cwd: repo.path },
    );
    const taken = new Set(
      refs
        .split('\n')
        .filter(Boolean)
        .map((r) => r.replace(/^origin\//, '')),
    );
    if (!taken.has(wanted)) return wanted;
    for (let n = 2; ; n++) {
      const candidate = `${wanted}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  /** `.puddle/` is never committed: exclude it once per repo (shared by all worktrees). */
  private async excludePuddleDir(repo: Repo): Promise<void> {
    const commonDirRaw = await git(['rev-parse', '--git-common-dir'], { cwd: repo.path });
    const commonDir = isAbsolute(commonDirRaw) ? commonDirRaw : resolve(repo.path, commonDirRaw);
    const infoDir = join(commonDir, 'info');
    mkdirSync(infoDir, { recursive: true });
    const excludeFile = join(infoDir, 'exclude');
    const current = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : '';
    if (!current.split('\n').includes('.puddle/')) {
      appendFileSync(
        excludeFile,
        (current.endsWith('\n') || current === '' ? '' : '\n') + '.puddle/\n',
      );
    }
  }
}

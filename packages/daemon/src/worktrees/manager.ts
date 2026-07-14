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
      return { worktreePath, branch, baseBranch, baseRef };
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

  /** Worktree dirs on disk that no session row claims. Never deletes (SPEC §4). */
  findOrphanWorktrees(repo: Repo): string[] {
    const dir = join(this.deps.paths.worktreesDir, String(repo.id));
    if (!existsSync(dir)) return [];
    const known = new Set(this.deps.sessions.allIds());
    return readdirSync(dir)
      .filter((name) => !known.has(name))
      .map((name) => join(dir, name));
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

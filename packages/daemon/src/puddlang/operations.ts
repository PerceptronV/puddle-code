import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  PuddlangHandle,
  PuddlangOperation,
  PuddlangSpawn,
  PuddlangStart,
} from '@puddle/shared';
import type { AppDeps } from '../http/app.js';
import { ApiError } from '../http/errors.js';
import { expandTilde } from '../http/tilde.js';

export type PuddlangDeps = Pick<
  NonNullable<AppDeps['api']>,
  'profiles' | 'accounts' | 'projects' | 'repos' | 'adapters' | 'service' | 'worktrees'
>;

/** One run's handles, limits and cleanup; profiles remain host-owned identities. */
export class PuddlangOperations {
  private readonly handles = new Map<string, PuddlangHandle>();
  private readonly owned = new Set<string>();
  private turns = 0;
  private spawns = 0;
  constructor(
    private readonly deps: PuddlangDeps,
    private readonly profile: string,
    private readonly input: PuddlangStart,
    private readonly signal: AbortSignal,
  ) {}

  async execute(operation: PuddlangOperation): Promise<unknown> {
    this.signal.throwIfAborted();
    if (operation.op === 'spawn') return this.spawn(operation.options);
    if (operation.op === 'attach') {
      const runtime = this.checked(operation.reference);
      this.handles.set(runtime.handle.runtime_id, runtime.handle);
      return runtime.handle;
    }
    if (!this.handles.has(operation.handle.runtime_id))
      throw new Error('Attach this agent before using its handle');
    const runtime = this.checked(operation.handle.runtime_id);
    if (operation.op === 'stop') {
      await this.deps.service.kill(runtime.handle.session_id);
      this.handles.delete(runtime.handle.runtime_id);
      return null;
    }
    if (++this.turns > this.input.max_turns) throw new Error('Puddlang turn limit reached');
    return runtime.control.ask(
      operation.request.prompt,
      this.signal,
      operation.request.output_schema,
    );
  }

  async stopOwned(): Promise<void> {
    await Promise.allSettled(
      [...this.owned].map(async (id) => {
        const runtime = this.checked(id);
        await this.deps.service.kill(runtime.handle.session_id);
      }),
    );
  }

  private checked(reference: string) {
    const runtime = this.deps.service.scriptRuntime(reference);
    if (this.deps.projects.get(runtime.session.project_id).profile_id !== this.profile)
      throw new ApiError(403, 'profile_scope', 'This agent belongs to another profile');
    return runtime;
  }

  private async spawn(options: PuddlangSpawn): Promise<PuddlangHandle> {
    if (++this.spawns > this.input.max_agents) throw new Error('Puddlang agent limit reached');
    if (!this.deps.adapters.get(options.agent).scriptedTurns)
      throw ApiError.badRequest(
        'unsupported_agent',
        `${options.agent} does not support exact puddlang turns`,
      );
    const accounts = this.deps.accounts
      .list(this.profile)
      .filter((a) => a.agent_type === options.agent);
    const defaultId = this.deps.profiles.getSettings(this.profile)['default_account_id'];
    const selector =
      options.account ??
      this.input.accounts[options.agent] ??
      accounts.find((a) => a.id === defaultId)?.id;
    const candidates =
      selector === undefined
        ? accounts.filter((a) => a.logged_in)
        : accounts.filter((a) =>
            typeof selector === 'number' ? a.id === selector : a.label === selector,
          );
    const account = candidates.length === 1 ? candidates[0] : undefined;
    if (!account || !account.logged_in)
      throw ApiError.badRequest(
        'account_selection',
        `Select an available ${options.agent} account in this profile: ${accounts.map((a) => `${a.label} (${a.id}${a.logged_in ? '' : ', logged out'})`).join(', ') || 'none'}`,
      );
    const location = await this.location(options);
    this.signal.throwIfAborted();
    const session = await this.deps.service.create({
      project_id: location.project,
      account_id: account.id,
      separate_branch: false,
      separate_worktree: false,
      join_worktree: location.path,
      title: options.title ?? 'puddlang agent',
    });
    let handle: PuddlangHandle | undefined;
    try {
      const deadline = Date.now() + 120_000;
      // Initial native setup/onboarding may be a turn of its own. Admission is
      // checked by the adapter again atomically when the first ask is sent.
      await delay(250, undefined, { signal: this.signal });
      for (;;) {
        this.signal.throwIfAborted();
        try {
          const runtime = this.checked(session.id);
          handle = runtime.handle;
          this.owned.add(handle.runtime_id);
          if (runtime.control.ready) break;
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== 'agent_not_live') throw error;
        }
        if (Date.now() >= deadline)
          throw new Error('Agent did not become ready within two minutes; inspect its terminal');
        await delay(100, undefined, { signal: this.signal });
      }
      if (!handle) throw new Error('Agent did not acquire a live runtime');
      this.handles.set(handle.runtime_id, handle);
      return handle;
    } catch (error) {
      try {
        await this.deps.service.kill(
          handle ? this.checked(handle.runtime_id).handle.session_id : session.id,
        );
      } catch {
        /* Already stopped or moved. */
      }
      throw error;
    }
  }

  private async location(options: PuddlangSpawn): Promise<{ project: string; path: string }> {
    const projects = this.deps.projects
      .list(this.profile)
      .filter(
        (p) =>
          !p.archived &&
          (options.project === undefined || p.id === options.project || p.name === options.project),
      );
    if (options.project && projects.length !== 1)
      throw new Error('Project is missing or ambiguous in this profile');
    const requestedPath =
      options.path ??
      (options.worktree && isAbsolute(expandTilde(options.worktree))
        ? options.worktree
        : undefined);
    const canonical = requestedPath ? await realpath(expandTilde(requestedPath)) : undefined;
    const matches: Array<{ project: string; path: string }> = [];
    for (const project of projects) {
      const repo = this.deps.repos.get(project.repo_id);
      const worktrees = await this.deps.worktrees.listWorktrees(repo);
      for (const worktree of worktrees) {
        const path = await realpath(worktree.path).catch(() => null);
        if (!path) continue;
        if (
          canonical
            ? path === canonical
            : options.worktree
              ? worktree.branch === options.worktree
              : worktree.is_primary
        )
          matches.push({ project: project.id, path });
      }
    }
    if (matches.length !== 1)
      throw new Error(
        'Choose one registered project/worktree root; the path is missing, unregistered or ambiguous in this profile',
      );
    return matches[0]!;
  }
}

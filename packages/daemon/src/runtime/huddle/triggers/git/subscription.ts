import { watch, type FSWatcher } from 'node:fs';
import { relative } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import {
  HUDDLE_GIT_LIMITS,
  type HuddleDefinition,
  type HuddleRevisionActivation,
} from '@puddle/shared';
import type { HuddleLedger } from '../../state/ledger.js';
import type { GitDefinition } from './definitions.js';
import { requireTriggerDirectory } from '../worktree.js';
import {
  gitSnapshot,
  identifyGitRepository,
  readGitHead,
  readGitRefs,
  sameGitRepository,
  type GitRepositoryIdentity,
} from './read.js';
import { gitMetadataName, gitWatchDirectories } from './watches.js';

/** One owner stream shares common-directory watches/ref reads across all declared worktrees. */
export class GitSubscription {
  private abort = new AbortController();
  private watchers = new Map<string, { identity: string; watcher: FSWatcher }>();
  private identities: GitRepositoryIdentity[] | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | null = null;
  private dirty = false;
  private released = false;
  private readonly debounce: number;
  constructor(
    private readonly ledger: HuddleLedger,
    private readonly definitions: GitDefinition[],
    private readonly activation: HuddleRevisionActivation,
    private readonly generation: number,
    private readonly limits: HuddleDefinition['execution'],
    private readonly admitted: () => void,
    private readonly failed: (error: unknown) => void,
    private readonly guard: () => void,
    private readonly release: () => void,
  ) {
    this.debounce = Math.min(...definitions.map((item) => item.debounceMs));
  }
  async start() {
    await this.reconcile();
    if (!this.abort.signal.aborted)
      this.interval = setInterval(
        () => this.schedule(0),
        Math.min(...this.definitions.map((item) => item.reconcileMs)),
      );
  }
  stop() {
    this.abort.abort();
    clearTimeout(this.timer);
    clearInterval(this.interval);
    clearTimeout(this.watchdog);
    this.timer = this.interval = this.watchdog = undefined;
    for (const { watcher } of this.watchers.values()) watcher.close();
    this.watchers.clear();
    if (!this.running) this.releaseOnce();
  }
  settled() {
    return this.running ?? Promise.resolve();
  }
  private releaseOnce() {
    if (!this.released) {
      this.released = true;
      this.release();
    }
  }
  private failure(error: unknown) {
    if (this.abort.signal.aborted) return;
    this.stop();
    this.failed(
      new Error(`Git observation gap: ${error instanceof Error ? error.message : String(error)}`),
    );
  }
  private schedule(delay: number) {
    if (this.abort.signal.aborted) return;
    if (this.running) {
      this.dirty = true;
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.reconcile().catch((error) => this.failure(error));
    }, delay);
  }
  private attach(path: string, identity: string, allNames: boolean) {
    this.abort.signal.throwIfAborted();
    const previous = this.watchers.get(path);
    if (previous?.identity === identity) return;
    previous?.watcher.close();
    const watcher = watch(path, (_event, name) => {
      if (this.watchers.get(path)?.watcher !== watcher) return;
      if (allNames || gitMetadataName(name === null ? null : String(name)))
        this.schedule(this.debounce);
    });
    this.watchers.set(path, { identity, watcher });
    watcher.on('error', (error) => {
      if (this.watchers.get(path)?.watcher === watcher) this.failure(error);
    });
  }
  private reconcile() {
    if (this.running) {
      this.dirty = true;
      return this.running;
    }
    const task = this.read();
    this.running = task;
    this.watchdog = setTimeout(
      () => this.failure(new Error('Git scan exceeded 15 seconds')),
      HUDDLE_GIT_LIMITS.scanMs,
    );
    const finished = () => {
      clearTimeout(this.watchdog);
      this.watchdog = undefined;
      this.running = null;
      if (this.abort.signal.aborted) this.releaseOnce();
      else if (this.dirty) {
        this.dirty = false;
        this.schedule(this.debounce);
      }
    };
    void task.then(finished, finished);
    return task;
  }
  private check() {
    this.abort.signal.throwIfAborted();
    this.guard();
  }
  private async flush(definition: GitDefinition) {
    // Two disjoint 1025-entry snapshots require at most 33 batches.
    for (let batch = 0; batch < 33; batch++) {
      this.check();
      requireTriggerDirectory(
        definition.worktree,
        relative(definition.worktree, definition.repository) || '.',
      );
      if (!this.ledger.git.admit(definition.slot, this.generation, this.limits, Date.now())) return;
      this.admitted();
      await yieldTurn();
    }
    if (this.ledger.git.current(definition.slot)?.pending)
      throw new Error('Git reconciliation exceeds its admission bound');
  }
  private async read() {
    this.check();
    const identities: GitRepositoryIdentity[] = [];
    // Sequential, bounded children: Stop owns every process until its close event.
    for (const definition of this.definitions)
      identities.push(await identifyGitRepository(definition, this.abort.signal));
    this.check();
    if (
      this.identities &&
      identities.some((identity, i) => !sameGitRepository(identity, this.identities![i]!))
    )
      throw new Error('Git repository identity changed');
    this.identities = identities;
    const watched = await gitWatchDirectories(
      identities,
      this.abort.signal,
      (path, identity, allNames) => this.attach(path, identity, allNames),
    );
    this.check();
    for (const [path, { watcher }] of this.watchers)
      if (!watched.has(path)) {
        watcher.close();
        this.watchers.delete(path);
      }
    const groups = new Map<string, number[]>();
    identities.forEach((identity, i) =>
      groups.set(identity.commonDirectory, [...(groups.get(identity.commonDirectory) ?? []), i]),
    );
    for (const indices of groups.values()) {
      const prefixes = [
        ...new Set(
          indices.flatMap((i) =>
            this.definitions[i]!.refs.map(
              (pattern) => pattern.split('/').slice(0, 2).join('/') + '/',
            ),
          ),
        ),
      ];
      const refs = await readGitRefs(
        identities[indices[0]!]!.repository,
        prefixes,
        this.abort.signal,
      );
      const heads = new Map<string, Awaited<ReturnType<typeof readGitHead>>>();
      for (const i of indices) {
        const definition = this.definitions[i]!,
          identity = identities[i]!;
        if (definition.head && !heads.has(identity.repository))
          heads.set(identity.repository, await readGitHead(identity.repository, this.abort.signal));
        const snapshot = gitSnapshot(definition, refs, heads.get(identity.repository) ?? null);
        if (
          !sameGitRepository(identity, await identifyGitRepository(definition, this.abort.signal))
        )
          throw new Error('Git repository moved during observation');
        this.check();
        this.ledger.git.initialise(definition, this.activation, snapshot, identity.commonDirectory);
        await this.flush(definition);
        this.check();
        this.ledger.git.capture(definition.slot, this.generation, snapshot, Date.now());
        await this.flush(definition);
      }
    }
  }
}

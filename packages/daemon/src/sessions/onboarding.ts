import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { EventStore } from '../db/stores/events.js';
import type { RepoStore } from '../db/stores/repos.js';

/**
 * Onboarding preamble for freshly created worktrees (SPEC §4): standing rules
 * are applied without asking, open questions go to the user, and rules stated
 * mid-session are taught back via the marker file. Sessions reusing an
 * existing worktree (resume, hand-off) never receive this.
 */
export function buildOnboardingPreamble(notes: string | null, taskPrompt?: string | null): string {
  const rules = notes?.trim() ? notes.trim() : '(none recorded yet — everything is discretionary)';
  const preamble = `[puddle onboarding] This is a freshly created git worktree for this task. Before starting, set up the environment:

1. Standing setup rules for this repository (user-authored):
${rules}

2. Inspect the codebase for setup requirements (README, CONTRIBUTING, lockfiles, .tool-versions, pyproject.toml, package.json, …).
3. Apply what the rules above settle without asking. Ask the user about anything they leave open, stating trade-offs where relevant (e.g. a symlinked .venv saves gigabytes per worktree, but parallel sessions then share mutable dependency state).
4. If the user states a standing rule for all future worktrees ("always…", "never…", "from now on…"), write the complete updated rules to \`.puddle/onboarding-notes.md\` in this worktree — full replacement, user-owned prose; record their decision, don't invent policy.

Then proceed with the task below (or await instructions if none is given).`;
  return taskPrompt?.trim() ? `${preamble}\n\n---\n\n${taskPrompt}` : preamble;
}

export const INTERRUPTED_RESUME_NOTE =
  'This session was interrupted (daemon or machine restart). Processes you started are gone; re-verify your environment before continuing.';

/**
 * Watches each live session's `.puddle/onboarding-notes.md` and syncs edits
 * into repos.onboarding_notes. Last-writer-wins; the previous notes are
 * preserved in an event row so an unwanted overwrite is inspectable (SPEC §4).
 */
export class OnboardingNotesSync {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly deps: { repos: RepoStore; events: EventStore }) {}

  watch(sessionId: string, repoId: number, worktreePath: string): void {
    if (this.watchers.has(sessionId)) return;
    const dir = join(worktreePath, '.puddle');
    if (!existsSync(dir)) return;
    try {
      const watcher = watch(dir, () => this.schedule(sessionId, repoId, dir));
      watcher.on('error', () => this.unwatch(sessionId));
      this.watchers.set(sessionId, watcher);
    } catch {
      // A vanished dir between the check and the watch is not fatal.
    }
  }

  unwatch(sessionId: string): void {
    this.watchers.get(sessionId)?.close();
    this.watchers.delete(sessionId);
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
  }

  dispose(): void {
    for (const id of [...this.watchers.keys()]) this.unwatch(id);
  }

  private schedule(sessionId: string, repoId: number, dir: string): void {
    const existing = this.timers.get(sessionId);
    if (existing) clearTimeout(existing);
    this.timers.set(
      sessionId,
      setTimeout(() => {
        this.timers.delete(sessionId);
        this.sync(sessionId, repoId, dir);
      }, 300),
    );
  }

  private sync(sessionId: string, repoId: number, dir: string): void {
    const file = join(dir, 'onboarding-notes.md');
    if (!existsSync(file)) return;
    let next: string;
    try {
      next = readFileSync(file, 'utf8').trim();
    } catch {
      return;
    }
    const repo = this.deps.repos.get(repoId);
    if (next === '' || next === (repo.onboarding_notes ?? '').trim()) return;
    this.deps.events.record(sessionId, 'onboarding_notes_updated', {
      previous: repo.onboarding_notes,
    });
    this.deps.repos.setOnboardingNotes(repoId, next);
  }
}

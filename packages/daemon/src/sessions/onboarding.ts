import { existsSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { EventStore } from '../db/stores/events.js';
import type { RepoStore } from '../db/stores/repos.js';
import type { SessionStore } from '../db/stores/sessions.js';

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
5. Once you understand the task, name this session: write one short line (≤ 40 chars) describing it to \`.puddle/session-title\` (e.g. "fix flaky auth test"). Update it if the task changes.

Then proceed with the task below (or await instructions if none is given).`;
  return taskPrompt?.trim() ? `${preamble}\n\n---\n\n${taskPrompt}` : preamble;
}

export const INTERRUPTED_RESUME_NOTE =
  'This session was interrupted (daemon or machine restart). Processes you started are gone; re-verify your environment before continuing.';

/**
 * Watches each live session's `.puddle/` marker files: `onboarding-notes.md`
 * syncs into repos.onboarding_notes (last-writer-wins; the previous notes are
 * preserved in an event row so an unwanted overwrite is inspectable — SPEC §4)
 * and `session-title` lets the agent name its own session.
 */
export class MarkerFileSync {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly deps: { repos: RepoStore; events: EventStore; sessions: SessionStore },
  ) {}

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
    this.syncTitle(sessionId, dir);
    this.syncNotes(sessionId, repoId, dir);
  }

  /** `.puddle/session-title` → sessions.title (the agent naming its work). */
  private syncTitle(sessionId: string, dir: string): void {
    const file = join(dir, 'session-title');
    if (!existsSync(file)) return;
    let title: string;
    try {
      title = readFileSync(file, 'utf8').trim().replace(/\s+/g, ' ').slice(0, 80);
    } catch {
      return;
    }
    if (title === '') return;
    try {
      this.deps.sessions.setTitle(sessionId, title);
    } catch {
      // A session archived mid-watch is not fatal.
    }
  }

  private syncNotes(sessionId: string, repoId: number, dir: string): void {
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

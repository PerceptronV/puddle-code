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

/**
 * Prepended when a session attaches to an *existing* shared worktree
 * (separate_branch = false, SPEC §4): the branch and its working tree already
 * exist because other sessions are on them, so this agent is working
 * concurrently with others in the same directory. It gets the user's prompt —
 * the environment already exists, so no onboarding — plus this heads-up to
 * expect the tree to shift underneath it and to steer clear of git operations
 * that would trample the others.
 */
export function buildConcurrentWorktreeNote(taskPrompt?: string | null): string {
  const note = `[puddle] You are joining an existing branch and worktree that other agents may be working in concurrently. Files can change underneath you, so re-check the working tree before you act, and avoid disruptive git operations (resetting, force-pushing, or deleting the branch) that would disrupt work already in progress by others.`;
  return taskPrompt?.trim() ? `${note}\n\n---\n\n${taskPrompt}` : note;
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
  /** Last `session-title` content applied per session — see syncTitle. */
  private readonly lastTitle = new Map<string, string>();
  /** Applies an agent-chosen title; set by the daemon to broadcast the change. */
  private titleSink?: (sessionId: string, title: string) => void;

  constructor(
    private readonly deps: { repos: RepoStore; events: EventStore; sessions: SessionStore },
  ) {}

  /**
   * Routes agent-chosen titles through the session service so the rename
   * broadcasts to attached clients (default: a plain store write, for tests).
   */
  setTitleSink(sink: (sessionId: string, title: string) => void): void {
    this.titleSink = sink;
  }

  watch(sessionId: string, repoId: number, worktreePath: string): void {
    if (this.watchers.has(sessionId)) return;
    const dir = join(worktreePath, '.puddle');
    if (!existsSync(dir)) return;
    // Seed the last-seen title with what is already on disk so a pre-existing
    // file (a resumed worktree) is not re-applied on the next unrelated
    // `.puddle` change — that would clobber a title the user set via the UI.
    // Only a genuine *change* to the file after this point counts as the agent
    // renaming its work.
    this.lastTitle.set(sessionId, this.readTitle(dir) ?? '');
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
    this.lastTitle.delete(sessionId);
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

  /**
   * `.puddle/session-title` → sessions.title (the agent naming its work).
   * Applied only when the file's content actually *changes*, not on every
   * `.puddle` event: otherwise an unrelated change (a pasted image landing in
   * `.puddle/pastes/`, an onboarding-notes edit) would re-apply the stale file
   * content and overwrite a title the user set via the UI. Mirrors syncNotes,
   * which likewise skips no-op writes.
   */
  private syncTitle(sessionId: string, dir: string): void {
    const title = this.readTitle(dir);
    if (title === null || title === '') return;
    if (title === this.lastTitle.get(sessionId)) return;
    this.lastTitle.set(sessionId, title);
    try {
      if (this.titleSink) this.titleSink(sessionId, title);
      else this.deps.sessions.setTitle(sessionId, title);
    } catch {
      // A session archived mid-watch is not fatal.
    }
  }

  /** Normalised `session-title` content, or null if absent/unreadable. */
  private readTitle(dir: string): string | null {
    const file = join(dir, 'session-title');
    if (!existsSync(file)) return null;
    try {
      return readFileSync(file, 'utf8').trim().replace(/\s+/g, ' ').slice(0, 80);
    } catch {
      return null;
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

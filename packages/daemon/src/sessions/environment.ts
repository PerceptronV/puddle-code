import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { Session, SessionEnvResponse } from '@puddle/shared';
import type { PtyEnvDeltaEvent, PtyCwdEvent } from '../pty/pty-manager.js';
import { isDeniedEnvName, type ShellHooks } from '../pty/shell-hooks.js';
import type { SessionServiceDeps } from './service.js';

const MAX_ENV_VALUE_BYTES = 32 * 1024;
const MAX_ENV_VARS = 128;
type EnvironmentDeps = Pick<
  SessionServiceDeps,
  | 'profiles'
  | 'projects'
  | 'sessions'
  | 'ptys'
  | 'logs'
  | 'runtimes'
  | 'runtimeShellHooks'
  | 'shellHooks'
>;

/** Captured shell observations and spawn preparation shared by ownership backends. */
export class SessionEnvironment {
  private readonly envDropNoted = new Set<string>();
  constructor(private readonly deps: EnvironmentDeps) {}

  /** The profile gate for captured env (SPEC §4): reporting, consumption, and re-injection. */
  captureEnvEnabled(projectId: string): boolean {
    const project = this.deps.projects.get(projectId);
    return this.deps.profiles.getSettings(project.profile_id).captureSessionEnv;
  }

  /**
   * Consume a captured-env report from a session PTY's OSC 7733 side-channel.
   * Non-session streams (home, login-*) report nothing consumable; denylist and
   * caps are re-checked here even though the hook filters — the emitter is an
   * arbitrary process in the worktree, not just our hook.
   */
  onEnvDelta(e: PtyEnvDeltaEvent): void {
    let session: Session;
    try {
      session = this.deps.sessions.get(e.stream);
    } catch {
      return;
    }
    if (!this.captureEnvEnabled(session.project_id)) return;
    const { delta } = e;
    if (isDeniedEnvName(delta.name)) return;
    if (delta.op === 'unset') {
      this.deps.sessions.mergeEnv(session.id, {}, [delta.name]);
      return;
    }
    const value = delta.value ?? '';
    if (Buffer.byteLength(value) > MAX_ENV_VALUE_BYTES) {
      this.noteEnvDropOnce(session.id, e.term, delta.name, 'its value exceeds 32 KiB');
      return;
    }
    const current = this.deps.sessions.getEnv(session.id);
    if (!(delta.name in current) && Object.keys(current).length >= MAX_ENV_VARS) {
      this.noteEnvDropOnce(
        session.id,
        e.term,
        delta.name,
        `the session already holds ${MAX_ENV_VARS} captured vars`,
      );
      return;
    }
    this.deps.sessions.mergeEnv(session.id, { [delta.name]: value }, []);
  }

  /**
   * Persist a terminal shell's last prompt directory for its next spawn. The
   * public cwd contract is deliberately worktree-relative, so an outside cwd
   * resets the restart location to the worktree root instead of storing an
   * arbitrary absolute path. Agent sessions ignore shell-tab reports.
   */
  onCwd(e: PtyCwdEvent): void {
    let session: Session;
    try {
      session = this.deps.sessions.get(e.stream);
    } catch {
      return;
    }
    if (session.kind !== 'terminal') return;

    const absolute = resolve(e.cwd);
    try {
      if (!existsSync(absolute) || !statSync(absolute).isDirectory()) return;
    } catch {
      // The directory may disappear between exists/stat; ignore a stale prompt.
      return;
    }
    const rel = relative(resolve(session.worktree_path), absolute);
    const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
    const cwd = outside || rel === '' ? null : rel;
    if ((session.cwd ?? null) !== cwd) this.deps.sessions.setCwd(session.id, cwd);
  }

  private noteEnvDropOnce(sessionId: string, term: string, name: string, reason: string): void {
    const key = `${sessionId}:${name}`;
    if (this.envDropNoted.has(key)) return;
    this.envDropNoted.add(key);
    this.deps.ptys.note(sessionId, term, `captured env: ${name} not persisted — ${reason}`);
  }

  /**
   * Captured vars to merge into a session PTY's spawn env, denylist-refiltered
   * (defence against rows written by an older build). Empty when the profile
   * gate is off — the feature goes fully dormant, but the stored map is kept.
   */
  capturedSpawnEnv(session: Session): Record<string, string> {
    if (!this.captureEnvEnabled(session.project_id)) return {};
    return Object.fromEntries(
      Object.entries(this.deps.sessions.getEnv(session.id)).filter(([k]) => !isDeniedEnvName(k)),
    );
  }

  /** Captured vars for the authenticated cockpit's env strip (SPEC §4). */
  capturedEnv(id: string): SessionEnvResponse {
    const env = this.deps.sessions.getEnv(id); // 404s for an unknown session
    const vars = Object.entries(env)
      .map(([name, value]) => ({ name, value, bytes: Buffer.byteLength(value) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { vars };
  }

  /** Shell command, hook args, and env for a session terminal spawn (SPEC §4). */
  shellSpawnParts(
    sessionId: string,
    includeCaptured = true,
    pinnedHooks?: ShellHooks,
  ): {
    shell: string;
    args: string[];
    env: Record<string, string>;
  } {
    const shell = process.env.SHELL ?? 'bash';
    const session = this.deps.sessions.get(sessionId);
    const captureEnv = this.captureEnvEnabled(session.project_id);
    const captured = includeCaptured ? this.capturedSpawnEnv(session) : {};
    const historyFile = this.deps.logs.historyFile(sessionId);
    const owner = this.deps.runtimes?.ownerOf(sessionId);
    const hooks =
      pinnedHooks ??
      (owner ? this.deps.runtimeShellHooks?.(owner.runtime_id) : null) ??
      this.deps.shellHooks;
    const hook = hooks?.spawnConfig(shell, { captureEnv, historyFile });
    // Hook control vars win over anything captured (ZDOTDIR is denylisted anyway).
    return {
      shell,
      args: hook?.args ?? [],
      env: { ...captured, HISTFILE: historyFile, ...(hook?.env ?? {}) },
    };
  }
}

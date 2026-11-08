import { randomUUID } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { huddleIdSchema, type Session } from '@puddle/shared';
import type { Db } from '../../db.js';
import { SessionStore } from '../sessions.js';

/** Application identity only. The authorised service resolves project/worktree and capability first. */
export class HuddlePlacements {
  private readonly sessions: SessionStore;
  constructor(private readonly db: Db) {
    this.sessions = new SessionStore(db);
  }

  find(projectId: string, worktree: string, huddleId: string): Session | undefined {
    const row = this.db
      .prepare(
        `SELECT id FROM sessions WHERE kind = 'huddle'
      AND project_id = ? AND canonical_worktree_path = ? AND huddle_id = ?`,
      )
      .get(projectId, worktree, huddleId) as { id: string } | undefined;
    return row ? this.sessions.get(row.id) : undefined;
  }

  open(input: {
    projectId: string;
    worktree: string;
    huddleId: string;
    branch: string;
    title: string;
  }) {
    const huddleId = huddleIdSchema.parse(input.huddleId);
    const worktree = realpathSync(input.worktree);
    if (!statSync(worktree).isDirectory()) throw new Error('Huddle worktree is not a directory');
    return this.db.transaction(() => {
      const previous = this.db
        .prepare(
          `SELECT id FROM sessions WHERE kind = 'huddle'
        AND project_id = ? AND canonical_worktree_path = ? AND huddle_id = ?`,
        )
        .get(input.projectId, worktree, huddleId) as { id: string } | undefined;
      if (previous) return { session: this.sessions.get(previous.id), created: false };
      const session = this.sessions.create({
        id: randomUUID(),
        project_id: input.projectId,
        worktree_path: worktree,
        huddle_id: huddleId,
        kind: 'huddle',
        account_id: null,
        agent_type: null,
        base_branch: input.branch,
        branch: input.branch,
        separate_branch: false,
        branch_owned: false,
        skip_permissions: false,
        title: input.title,
        status: 'exited',
      });
      return { session, created: true };
    })();
  }
  get(sessionId: string): Session & { huddle_id: string } {
    const session = this.sessions.get(sessionId);
    if (session.kind !== 'huddle' || !session.huddle_id)
      throw new Error('Placement is not a huddle');
    return { ...session, huddle_id: session.huddle_id };
  }
}

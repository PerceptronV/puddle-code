import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Account } from '@puddle/shared';
import type { ConversationShareHooks } from './adapter.js';

/**
 * Shared conversation store for Claude Code (Workstream S). Agent-specific
 * mechanics only — the agnostic adoption/mirror/backfill/reconcile/archive
 * logic lives in `src/sessions/conversation-share.ts`.
 *
 * Store layout: Claude keeps each conversation as
 * `<config>/projects/<escaped-cwd>/<uuid>.jsonl`. The per-conversation dir
 * (`<escaped-cwd>`) is the share unit — its basename is the store-key. Because
 * the escaped name derives from the MAIN repository root (not the worktree
 * path — see the pinned finding in claude-code.ts), every worktree of a repo
 * maps to the SAME store-key, so one canonical dir may span a repo's worktrees.
 *
 * Verified against Claude Code 2.1.209 (2026-07-14):
 * - Symlink read-through CONFIRMED: with a hand-crafted transcript in a
 *   canonical dir and `projects/<escaped-cwd>` a symlink pointing at it,
 *   `claude --resume <uuid>` resumed the conversation (env scrubbed of
 *   CLAUDECODE/CLAUDE_CODE_* per CLAUDE.md; scratch CLAUDE_CONFIG_DIR). Claude
 *   resolves the store dir by the escaped REALPATH cwd (`/private/tmp/x` →
 *   `-private-tmp-x`) — it opens that one dir by name, which is why puddle's
 *   own hasConversation/discoverSessionRef scan `projects/*` instead of
 *   computing the (main-repo-root) escaped name for a worktree.
 * - Graceful degradation PARTIALLY CONFIRMED: the resume above carried NO
 *   `todos/<uuid>*.json` file and Claude resumed without error — evidence that
 *   missing per-account ancillary state does not break a cross-account resume.
 * - Todos are per-account ancillary state at `<config>/todos/<uuid>*.json`
 *   (glob because Claude has historically suffixed an agent id) and do NOT
 *   travel with the conversation dir.
 *
 * DEFERRED to docs/acceptance/tier1-migration.md (Task 18): the full tier-1
 * flow end to end — adopt under account A, then `--resume` under account B via
 * B's mirror symlink with B's real credentials — needs two logged-in accounts
 * this session does not have. The per-mechanism pieces above are verified.
 */
export const claudeConversationShare: ConversationShareHooks = {
  storeParent(account: Account): string {
    return join(account.config_dir, 'projects');
  },

  locateStoreDir(ref: string, account: Account): string | null {
    const projectsDir = join(account.config_dir, 'projects');
    if (!existsSync(projectsDir)) return null;
    for (const dir of readdirSync(projectsDir)) {
      // existsSync follows symlinks, so a post-adoption symlinked dir resolves.
      if (existsSync(join(projectsDir, dir, `${ref}.jsonl`))) {
        return join(projectsDir, dir);
      }
    }
    return null;
  },

  sessionFiles(ref: string, storeDir: string, account: Account) {
    const inStore = [join(storeDir, `${ref}.jsonl`)];
    const todosDir = join(account.config_dir, 'todos');
    const perAccount: string[] = [];
    if (existsSync(todosDir)) {
      for (const file of readdirSync(todosDir)) {
        // `<uuid>.json` and any `<uuid>-<agent>.json` suffix variant.
        if (file === `${ref}.json` || file.startsWith(`${ref}-`)) {
          perAccount.push(join(todosDir, file));
        }
      }
    }
    return { inStore, perAccount };
  },
};

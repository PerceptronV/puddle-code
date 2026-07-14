import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Account } from '@puddle/shared';
import { claudeCode } from '../src/agents/claude-code.js';

function account(configDir: string): Account {
  return {
    id: 1,
    profile_id: 1,
    agent_type: 'claude-code',
    label: 'work',
    config_dir: configDir,
    logged_in: true,
    skip_permissions_default: false,
    created_at: '2026-01-01T00:00:00Z',
  };
}

describe('claude-code adapter', () => {
  it('seeds a fresh config dir so the first-run wizard never runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-cc-'));
    claudeCode.prepareConfigDir!(dir);
    const state = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    // The wizard re-runs login and discards --session-id; this flag skips it.
    expect(state['hasCompletedOnboarding']).toBe(true);
  });

  it('finds conversations in any escaped project dir, and only real ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-cc-'));
    const ref = '67194578-8ea8-484a-bb7d-6698b3049cc4';
    // No projects dir at all → no conversation.
    expect(claudeCode.hasConversation!(ref, account(dir))).toBe(false);
    // Worktree sessions store under the MAIN repo's escaped path, so the
    // lookup must scan project dirs rather than derive one from the cwd.
    const project = join(dir, 'projects', '-Users-alice-src-my-repo');
    mkdirSync(project, { recursive: true });
    expect(claudeCode.hasConversation!(ref, account(dir))).toBe(false);
    writeFileSync(join(project, `${ref}.jsonl`), '{}\n');
    expect(claudeCode.hasConversation!(ref, account(dir))).toBe(true);
    expect(claudeCode.hasConversation!('someone-else', account(dir))).toBe(false);
  });
});

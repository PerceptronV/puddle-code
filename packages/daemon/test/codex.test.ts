import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Account } from '@puddle/shared';
import { codex } from '../src/agents/codex.js';
import { newestRolloutFor, renderRollout } from '../src/agents/codex-rollout.js';

function account(configDir: string): Account {
  return {
    id: 1,
    profile_id: 'p',
    agent_type: 'codex',
    label: 'personal',
    config_dir: configDir,
    logged_in: true,
    skip_permissions_default: false,
    created_at: new Date().toISOString(),
  } as Account;
}

/** Writes a rollout in codex's real layout: sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl */
function writeRollout(
  configDir: string,
  id: string,
  cwd: string,
  records: unknown[] = [],
  day = '01',
): string {
  const dir = join(configDir, 'sessions', '2026', '07', day);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-07-${day}T10-00-00-${id}.jsonl`);
  const meta = {
    timestamp: `2026-07-${day}T10:00:00.000Z`,
    type: 'session_meta',
    payload: { id, timestamp: `2026-07-${day}T10:00:00.000Z`, cwd, cli_version: '0.146.0' },
  };
  writeFileSync(path, [meta, ...records].map((r) => JSON.stringify(r)).join('\n') + '\n');
  return path;
}

const UUID_A = '019b746c-0713-7b11-a6b7-a812f20db547';
const UUID_B = '019b64f3-f981-74a3-9606-132bdae0f80c';

describe('codex adapter — args', () => {
  const opts = { worktreePath: '/wt', sessionId: 's1', skipPermissions: false };

  it('isolates state through CODEX_HOME alone', () => {
    expect(codex.env(account('/cfg'))).toEqual({ CODEX_HOME: '/cfg' });
  });

  it('launches bare, and only adds the bypass flag when skipping', () => {
    expect(codex.launchArgs(opts)).toEqual([]);
    expect(codex.launchArgs({ ...opts, skipPermissions: true })).toEqual([
      '--dangerously-bypass-approvals-and-sandbox',
    ]);
    // Verified 0.146.0: --yolo does NOT exist, only the long form.
    expect(codex.launchArgs({ ...opts, skipPermissions: true })).not.toContain('--yolo');
  });

  it('passes the initial prompt as a positional', () => {
    expect(codex.launchArgs({ ...opts, prompt: 'do the thing' })).toEqual(['do the thing']);
  });

  it('resumes as `codex resume <id>`, flags before the positionals', () => {
    expect(codex.resumeArgs(UUID_A, opts)).toEqual(['resume', UUID_A]);
    expect(
      codex.resumeArgs(UUID_A, { ...opts, skipPermissions: true, prompt: 'carry on' }),
    ).toEqual(['resume', '--dangerously-bypass-approvals-and-sandbox', UUID_A, 'carry on']);
  });

  it('logs in with `codex login`', () => {
    expect(codex.loginArgs()).toEqual(['login']);
  });

  it('cannot preset its session id', () => {
    expect(codex.capabilities.presetSessionId).toBe(false);
  });
});

describe('codex adapter — rollout discovery', () => {
  it('finds the newest rollout recorded against the worktree', () => {
    const cfg = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
    writeRollout(cfg, UUID_A, '/wt', [], '01');
    writeRollout(cfg, UUID_B, '/other', [], '02');
    expect(newestRolloutFor(cfg, '/wt')?.id).toBe(UUID_A);
    expect(newestRolloutFor(cfg, '/other')?.id).toBe(UUID_B);
    expect(newestRolloutFor(cfg, '/nope')).toBeUndefined();
  });

  it('reports a conversation by id, and misses an unknown one', () => {
    const cfg = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
    writeRollout(cfg, UUID_A, '/wt');
    expect(codex.hasConversation?.(UUID_A, account(cfg))).toBe(true);
    expect(codex.hasConversation?.(UUID_B, account(cfg))).toBe(false);
  });

  it('falls back to the puddle session id when no rollout appears', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
    const ref = await codex.resolveSessionRef(
      { worktreePath: '/wt', sessionId: 'puddle-id', skipPermissions: false },
      account(cfg),
    );
    // Deliberate: hasConversation reports it missing, so resume re-discovers.
    expect(ref).toBe('puddle-id');
    expect(codex.hasConversation?.('puddle-id', account(cfg))).toBe(false);
  });

  it('survives a missing or malformed sessions tree', () => {
    const cfg = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
    expect(newestRolloutFor(cfg, '/wt')).toBeUndefined();
    const dir = join(cfg, 'sessions', '2026', '07', '01');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-x-${UUID_A}.jsonl`), 'not json\n');
    expect(newestRolloutFor(cfg, '/wt')).toBeUndefined();
  });
});

describe('codex adapter — transcript export', () => {
  it('renders the user/agent pair and collapses tool calls', () => {
    const cfg = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
    const path = writeRollout(cfg, UUID_A, '/wt', [
      { type: 'event_msg', payload: { type: 'user_message', message: 'add a test' } },
      { type: 'response_item', payload: { type: 'function_call' } },
      { type: 'response_item', payload: { type: 'custom_tool_call' } },
      { type: 'event_msg', payload: { type: 'agent_reasoning', text: 'private thinking' } },
      { type: 'response_item', payload: { type: 'reasoning' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'done' } },
    ]);
    const text = renderRollout(path);
    expect(text).toContain('## User\n\nadd a test');
    expect(text).toContain('## Assistant\n\ndone');
    expect(text).toContain('_(ran 2 tool calls)_');
    // Tier 2 is degraded by design: the agent's private reasoning never travels.
    expect(text).not.toContain('private thinking');
  });

  it('exports through the adapter hook, and empty for an unknown ref', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'codex-cfg-'));
    writeRollout(cfg, UUID_A, '/wt', [
      { type: 'event_msg', payload: { type: 'user_message', message: 'hello' } },
    ]);
    expect(await codex.exportTranscript?.(UUID_A, account(cfg), '/wt')).toContain('hello');
    expect(await codex.exportTranscript?.(UUID_B, account(cfg), '/wt')).toBe('');
  });
});

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Account } from '@puddle/shared';
import { geminiCli } from '../src/agents/gemini-cli.js';
import { opencode } from '../src/agents/opencode.js';

function account(configDir: string, agentType: string): Account {
  return {
    id: 1,
    profile_id: 'p',
    agent_type: agentType,
    label: 'personal',
    config_dir: configDir,
    logged_in: true,
    skip_permissions_default: false,
    created_at: new Date().toISOString(),
  } as Account;
}

const OPTS = { worktreePath: '/wt', sessionId: 'puddle-uuid', skipPermissions: false };

describe('opencode adapter', () => {
  it('isolates every XDG root, since auth.json lives under the DATA root', () => {
    // Verified against opencode 1.18.10 `debug paths`: OPENCODE_CONFIG_DIR
    // relocates nothing, so all four XDG roots must be redirected.
    const env = opencode.env(account('/cfg', 'opencode'));
    expect(env).toEqual({
      XDG_CONFIG_HOME: '/cfg/config',
      XDG_DATA_HOME: '/cfg/data',
      XDG_CACHE_HOME: '/cfg/cache',
      XDG_STATE_HOME: '/cfg/state',
    });
    expect(env['OPENCODE_CONFIG_DIR']).toBeUndefined();
  });

  it('creates the XDG roots when preparing a fresh config dir', () => {
    const cfg = mkdtempSync(join(tmpdir(), 'oc-cfg-'));
    opencode.prepareConfigDir?.(cfg);
    for (const sub of ['config', 'data', 'cache', 'state']) {
      expect(() => mkdirSync(join(cfg, sub), { recursive: false })).toThrow(); // already exists
    }
  });

  it('skips permissions with --auto and seeds the prompt with --prompt', () => {
    expect(opencode.launchArgs(OPTS)).toEqual([]);
    expect(opencode.launchArgs({ ...OPTS, skipPermissions: true, prompt: 'go' })).toEqual([
      '--auto',
      '--prompt',
      'go',
    ]);
    // SPEC §5 used to claim opencode could not flag permissions; --auto exists.
    expect(opencode.capabilities.skipPermissions).toBe(true);
  });

  it('resumes with --session <ses_id>', () => {
    expect(opencode.resumeArgs('ses_abc', OPTS)).toEqual(['--session', 'ses_abc']);
    expect(opencode.loginArgs()).toEqual(['auth', 'login']);
  });

  it('discovers the newest session recorded against the worktree', () => {
    const cfg = mkdtempSync(join(tmpdir(), 'oc-cfg-'));
    const store = join(cfg, 'data', 'opencode', 'storage', 'session', 'proj');
    mkdirSync(store, { recursive: true });
    writeFileSync(
      join(store, 'ses_old.json'),
      JSON.stringify({ id: 'ses_old', directory: '/wt', time: { updated: 100 } }),
    );
    writeFileSync(
      join(store, 'ses_new.json'),
      JSON.stringify({ id: 'ses_new', directory: '/wt', time: { updated: 200 } }),
    );
    writeFileSync(
      join(store, 'ses_other.json'),
      JSON.stringify({ id: 'ses_other', directory: '/elsewhere', time: { updated: 300 } }),
    );
    expect(opencode.discoverSessionRef?.('/wt', account(cfg, 'opencode'))).toBe('ses_new');
    expect(opencode.discoverSessionRef?.('/nope', account(cfg, 'opencode'))).toBeNull();
  });

  it('returns null rather than guessing when the store is absent', () => {
    const cfg = mkdtempSync(join(tmpdir(), 'oc-cfg-'));
    expect(opencode.discoverSessionRef?.('/wt', account(cfg, 'opencode'))).toBeNull();
  });
});

describe('gemini-cli adapter', () => {
  it('isolates via GEMINI_CLI_HOME, never GEMINI_CONFIG_DIR', () => {
    // Verified 0.53.1: GEMINI_CONFIG_DIR is ignored and the CLI falls back to
    // the real ~/.gemini, which would breach SPEC §2.
    const env = geminiCli.env(account('/cfg', 'gemini-cli'));
    expect(env).toEqual({ GEMINI_CLI_HOME: '/cfg' });
    expect(env['GEMINI_CONFIG_DIR']).toBeUndefined();
  });

  it('presets the session id and stays interactive when seeding a prompt', () => {
    expect(geminiCli.launchArgs(OPTS)).toEqual(['--session-id', 'puddle-uuid']);
    // -p/--prompt is headless and would exit immediately; -i keeps the TUI.
    const withPrompt = geminiCli.launchArgs({ ...OPTS, prompt: 'go' });
    expect(withPrompt).toContain('--prompt-interactive');
    expect(withPrompt).not.toContain('--prompt');
    expect(geminiCli.capabilities.presetSessionId).toBe(true);
  });

  it('skips permissions with the explicit approval mode', () => {
    expect(geminiCli.launchArgs({ ...OPTS, skipPermissions: true })).toEqual([
      '--session-id',
      'puddle-uuid',
      '--approval-mode',
      'yolo',
    ]);
  });

  it('resumes by ref and logs in via a bare launch (it has no auth subcommand)', () => {
    expect(geminiCli.resumeArgs('abc-123', OPTS)).toEqual(['--resume', 'abc-123']);
    expect(geminiCli.loginArgs()).toEqual([]);
  });

  it('echoes the preset id as the session ref', async () => {
    expect(await geminiCli.resolveSessionRef(OPTS, account('/cfg', 'gemini-cli'))).toBe(
      'puddle-uuid',
    );
  });

  it('detects login from the credentials file, since there is no status command', async () => {
    const cfg = mkdtempSync(join(tmpdir(), 'gm-cfg-'));
    const dir = join(cfg, '.gemini');
    mkdirSync(dir, { recursive: true });
    expect(await geminiCli.checkLoggedIn?.(account(cfg, 'gemini-cli'))).toBe(false);
    writeFileSync(join(dir, 'oauth_creds.json'), '{}');
    expect(await geminiCli.checkLoggedIn?.(account(cfg, 'gemini-cli'))).toBe(true);
  });

  it('resolves the chats dir through the CLI’s own projects.json map', () => {
    const cfg = mkdtempSync(join(tmpdir(), 'gm-cfg-'));
    const dir = join(cfg, '.gemini');
    mkdirSync(join(dir, 'tmp', 'puddle', 'chats'), { recursive: true });
    writeFileSync(
      join(dir, 'projects.json'),
      JSON.stringify({ projects: { '/wt': 'puddle' } }, null, 2),
    );
    writeFileSync(join(dir, 'tmp', 'puddle', 'chats', 'sess-1.json'), '{}');
    expect(geminiCli.discoverSessionRef?.('/wt', account(cfg, 'gemini-cli'))).toBe('sess-1');
    // An unmapped worktree is a miss, not a wrong answer.
    expect(geminiCli.discoverSessionRef?.('/other', account(cfg, 'gemini-cli'))).toBeNull();
  });
});

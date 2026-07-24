import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyAgentPath, loadConfig, saveConfig } from '../src/config.js';
import { ensureHome, resolvePaths } from '../src/paths.js';
import { ensureToken } from '../src/security/token.js';

function freshPaths() {
  const p = resolvePaths(mkdtempSync(join(tmpdir(), 'puddle-home-')));
  ensureHome(p);
  return p;
}

describe('resolvePaths', () => {
  it('lays out every path under the given home', () => {
    const home = '/x/home';
    const p = resolvePaths(home);
    expect(p.dbFile).toBe(join(home, 'puddle.db'));
    expect(p.tokenFile).toBe(join(home, 'token'));
    expect(p.configFile).toBe(join(home, 'config.json'));
    expect(p.accountConfigDir('alice', 'claude-code', 'personal')).toBe(
      join(home, 'profiles', 'alice', 'accounts', 'claude-code', 'personal'),
    );
    expect(p.sessionWorktreeDir(3, 'abc')).toBe(join(home, 'worktrees', '3', 'abc'));
    expect(p.sessionLogDir('abc')).toBe(join(home, 'logs', 'abc'));
    expect(p.shellHooksDir).toBe(join(home, 'shell-hooks'));
  });

  it('honours PUDDLE_HOME when no explicit home is given', () => {
    process.env.PUDDLE_HOME = '/tmp/elsewhere';
    try {
      expect(resolvePaths().home).toBe('/tmp/elsewhere');
    } finally {
      delete process.env.PUDDLE_HOME;
    }
  });
});

describe('daemon config', () => {
  it('returns defaults when config.json is absent and writes it', () => {
    const paths = freshPaths();
    const cfg = loadConfig(paths);
    expect(cfg).toEqual({
      port: 7434,
      autoResume: false,
      fetchIntervalMinutes: 15,
      logMaxBytes: 10 * 1024 * 1024,
      replayBytes: 256 * 1024,
      uiStateRetentionDays: 90,
      agentPath: '~/.local/bin:~/bin:/opt/homebrew/bin:/usr/local/bin',
    });
    const onDisk = JSON.parse(readFileSync(paths.configFile, 'utf8'));
    expect(onDisk.port).toBe(7434);
    expect(onDisk.configVersion).toBe(2);
  });

  it('migrates a pre-Phase-6 default port (7433, no marker) to 7434 exactly once', () => {
    const paths = freshPaths();
    writeFileSync(paths.configFile, JSON.stringify({ port: 7433 }) + '\n');
    expect(loadConfig(paths).port).toBe(7434);
    expect(JSON.parse(readFileSync(paths.configFile, 'utf8')).configVersion).toBe(2);
  });

  it('respects a deliberate post-migration 7433 (marker present)', () => {
    const paths = freshPaths();
    writeFileSync(paths.configFile, JSON.stringify({ port: 7433, configVersion: 2 }) + '\n');
    expect(loadConfig(paths).port).toBe(7433);
    expect(saveConfig(paths, { autoResume: true }).port).toBe(7433);
  });

  it('keeps a custom pre-Phase-6 port through the migration', () => {
    const paths = freshPaths();
    writeFileSync(paths.configFile, JSON.stringify({ port: 7500 }) + '\n');
    expect(loadConfig(paths).port).toBe(7500);
  });

  it('never exposes the marker through the API shape', () => {
    const paths = freshPaths();
    loadConfig(paths);
    expect('configVersion' in loadConfig(paths)).toBe(false);
  });

  it('merges patches and persists them', () => {
    const paths = freshPaths();
    loadConfig(paths);
    const updated = saveConfig(paths, { autoResume: true });
    expect(updated.autoResume).toBe(true);
    expect(loadConfig(paths).autoResume).toBe(true);
  });

  it('rejects an invalid patch', () => {
    const paths = freshPaths();
    loadConfig(paths);
    expect(() => saveConfig(paths, { port: -1 })).toThrow();
  });
});

describe('ensureToken', () => {
  it('creates a 0600 hex token once and reuses it', () => {
    const paths = freshPaths();
    const first = ensureToken(paths);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(paths.tokenFile).mode & 0o777).toBe(0o600);
    expect(ensureToken(paths)).toBe(first);
  });
});

describe('applyAgentPath', () => {
  it('prepends tilde-expanded, de-duplicated dirs to PATH', () => {
    const saved = process.env.PATH;
    try {
      process.env.PATH = '/usr/bin:/bin';
      applyAgentPath('~/.local/bin:/usr/bin'); // /usr/bin already present → not duplicated
      expect(process.env.PATH).toBe(`${homedir()}/.local/bin:/usr/bin:/bin`);
    } finally {
      process.env.PATH = saved;
    }
  });

  it('is a no-op for an empty agentPath', () => {
    const saved = process.env.PATH;
    try {
      process.env.PATH = '/usr/bin:/bin';
      applyAgentPath('   ');
      expect(process.env.PATH).toBe('/usr/bin:/bin');
    } finally {
      process.env.PATH = saved;
    }
  });
});

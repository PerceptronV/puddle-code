import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { claudeCode } from '../src/agents/claude-code.js';
import { AdapterRegistry } from '../src/agents/registry.js';
import { LogStore } from '../src/logs/log-store.js';
import { extractOscTitle, stripAnsi } from '../src/pty/ansi.js';
import { PtyManager } from '../src/pty/pty-manager.js';
import { StatusDetector } from '../src/pty/status-detector.js';

async function waitFor(cond: () => boolean, ms = 8000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('claude-code adapter', () => {
  const account = {
    id: 1,
    profile_id: 1,
    agent_type: 'claude-code',
    label: 'personal',
    config_dir: '/home/alice/.puddle/profiles/alice/accounts/claude-code/personal',
    skip_permissions_default: false,
    logged_in: true,
    created_at: '2026-07-13T00:00:00Z',
  };

  it('isolates config via CLAUDE_CONFIG_DIR', () => {
    expect(claudeCode.env(account)).toEqual({ CLAUDE_CONFIG_DIR: account.config_dir });
  });

  it('presets the session id and appends the prompt', () => {
    const args = claudeCode.launchArgs({
      worktreePath: '/wt',
      sessionId: 'abc-123',
      prompt: 'do the thing',
      skipPermissions: false,
    });
    expect(args).toEqual(['--session-id', 'abc-123', 'do the thing']);
  });

  it('adds the skip flag only when requested', () => {
    const args = claudeCode.launchArgs({
      worktreePath: '/wt',
      sessionId: 'abc',
      skipPermissions: true,
    });
    expect(args).toContain('--dangerously-skip-permissions');
  });

  it('resumes by ref with an optional prompt', () => {
    expect(
      claudeCode.resumeArgs('ref-1', {
        worktreePath: '/wt',
        sessionId: 'x',
        skipPermissions: false,
        prompt: 'note',
      }),
    ).toEqual(['--resume', 'ref-1', 'note']);
  });

  it('echoes the preset session ref', async () => {
    await expect(
      claudeCode.resolveSessionRef(
        { worktreePath: '/wt', sessionId: 'sid-9', skipPermissions: false },
        account,
      ),
    ).resolves.toBe('sid-9');
  });

  it('registry resolves by id and rejects unknown types', () => {
    const registry = new AdapterRegistry([claudeCode]);
    expect(registry.get('claude-code').binary).toBe('claude');
    expect(() => registry.get('nonsense')).toThrow(/no adapter/);
  });
});

describe('stripAnsi', () => {
  it('removes colours, cursor movement and OSC titles', () => {
    expect(stripAnsi('\u001b[32m│ >\u001b[0m ready \u001b]0;title\u0007done')).toBe(
      '│ > ready done',
    );
  });
});

describe('extractOscTitle', () => {
  it('reads an OSC 0/1/2 title, BEL- or ST-terminated', () => {
    expect(extractOscTitle('before \u001b]0;my session\u0007 after')).toBe('my session');
    expect(extractOscTitle('\u001b]2;window\u001b\\')).toBe('window');
    expect(extractOscTitle('\u001b]1;icon\u0007')).toBe('icon');
  });

  it('strips a leading spinner/status glyph so the name is animation-stable', () => {
    // Braille spinner frames (Claude Code) and a symbol prefix both collapse.
    expect(extractOscTitle('\u001b]0;⠋ hey\u0007')).toBe('hey');
    expect(extractOscTitle('\u001b]0;⠙ hey\u0007')).toBe('hey');
    expect(extractOscTitle('\u001b]0;✳ hey\u0007')).toBe('hey');
  });

  it('takes the last title in the chunk and collapses whitespace', () => {
    expect(extractOscTitle('\u001b]0;first\u0007\u001b]0;  second  line \u0007')).toBe(
      'second line',
    );
  });

  it('returns null for no title, an empty title, or an unterminated one', () => {
    expect(extractOscTitle('plain output, no escapes')).toBeNull();
    expect(extractOscTitle('\u001b]0;\u0007')).toBeNull();
    expect(extractOscTitle('\u001b]0;⠋ \u0007')).toBeNull(); // spinner only
    expect(extractOscTitle('\u001b]0;partial no terminator')).toBeNull();
  });
});

describe('StatusDetector', () => {
  it('reports running on output, waiting_input after a quiet match', async () => {
    vi.useFakeTimers();
    const statuses: string[] = [];
    const d = new StatusDetector(
      { waitingInput: [/│\s?>/], busy: [/esc to interrupt/i] },
      { onStatus: (s) => statuses.push(s) },
      2000,
    );
    d.feed('\u001b[1mworking… esc to interrupt\u001b[0m');
    expect(statuses).toEqual(['running']);
    vi.advanceTimersByTime(3000);
    expect(statuses).toEqual(['running']); // busy pattern suppressed waiting
    d.feed('\u001b[2J│ > ');
    vi.advanceTimersByTime(1500);
    expect(statuses).toEqual(['running']); // not quiet long enough yet
    vi.advanceTimersByTime(600);
    expect(statuses).toEqual(['running', 'waiting_input']);
    d.feed('tool output');
    expect(statuses).toEqual(['running', 'waiting_input', 'running']);
    d.dispose();
    vi.useRealTimers();
  });

  it('fires limitReached once', () => {
    const limits: number[] = [];
    const d = new StatusDetector(
      { waitingInput: [/never/], limitReached: [/usage limit reached/i] },
      { onStatus: () => undefined, onLimitReached: () => limits.push(1) },
    );
    d.feed('Usage limit reached — try later');
    d.feed('usage limit reached again');
    expect(limits).toHaveLength(1);
    d.dispose();
  });
});

describe('PtyManager', () => {
  function manager() {
    const logsDir = mkdtempSync(join(tmpdir(), 'puddle-logs-'));
    const logs = new LogStore(logsDir, 64 * 1024);
    return { logsDir, logs, ptys: new PtyManager(logs) };
  }

  it('spawns, streams, tees to the log, echoes stdin, and reports exit', async () => {
    const { logsDir, ptys } = manager();
    const chunks: string[] = [];
    let exitCode: number | null = null;
    ptys.on('data', (e: { data: string }) => chunks.push(e.data));
    ptys.on('exit', (e: { exitCode: number }) => (exitCode = e.exitCode));
    ptys.spawn('s1', 'agent', 'bash', ['-c', 'echo hello-from-pty && cat'], { cwd: tmpdir() });
    await waitFor(() => chunks.join('').includes('hello-from-pty'));
    ptys.write('s1', 'agent', 'ping\n');
    await waitFor(() => chunks.join('').includes('ping'));
    expect(ptys.has('s1', 'agent')).toBe(true);
    expect(ptys.liveTerms('s1')).toEqual(['agent']);
    ptys.kill('s1', 'agent');
    await waitFor(() => exitCode !== null);
    expect(ptys.has('s1', 'agent')).toBe(false);
    const log = readFileSync(join(logsDir, 's1', 'agent.log'), 'utf8');
    expect(log).toContain('hello-from-pty');
  });

  it('pidsFor returns the OS pids of every live term on a stream, scoped to that stream', async () => {
    const { ptys } = manager();
    ptys.spawn('s3', 'agent', 'bash', ['-c', 'echo agent-ready && cat'], { cwd: tmpdir() });
    ptys.spawn('s3', 'shell-1', 'bash', ['-c', 'echo shell-ready && cat'], { cwd: tmpdir() });
    ptys.spawn('other-stream', 'agent', 'bash', ['-c', 'echo other-ready && cat'], {
      cwd: tmpdir(),
    });
    await waitFor(() => ptys.liveTerms('s3').length === 2 && ptys.has('other-stream', 'agent'));

    const pids = ptys.pidsFor('s3');
    expect(pids).toHaveLength(2);
    expect(pids.every((p) => typeof p === 'number' && p > 0)).toBe(true);

    // Scoped: an unrelated stream's pid must not leak in, and a stream with
    // no live PTYs returns [] rather than throwing.
    const otherPids = ptys.pidsFor('other-stream');
    expect(otherPids).toHaveLength(1);
    expect(pids).not.toContain(otherPids[0]);
    expect(ptys.pidsFor('no-such-stream')).toEqual([]);

    ptys.killAll();
  });

  it('injects daemon notes into log and stream', async () => {
    const { logs, ptys } = manager();
    const chunks: string[] = [];
    ptys.on('data', (e: { data: string }) => chunks.push(e.data));
    ptys.note('s2', 'agent', 'skip-permissions not permitted; continuing with prompts on');
    expect(chunks.join('')).toContain('[puddle] skip-permissions not permitted');
    expect(logs.readTail('s2', 'agent')).toContain('[puddle]');
  });
});

describe('LogStore', () => {
  it('appends, tails and lists terms', () => {
    const logs = new LogStore(mkdtempSync(join(tmpdir(), 'puddle-logs-')), 16);
    logs.append('sid', 'agent', 'aaaaaaaaaaaaaaaaaaaaaaaaa');
    logs.append('sid', 'shell-1', 'bbb');
    logs.closeAll();
    expect(logs.readTail('sid', 'agent')).toBe('aaaaaaaaaaaaaaaa'); // capped at 16 bytes
    expect(logs.readTail('sid', 'missing')).toBe('');
    expect(logs.listTerms('sid').sort()).toEqual(['agent', 'shell-1']);
  });
});

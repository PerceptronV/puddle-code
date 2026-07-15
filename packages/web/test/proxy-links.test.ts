import { describe, expect, it } from 'vitest';
import { rewriteTerminalUri } from '../src/features/terminal/proxy-links';
import { nextStoredHost } from '../src/lib/editor-links';

const SID = 'abc123';
const TOKEN = 'f'.repeat(64);

describe('rewriteTerminalUri (SPEC §7 — SSH mode localhost rewrite)', () => {
  it('rewrites host-localhost URLs to the tier-2 proxy path with the one-shot token', () => {
    expect(rewriteTerminalUri('http://localhost:5173/', SID, true, TOKEN)).toBe(
      `/proxy/${SID}/5173/?puddle_token=${TOKEN}`,
    );
    expect(rewriteTerminalUri('http://127.0.0.1:3000/app?x=1#frag', SID, true, TOKEN)).toBe(
      `/proxy/${SID}/3000/app?x=1&puddle_token=${TOKEN}#frag`,
    );
  });

  it('defaults the port from the scheme when absent', () => {
    expect(rewriteTerminalUri('http://localhost/', SID, true, null)).toBe(`/proxy/${SID}/80/`);
  });

  it('leaves everything alone in local mode', () => {
    expect(rewriteTerminalUri('http://localhost:5173/', SID, false, TOKEN)).toBe(
      'http://localhost:5173/',
    );
  });

  it('leaves non-local and non-http URLs alone even in SSH mode', () => {
    expect(rewriteTerminalUri('https://example.com/x', SID, true, TOKEN)).toBe(
      'https://example.com/x',
    );
    expect(rewriteTerminalUri('vscode://file/x', SID, true, TOKEN)).toBe('vscode://file/x');
    expect(rewriteTerminalUri('not a url', SID, true, TOKEN)).toBe('not a url');
  });
});

describe('nextStoredHost (mode switching on the same origin)', () => {
  it('captures the ?host= a connect boot sends', () => {
    expect(nextStoredHost('?host=alice%40devbox', '#token=abc', null)).toBe('alice@devbox');
  });

  it('clears a stale host on a local CLI boot (#token= but no ?host=)', () => {
    expect(nextStoredHost('', '#token=abc', 'alice@devbox')).toBe(null);
  });

  it('keeps the stored host across plain reloads (no token fragment)', () => {
    expect(nextStoredHost('', '', 'alice@devbox')).toBe('alice@devbox');
    expect(nextStoredHost('', '#other=1', 'alice@devbox')).toBe('alice@devbox');
  });
});

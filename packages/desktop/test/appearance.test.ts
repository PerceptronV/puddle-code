import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isShellTheme, loadShellTheme, saveShellTheme } from '../src/appearance.js';
// @ts-expect-error shared JavaScript build helper
import { renderPrompt } from '../scripts/prompt-assets.mjs';

const homes: string[] = [];
afterEach(() => homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true })));
describe('standalone prompt appearance', () => {
  it('retains only a valid theme and falls back to the system when unavailable', () => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-appearance-'));
    homes.push(home);
    const file = join(home, 'appearance.json');
    expect(loadShellTheme(file)).toBe('system');
    saveShellTheme(file, 'dark');
    expect(loadShellTheme(file)).toBe('dark');
    writeFileSync(file, '{broken');
    expect(loadShellTheme(file)).toBe('system');
    writeFileSync(file, '{"theme":"light"}');
    expect(loadShellTheme(file)).toBe('system');
    expect(isShellTheme({ theme: 'dark' })).toBe(false);
    expect(isShellTheme('system')).toBe(true);
  });
  it.each(['connect-prompt', 'host-picker', 'ssh-auth-prompt'])(
    'packages %s without external dependencies or a broader CSP',
    (name) => {
      const html = renderPrompt(name);
      expect(html).not.toContain('shared-prompt-appearance');
      expect(html).toContain("[data-theme='light']");
      expect(html).toContain('--nav-selection:');
      expect(html).toContain('prefers-reduced-motion');
      expect(html).toContain(
        "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'",
      );
      expect(html).not.toMatch(/<(?:link|script)[^>]+(?:href|src)=/);
    },
  );
});

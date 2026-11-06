import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { execPath } from 'node:process';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { installStatusLine, readLiveUsage } from '../../src/agents/claude-code/statusline.js';
import { claudeRuntimeAssets } from '../../src/agents/claude-code/runtime-assets.js';
import { pinRuntimeAssets } from '../../src/runtime/execution/assets.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'puddle-sl-'));
  homes.push(dir);
  installStatusLine(dir);
  return {
    dir,
    run: (input: string) =>
      execFileSync(execPath, [join(dir, 'puddle-statusline.mjs')], {
        input,
        encoding: 'utf8',
        env: { HOME: dir },
      }),
  };
}

describe('claude-code status line capture', () => {
  it('migrates only the owned legacy command and keeps pinned usage in the managed account', () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-sl-'));
    homes.push(dir);
    const owner = join(dir, 'owner');
    mkdirSync(owner, { mode: 0o700 });
    const env = pinRuntimeAssets(owner, claudeRuntimeAssets());
    const legacy = `${JSON.stringify(execPath)} ${JSON.stringify(join(dir, 'puddle-statusline.mjs'))}`;
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: legacy, padding: 2 } }),
    );
    installStatusLine(dir);
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as {
      statusLine: { command: string; padding: number };
    };
    expect(settings.statusLine.command).toContain('puddle-claude-hooks-v2.sh');
    expect(settings.statusLine.padding).toBe(2);
    writeFileSync(
      join(dir, 'puddle-statusline.mjs'),
      'throw new Error("account helper replaced");',
    );
    const line = execFileSync('/bin/sh', ['-c', settings.statusLine.command], {
      env: { ...env, CLAUDE_CONFIG_DIR: dir },
      input: JSON.stringify({ context_window: { used_percentage: 12 } }),
      encoding: 'utf8',
    });
    expect(line).toContain('12%');
    expect(readLiveUsage(dir)?.context_used_percentage).toBe(12);
    expect(existsSync(join(owner, 'helpers/puddle-status.json'))).toBe(false);
    for (const custom of [
      `${legacy} --custom`,
      `"/bin/echo" ${JSON.stringify(join(dir, 'puddle-statusline.mjs'))}`,
    ]) {
      writeFileSync(
        join(dir, 'settings.json'),
        JSON.stringify({ statusLine: { type: 'command', command: custom } }),
      );
      installStatusLine(dir);
      expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).statusLine.command).toBe(
        custom,
      );
    }
  });
  it('installs a statusLine command without clobbering an existing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-sl-'));
    homes.push(dir);
    installStatusLine(dir);
    const settings = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as {
      statusLine?: { command: string };
    };
    expect(settings.statusLine?.command).toContain('puddle-statusline.mjs');

    // A user-defined status line is respected on re-install.
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'mine' } }),
    );
    installStatusLine(dir);
    const after = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as {
      statusLine?: { command: string };
    };
    expect(after.statusLine?.command).toBe('mine');
  });

  it('the helper records the fields puddle surfaces and prints a status line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-sl-'));
    homes.push(dir);
    installStatusLine(dir);
    expect(readLiveUsage(dir)).toBeNull(); // nothing captured yet

    // Feed the helper a real-shaped payload exactly as Claude Code would.
    const payload = JSON.stringify({
      context_window: { used_percentage: 42.7 },
      cost: { total_cost_usd: 0 },
      model: { display_name: 'Fable 5' },
    });
    const line = execFileSync(execPath, [join(dir, 'puddle-statusline.mjs')], {
      env: { HOME: dir },
      input: payload,
      encoding: 'utf8',
    });
    expect(line).toContain('Fable 5');
    expect(line).toContain('43%'); // rounded

    const usage = readLiveUsage(dir);
    expect(usage?.context_used_percentage).toBe(42.7);
    expect(usage?.model).toBe('Fable 5');
    expect(typeof usage?.captured_at).toBe('string');
  });

  it('tolerates a malformed payload without writing junk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'puddle-sl-'));
    homes.push(dir);
    installStatusLine(dir);
    const line = execFileSync(execPath, [join(dir, 'puddle-statusline.mjs')], {
      env: { HOME: dir },
      input: 'not json',
      encoding: 'utf8',
    });
    expect(line).toBe('');
    expect(existsSync(join(dir, 'puddle-status.json'))).toBe(false);
  });

  it('drains excessive input without retaining it or replacing the last useful status', () => {
    const f = fixture();
    f.run(JSON.stringify({ context_window: { used_percentage: 15 } }));
    const before = readFileSync(join(f.dir, 'puddle-status.json'), 'utf8');
    expect(f.run(JSON.stringify({ unused: 'x'.repeat(1024 * 1024) }))).toBe('');
    expect(readFileSync(join(f.dir, 'puddle-status.json'), 'utf8')).toBe(before);
    // The bound measures encoded bytes, including multibyte input.
    expect(f.run(JSON.stringify({ unused: '漢'.repeat(24 * 1024) }))).toBe('');
    expect(readFileSync(join(f.dir, 'puddle-status.json'), 'utf8')).toBe(before);
  });

  it.each([
    {
      context_window: { used_percentage: -1 },
      cost: { total_cost_usd: { large: 'x'.repeat(8000) } },
      model: { display_name: ['invalid'] },
    },
    {
      context_window: { used_percentage: 101 },
      cost: { total_cost_usd: -1 },
      model: { display_name: 'x'.repeat(257) },
    },
  ])('records only bounded typed fields from an unexpected payload', (payload) => {
    const f = fixture();
    expect(f.run(JSON.stringify(payload))).toBe('');
    expect(readLiveUsage(f.dir)).toMatchObject({
      context_used_percentage: null,
      total_cost_usd: null,
      model: null,
    });
    expect(readFileSync(join(f.dir, 'puddle-status.json')).length).toBeLessThan(4096);
  });

  it('keeps Unicode model text but removes terminal control characters', () => {
    const f = fixture();
    expect(f.run(JSON.stringify({ model: { display_name: '模型\u001b\n\u0007' } }))).toBe('模型');
    expect(readLiveUsage(f.dir)?.model).toBe('模型');
  });

  it('refuses oversized or malformed stored metadata without returning unchecked fields', () => {
    const f = fixture();
    const file = join(f.dir, 'puddle-status.json');
    writeFileSync(
      file,
      JSON.stringify({ captured_at: new Date().toISOString(), model: 'x'.repeat(64 * 1024) }),
    );
    expect(readLiveUsage(f.dir)).toBeNull();
    writeFileSync(
      file,
      JSON.stringify({
        captured_at: new Date().toISOString(),
        context_used_percentage: {},
        model: null,
        total_cost_usd: null,
      }),
    );
    expect(readLiveUsage(f.dir)).toBeNull();
    rmSync(file);
    const other = join(f.dir, 'other.json');
    writeFileSync(other, '{}');
    symlinkSync(other, file);
    expect(readLiveUsage(f.dir)).toBeNull();
  });
});

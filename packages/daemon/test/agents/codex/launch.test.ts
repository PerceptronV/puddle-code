import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LifecycleLaunchContext } from '../../../src/agents/adapter.js';
import { prepareCodexLaunch } from '../../../src/agents/codex/launch.js';

const homes: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture(version: string, args: string[]): LifecycleLaunchContext {
  const home = mkdtempSync(join(tmpdir(), 'puddle-codex-fallback-'));
  homes.push(home);
  writeFileSync(
    join(home, 'codex'),
    `#!/bin/sh
case "$1" in
  --version) printf 'codex-cli ${version}\\n';;
  app-server) printf '%s' "$$" > sidecar.pid; printf 'fixture startup failure\\n' >&2; exit 42;;
  *) exit 99;;
esac
`,
    { mode: 0o700 },
  );
  return {
    account: { config_dir: home },
    opts: { sessionId: 'fixture', worktreePath: home, skipPermissions: false },
    args,
    env: { PATH: home },
    signalUrl: 'http://127.0.0.1:1',
    signalNonce: 'fixture',
    reportLifecycleUnavailable: vi.fn(),
    writeInput: vi.fn(),
  };
}

describe('Codex interactive fallback lifetime', () => {
  it.each([{ args: [] }, { args: ['resume', 'native-ref', 'continue --remote work'] }])(
    'reaps the failed sidecar and keeps fallback arguments out of the shared daemon: $args',
    async ({ args }) => {
      const context = fixture('0.164.0', args);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const resource = await prepareCodexLaunch(context);
      try {
        expect(resource.args).toEqual(['--no-daemon', ...args]);
        expect(context.args).toEqual(args);
        expect(context.reportLifecycleUnavailable).toHaveBeenCalledOnce();
        expect(resource.control).toBeUndefined();
        expect(resource.sidecarPids).toBeUndefined();
        const pid = Number(readFileSync(join(context.opts.worktreePath, 'sidecar.pid'), 'utf8'));
        expect(() => process.kill(pid, 0)).toThrow();
      } finally {
        await resource.dispose();
      }
    },
  );

  it('leaves older CLIs on the existing fallback path without unsupported flags', async () => {
    const context = fixture('0.159.0', ['resume', 'native-ref']);
    await expect(prepareCodexLaunch(context)).rejects.toThrow('fixture startup failure');
    expect(context.reportLifecycleUnavailable).not.toHaveBeenCalled();
    expect(context.args).toEqual(['resume', 'native-ref']);
  });
});

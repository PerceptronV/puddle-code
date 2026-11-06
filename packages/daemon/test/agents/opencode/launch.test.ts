import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LifecycleLaunchContext } from '../../../src/agents/adapter.js';
import { AgentLaunchError } from '../../../src/agents/launch-error.js';
import { prepareOpenCodeInteractive } from '../../../src/agents/opencode/control.js';
import { prepareOpenCodeHeadless } from '../../../src/agents/opencode/headless.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture(version: string): LifecycleLaunchContext {
  const home = mkdtempSync(join(tmpdir(), 'puddle-opencode-lifetime-'));
  homes.push(home);
  writeFileSync(
    join(home, 'opencode'),
    `#!/bin/sh
if [ "$1" = '--version' ]; then printf '${version}\\n'; exit 0; fi
if [ "$1" != 'run' ]; then exit 98; fi
if [ '${version}' = '2.0.0' ]; then
  if [ "$2" != '--standalone' ]; then exit 97; fi
else
  if [ "$2" = '--standalone' ]; then exit 96; fi
fi
/bin/cat > /dev/null
printf '%s\\n' '{"type":"text","sessionID":"ses_fixture","part":{"text":"answer"}}' '{"type":"step_finish","sessionID":"ses_fixture","part":{"reason":"stop"}}'
`,
    { mode: 0o700 },
  );
  return {
    account: { config_dir: home },
    opts: { sessionId: 'fixture', worktreePath: home, skipPermissions: false },
    args: ['--session', 'ses_fixture', '--prompt', 'continue --server work'],
    env: { PATH: home },
    signalUrl: 'http://127.0.0.1:1',
    signalNonce: 'fixture',
    reportLifecycleUnavailable: vi.fn(),
    bindConversation: vi.fn(),
    writeInput: vi.fn(),
  };
}

describe('OpenCode server lifetime', () => {
  it.each(['1.18.10', '2.0.0'])('keeps %s interactive launches private', async (version) => {
    const context = fixture(version);
    const resource = await prepareOpenCodeInteractive(context);
    try {
      expect(resource.args).toEqual([
        ...(version === '2.0.0' ? ['--standalone'] : []),
        ...context.args,
      ]);
      if (version === '2.0.0') {
        expect(context.reportLifecycleUnavailable).toHaveBeenCalledOnce();
        expect(resource.control).toBeUndefined();
      } else expect(context.reportLifecycleUnavailable).not.toHaveBeenCalled();
    } finally {
      await resource.dispose();
    }
  });

  it('preserves standalone mode when interactive control cannot be prepared', async () => {
    const context = fixture('2.0.0');
    delete context.writeInput;
    const resource = await prepareOpenCodeInteractive(context);
    expect(resource.args).toEqual(['--standalone', ...context.args]);
    expect(resource).not.toHaveProperty('control');
    expect(context.reportLifecycleUnavailable).toHaveBeenCalledOnce();
    await resource.dispose();
  });

  it.each(['1.18.10', '2.0.0'])(
    'uses the correct private-server mode for %s headless turns',
    async (version) => {
      const context = fixture(version);
      const resource = await prepareOpenCodeHeadless(context);
      const child = spawn(resource.binary!, resource.args, {
        cwd: context.opts.worktreePath,
        env: { ...process.env, ...context.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const closed = once(child, 'close');
      try {
        await vi.waitFor(() => expect(resource.control!.ready).toBe(true));
        await expect(resource.control!.ask('hello', new AbortController().signal)).resolves.toBe(
          'answer',
        );
        expect(context.bindConversation).toHaveBeenCalledWith('ses_fixture');
      } finally {
        await resource.dispose();
        await closed;
      }
    },
  );

  it('refuses an unverified version rather than attaching to an unknown server lifetime', async () => {
    const context = fixture('unknown');
    await expect(prepareOpenCodeInteractive(context)).rejects.toBeInstanceOf(AgentLaunchError);
    await expect(prepareOpenCodeHeadless(context)).rejects.toBeInstanceOf(AgentLaunchError);
  });
});

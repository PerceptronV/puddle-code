import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeLaunch } from '@puddle/shared';
import { claudeCode } from '../../../src/agents/claude-code/index.js';
import { geminiCli } from '../../../src/agents/gemini-cli/index.js';
import { opencode } from '../../../src/agents/opencode/index.js';
import { RuntimeAgent } from '../../../src/runtime/execution/agent.js';
import { runtimeDirectory } from '../../../src/runtime/ownership/storage.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('supervised provider status', () => {
  for (const [adapter, version] of [
    [claudeCode, '2.1.300'],
    [geminiCli, '0.53.1'],
    [opencode, '1.18.10'],
  ] as const) {
    it(`${adapter.id} keeps native turn status with the CLI only on the launch PATH`, async () => {
      const home = mkdtempSync(join(tmpdir(), 'puddle-provider-status-'));
      cleanups.push(() => rmSync(home, { recursive: true, force: true }));
      const bin = join(home, 'bin');
      const config = join(home, 'account');
      mkdirSync(bin, { mode: 0o700 });
      mkdirSync(config, { mode: 0o700 });
      writeFileSync(join(bin, adapter.binary), `#!/bin/sh\nprintf '${version}\\n'\n`, {
        mode: 0o700,
      });
      await adapter.prepareConfigDir?.(config);
      // A service manager's PATH does not include the user's agent installation.
      vi.stubEnv('PATH', '/usr/bin:/bin');
      const launch: RuntimeLaunch = {
        format: 1,
        identity: {
          runtime_id: randomUUID(),
          incarnation: randomUUID(),
          launch_id: randomUUID(),
          profile_id: '1111111111',
          project_id: '2222222222',
          session_id: randomUUID(),
          canonical_worktree_path: home,
        },
        secret: 'a'.repeat(64),
        main: { file: adapter.binary, args: [], cwd: home, env: { PATH: bin }, cols: 80, rows: 24 },
        provider: {
          id: adapter.id,
          config_dir: config,
          mode: 'interactive',
          skip_permissions: false,
        },
      };
      mkdirSync(runtimeDirectory(home, launch.identity.runtime_id), {
        recursive: true,
        mode: 0o700,
      });
      const agent = new RuntimeAgent(home, launch, adapter, {
        writeInput() {},
        lifecycle() {},
        state() {},
        collision() {
          throw new Error('Unexpected collision');
        },
      });
      cleanups.push(() => agent.close());
      const command = await agent.prepare();
      expect(agent.state().native_sync).toBe('full');
      expect(command.env.PATH).toBe(bin);
      const send = async (body: Record<string, unknown>) => {
        const response = await fetch(command.env.PUDDLE_AGENT_SIGNAL_URL!, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ nonce: command.env.PUDDLE_AGENT_SIGNAL_NONCE, ...body }),
        });
        await response.arrayBuffer();
        expect(response.status).toBe(204);
      };
      const ref = randomUUID();
      await send({ event: 'session_start', agent_session_ref: ref, cwd: home, source: 'startup' });
      const turn = { agent_session_ref: ref, turn_id: randomUUID() };
      await send({ ...turn, event: 'turn_start', prompt_hash: 'b'.repeat(64) });
      expect(agent.state().status).toBe('running');
      await send({ ...turn, event: 'turn_complete', reply: 'Done' });
      expect(agent.state().status).toBe('waiting_input');
      agent.output('late terminal redraw');
      expect(agent.state().status).toBe('waiting_input');
      const next = { agent_session_ref: ref, turn_id: randomUUID() };
      await send({ ...next, event: 'turn_start', prompt_hash: 'c'.repeat(64) });
      expect(agent.state().status).toBe('running');
      await send({ ...next, event: 'turn_failed', error: 'Cancelled' });
      expect(agent.state().status).toBe('waiting_input');
    });
  }
});

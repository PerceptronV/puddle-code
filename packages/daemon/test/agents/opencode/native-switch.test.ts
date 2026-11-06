import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import * as pty from 'node-pty';
import { expect, it, vi } from 'vitest';
import type { RuntimeLaunch, RuntimeLifecycle } from '@puddle/shared';
import { opencode } from '../../../src/agents/opencode/index.js';
import { RuntimeAgent } from '../../../src/runtime/execution/agent.js';
import { runtimeDirectory } from '../../../src/runtime/ownership/storage.js';

/** Opt-in OpenCode 2.2.5+: real TUI/owners, isolated account, loopback synthetic inference. */
it.skipIf(!process.env['PUDDLE_NATIVE_OPENCODE_BINARY'])(
  'keeps new, forked and resumed conversations independently usable',
  async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'puddle-native-opencode-')));
    const config = join(home, 'account'),
      work = join(home, 'work'),
      bin = join(home, 'bin');
    for (const dir of [config, work, bin]) mkdirSync(dir);
    symlinkSync(process.env['PUDDLE_NATIVE_OPENCODE_BINARY']!, join(bin, 'opencode'));
    opencode.prepareConfigDir!(config);
    const model = createServer(async (request, response) => {
      request.resume();
      await once(request, 'end');
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [delta, finish] of [
        [{ role: 'assistant', content: 'Synthetic final answer' }, null],
        [{}, 'stop'],
      ]) {
        response.write(
          `data: ${JSON.stringify({
            id: randomUUID(),
            object: 'chat.completion.chunk',
            created: 1,
            model: 'fixture',
            choices: [{ index: 0, delta, finish_reason: finish }],
          })}\n\n`,
        );
      }
      response.end('data: [DONE]\n\n');
    });
    model.listen(0, '127.0.0.1');
    await once(model, 'listening');
    const address = model.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture address');
    writeFileSync(
      join(config, 'config/opencode/opencode.json'),
      JSON.stringify({
        model: 'fixture/fixture',
        snapshots: false,
        update: 'disable',
        providers: {
          fixture: {
            name: 'Fixture',
            env: ['PUDDLE_FIXTURE_API_KEY'],
            package: '@opencode/ai/providers/openai-compatible',
            settings: { baseURL: `http://127.0.0.1:${address.port}/v1` },
            models: { fixture: { name: 'Fixture', limit: { context: 32000, output: 1024 } } },
          },
        },
      }),
    );
    const owners: Array<{
      agent: RuntimeAgent;
      terminal: pty.IPty;
      ended: Promise<void>;
      exited: () => boolean;
    }> = [];
    async function start(ref?: string) {
      const id = randomUUID();
      mkdirSync(runtimeDirectory(home, id), { recursive: true });
      const env = {
        HOME: home,
        PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        TERM: 'xterm-256color',
        LANG: 'en_US.UTF-8',
        HTTP_PROXY: 'http://127.0.0.1:9',
        HTTPS_PROXY: 'http://127.0.0.1:9',
        NO_PROXY: '127.0.0.1',
        PUDDLE_FIXTURE_API_KEY: 'synthetic',
        OPENCODE_DISABLE_MODELS_FETCH: 'true',
      };
      const launch: RuntimeLaunch = {
        format: 1,
        identity: {
          runtime_id: id,
          incarnation: randomUUID(),
          launch_id: randomUUID(),
          profile_id: '1111111111',
          project_id: '2222222222',
          session_id: randomUUID(),
          canonical_worktree_path: work,
        },
        secret: 'a'.repeat(64),
        main: { file: 'opencode', args: [], cwd: work, env, cols: 100, rows: 32 },
        provider: {
          id: 'opencode',
          config_dir: config,
          mode: 'interactive',
          skip_permissions: false,
          ...(ref ? { resume_ref: ref } : {}),
        },
      };
      let terminal: pty.IPty;
      const events: RuntimeLifecycle[] = [];
      const collision = vi.fn();
      const agent = new RuntimeAgent(home, launch, opencode, {
        writeInput: (data) => terminal.write(data),
        lifecycle: (event) => events.push(event),
        state() {},
        collision,
      });
      try {
        const command = await agent.prepare();
        terminal = pty.spawn(command.file, command.args, {
          cwd: work,
          env: command.env,
          cols: 100,
          rows: 32,
          name: 'xterm-256color',
        });
      } catch (error) {
        await agent.close();
        throw error;
      }
      let exited = false;
      const ended = new Promise<void>((resolve) =>
        terminal.onExit(() => {
          exited = true;
          resolve();
        }),
      );
      owners.push({ agent, terminal, ended, exited: () => exited });
      terminal.onData((data) => {
        agent.output(data);
        if (data.includes('\x1b[6n')) terminal.write('\x1b[1;1R');
        for (const code of [10, 11])
          if (data.includes(`\x1b]${code};?`))
            terminal.write(`\x1b]${code};rgb:0000/0000/0000\x07`);
      });
      await vi.waitFor(() => expect(events.some((e) => e.event === 'session_start')).toBe(true), {
        timeout: 10_000,
      });
      expect(agent.state().native_sync).toBe('full');
      expect(collision).not.toHaveBeenCalled();
      return { agent, terminal, events, collision };
    }
    try {
      const a = await start();
      const original = a.agent.state().agent_session_ref!;
      const command = async (text: string) => {
        a.agent.humanInput();
        a.terminal.write(text);
        await sleep(200);
        a.terminal.write('\r');
      };
      await command('/new');
      await vi.waitFor(() => expect(a.agent.state().agent_session_ref).not.toBe(original), {
        timeout: 5000,
      });
      const fresh = a.agent.state().agent_session_ref!;
      expect(a.events.some((e) => e.source === 'clear' && e.agent_session_ref === fresh)).toBe(
        true,
      );
      const b = await start(original);
      for (const owner of [a, b]) {
        await expect(
          owner.agent.control()!.ask('Synthetic question', AbortSignal.timeout(15_000)),
        ).resolves.toBe('Synthetic final answer');
      }
      await command('/fork');
      // Native /fork opens the message picker; Enter chooses the saved boundary.
      await sleep(300);
      a.terminal.write('\r');
      await vi.waitFor(() => expect(a.events.some((e) => e.source === 'fork')).toBe(true), {
        timeout: 5000,
      });
      const fork = a.agent.state().agent_session_ref!;
      expect(a.events.find((e) => e.source === 'fork')?.parent_agent_session_ref).toBe(fresh);
      const c = await start(fresh);
      for (const owner of [a, b, c]) {
        await expect(
          owner.agent.control()!.ask('Another synthetic question', AbortSignal.timeout(15_000)),
        ).resolves.toBe('Synthetic final answer');
        expect(owner.collision).not.toHaveBeenCalled();
      }
      const catalogue = await opencode.conversationDiscovery!.discover({
        config_dir: config,
      } as never);
      expect(catalogue.find((row) => row.ref === fork)?.parentRef).toBe(fresh);
      expect(catalogue.map((row) => row.ref)).toEqual(
        expect.arrayContaining([original, fresh, fork]),
      );
    } finally {
      for (const owner of owners.reverse()) {
        if (!owner.exited()) owner.terminal.kill('SIGTERM');
        await Promise.race([owner.ended, sleep(2000)]);
        if (!owner.exited()) {
          owner.terminal.kill('SIGKILL');
          await owner.ended;
        }
        await owner.agent.close();
      }
      model.closeAllConnections();
      await new Promise<void>((resolve) => model.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  },
  60_000,
);

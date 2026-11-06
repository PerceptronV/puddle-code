import { claudeModel } from '../../helpers/claude-model.js';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import * as pty from 'node-pty';
import { expect, it } from 'vitest';
import { claudeCode } from '../../../src/agents/claude-code/index.js';
import { claudeJobs } from '../../../src/agents/claude-code/jobs/store.js';
import { RuntimeAgent } from '../../../src/runtime/execution/agent.js';
import { runtimeDirectory } from '../../../src/runtime/ownership/storage.js';
import type { RuntimeLaunch } from '@puddle/shared';

const binary = process.env['PUDDLE_NATIVE_CLAUDE_BINARY'];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, description: string) {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(description);
    await sleep(30);
  }
}

it.skipIf(!binary)(
  'attaches an existing native fork, routes its clear hook, and stops only its worker',
  async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'puddle-native-claude-')));
    const config = join(home, 'config'),
      bin = join(home, 'bin');
    mkdirSync(config, { mode: 0o700 });
    mkdirSync(bin);
    symlinkSync(binary!, join(bin, 'claude'));
    const model = await claudeModel();
    const env = {
      HOME: home,
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      LANG: 'en_US.UTF-8',
      TERM: 'xterm-256color',
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      ANTHROPIC_API_KEY: 'puddle-fixture-key',
      ANTHROPIC_BASE_URL: model.url,
      NO_PROXY: '127.0.0.1,localhost',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      DISABLE_AUTOUPDATER: '1',
    };
    const owners: Array<{
      agent: RuntimeAgent;
      term: pty.IPty;
      text(): string;
      exited(): boolean;
    }> = [];
    const start = async (ref: string, prompt?: string) => {
      const id = randomUUID();
      mkdirSync(runtimeDirectory(home, id), { recursive: true, mode: 0o700 });
      const launch: RuntimeLaunch = {
        format: 1,
        identity: {
          runtime_id: id,
          incarnation: randomUUID(),
          launch_id: randomUUID(),
          profile_id: '1111111111',
          project_id: '2222222222',
          session_id: randomUUID(),
          canonical_worktree_path: home,
        },
        secret: 'a'.repeat(64),
        main: { file: 'claude', args: [], cwd: home, env, cols: 100, rows: 32 },
        provider: {
          id: 'claude-code',
          config_dir: config,
          mode: 'interactive',
          skip_permissions: false,
          resume_ref: ref,
          ...(prompt ? { prompt } : {}),
        },
      };
      let term: pty.IPty | undefined,
        output = '',
        exited = false;
      const agent = new RuntimeAgent(home, launch, claudeCode, {
        writeInput: (data) => term?.write(data),
        lifecycle() {},
        state() {},
        collision() {
          throw new Error('Unexpected conversation collision');
        },
      });
      try {
        const command = await agent.prepare();
        term = pty.spawn(command.file, command.args, {
          cwd: home,
          env: command.env,
          cols: 100,
          rows: 32,
          name: 'xterm-256color',
        });
        term.onExit(() => {
          exited = true;
        });
        term.onData((data) => {
          output = (output + data).slice(-128 * 1024);
          if (data.includes('\x1b[6n')) term!.write('\x1b[1;1R');
        });
        const owner = {
          agent,
          term,
          text: () => stripVTControlCharacters(output),
          exited: () => exited,
        };
        owners.push(owner);
        return owner;
      } catch (error) {
        await agent.close('detach');
        throw error;
      }
    };
    try {
      await claudeCode.prepareConfigDir?.(config);
      const settings = join(config, '.claude.json');
      writeFileSync(
        settings,
        JSON.stringify({
          ...JSON.parse(readFileSync(settings, 'utf8')),
          theme: 'dark',
          projects: { [home]: { hasTrustDialogAccepted: true } },
          customApiKeyResponses: { approved: ['puddle-fixture-key'] },
        }),
      );
      const ref = randomUUID(),
        user = randomUUID(),
        now = new Date().toISOString();
      const transcripts = join(config, 'projects', home.replace(/[^a-zA-Z0-9]/g, '-'));
      mkdirSync(transcripts, { recursive: true });
      writeFileSync(
        join(transcripts, `${ref}.jsonl`),
        [
          {
            type: 'user',
            uuid: user,
            parentUuid: null,
            isSidechain: false,
            sessionId: ref,
            cwd: home,
            version: '2.1.318',
            timestamp: now,
            message: { role: 'user', content: 'Synthetic saved message.' },
          },
          {
            type: 'assistant',
            uuid: randomUUID(),
            parentUuid: user,
            isSidechain: false,
            sessionId: ref,
            cwd: home,
            version: '2.1.318',
            timestamp: now,
            message: {
              id: 'fixture-message',
              type: 'message',
              role: 'assistant',
              model: 'claude-opus-4-1',
              content: [{ type: 'text', text: 'Synthetic saved answer.' }],
              stop_reason: 'end_turn',
              stop_sequence: null,
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          },
        ]
          .map((value) => JSON.stringify(value))
          .join('\n') + '\n',
      );
      const source = await start(ref);
      await until(
        () => source.agent.control()?.ready === true,
        'Original native conversation did not become ready',
      );
      await until(
        () => source.text().replace(/\s/g, '').includes('Syntheticsavedanswer.'),
        'Native transcript did not render',
      );
      await sleep(1000);
      for (const ch of '/fork') {
        source.term.write(ch);
        await sleep(60);
      }
      await sleep(250);
      source.term.write('\r');
      await until(
        async () => (await claudeJobs(config)).some((job) => job.parentRef === ref),
        'Native fork was not recorded',
      );
      const job = (await claudeJobs(config)).find((job) => job.parentRef === ref)!;
      await sleep(500);
      const copy = await start(job.ref);
      await until(
        () => copy.agent.state().status === 'waiting_input',
        `Native copy did not attach`,
      );
      expect(source.agent.state().agent_session_ref).toBe(ref);
      expect(copy.agent.state().agent_session_ref).toBe(job.ref);
      const workers = copy.agent.state().sidecar_pids;
      expect(workers.length).toBeGreaterThan(0);
      copy.term.write('copy-draft');
      source.term.write('source-draft');
      await until(
        () => copy.text().includes('copy-draft') && source.text().includes('source-draft'),
        'Independent composers did not accept input',
      );
      expect(source.text()).not.toContain('copy-draft');
      expect(copy.text()).not.toContain('source-draft');
      copy.term.write('\x7f'.repeat('copy-draft'.length));
      source.term.write('\x7f'.repeat('source-draft'.length));
      await sleep(200);
      // A viewer teardown must leave the native worker available to a replacement owner.
      copy.term.kill('SIGTERM');
      await until(copy.exited, 'Viewer did not close');
      await copy.agent.close('detach');
      const recovered = await start(job.ref, 'Synthetic interruption note must not submit');
      await until(
        () => recovered.agent.state().status === 'waiting_input',
        'Replacement viewer did not attach',
      );
      expect(recovered.agent.state().sidecar_pids).toEqual(workers);
      expect(recovered.agent.control()?.ready).toBe(false);
      expect(recovered.text()).not.toContain('Synthetic interruption note');
      recovered.term.resize(120, 40);
      for (const ch of '/clear') {
        recovered.term.write(ch);
        await sleep(60);
      }
      await sleep(250);
      recovered.term.write('\r');
      await until(
        () => recovered.agent.state().agent_session_ref !== job.ref,
        'Copy clear did not route to its own runtime',
      );
      expect(source.agent.state().agent_session_ref).toBe(ref);
      const clearedRef = recovered.agent.state().agent_session_ref!;
      const previous = await start(job.ref);
      await until(
        () => previous.text().replace(/\s/g, '').includes('Syntheticsavedanswer.'),
        'Cleared original could not resume independently',
      );
      expect(previous.agent.state().agent_session_ref).toBe(job.ref);
      expect(previous.agent.state().sidecar_pids).toEqual([]);
      recovered.term.kill('SIGTERM');
      await until(recovered.exited, 'Cleared viewer did not detach');
      await recovered.agent.close('detach');
      const current = await start(clearedRef);
      await until(
        () => current.agent.state().status === 'waiting_input',
        'Cleared conversation did not recover its worker',
      );
      expect(current.agent.state().sidecar_pids).toEqual(workers);
      current.term.write('Synthetic human turn\r');
      await until(
        () => current.agent.control()?.ready === true,
        'Native turn did not establish a clean composer boundary',
      );
      expect(current.text().replace(/\s/g, '')).toContain('SyntheticClaudereply.');
      await expect(
        current.agent.control()!.ask('Synthetic automated turn', AbortSignal.timeout(15000)),
      ).resolves.toBe('Synthetic Claude reply.');
      expect(model.calls()).toBeGreaterThanOrEqual(2);
      expect(source.agent.state().agent_session_ref).toBe(ref);
      await current.agent.close();
      await until(current.exited, 'Stopped copy viewer did not exit');
      expect(source.exited()).toBe(false);
      source.term.write('still-active');
      await until(() => source.text().includes('still-active'), 'Original stopped with its copy');
    } finally {
      for (const owner of owners) {
        if (!owner.exited()) owner.term.kill('SIGTERM');
        await owner.agent.close('detach').catch(() => {});
      }
      // Only this isolated fixture account owns the native daemon being stopped.
      await promisify(execFile)(binary!, ['daemon', 'stop', '--any'], {
        env: { ...env, CLAUDE_CONFIG_DIR: config },
        cwd: home,
        timeout: 15000,
      }).catch(() => {});
      for (const owner of owners) if (!owner.exited()) owner.term.kill('SIGKILL');
      await sleep(500);
      await model.close();
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  },
  60_000,
);

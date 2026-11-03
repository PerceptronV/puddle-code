import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicPrivateJson } from '@puddle/shared/node';
import type {
  AgentAdapter,
  AgentControl,
  LifecycleLaunchContext,
} from '../../src/agents/adapter.js';
import { AdapterRegistry } from '../../src/agents/registry.js';
import { RuntimeHost } from '../../src/runtime/host.js';
import { RuntimeJournal } from '../../src/runtime/journal.js';

class FixtureControl implements AgentControl {
  ready = true;
  private count = 0;
  private ref: string | undefined;
  private pending: { finish(error?: Error): void } | null = null;
  constructor(private readonly context: LifecycleLaunchContext) {}
  ask(prompt: string, signal: AbortSignal, schema?: Record<string, unknown>): Promise<string> {
    if (!this.ready) return Promise.reject(new Error('Busy'));
    signal.throwIfAborted();
    this.ready = false;
    const count = ++this.count;
    atomicPrivateJson(
      join(this.context.account.config_dir, `${this.context.opts.sessionId}.turns.json`),
      { count, prompt, schema },
    );
    return new Promise((resolve, reject) => {
      const abort = () => finish(new Error('Cancelled by provider'));
      const finish = (error?: Error) => {
        if (this.pending?.finish !== finish) return;
        this.pending = null;
        this.ready = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(`reply:${count}:${prompt}`);
      };
      const timer = setTimeout(finish, 300);
      this.pending = { finish };
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  input(): void {
    this.pending?.finish(new Error('Human takeover'));
  }
  lifecycle(ref: string | undefined, ended: boolean): void {
    if (ended || (this.ref !== undefined && ref !== this.ref))
      this.pending?.finish(new Error('Conversation changed'));
    this.ref = ended ? undefined : ref;
  }
  dispose(): void {
    this.pending?.finish(new Error('Disposed'));
  }
}

/** No installed provider CLI is used: this sidecar exposes an in-memory counter. */
async function prepare(context: LifecycleLaunchContext) {
  if (context.env?.['PUDDLE_TEST_UNSUPPORTED'] === '1') throw new Error('Unsupported test version');
  const child = spawn(
    process.execPath,
    [
      '-e',
      `
    let counter = 0;
    const server = require('node:http').createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ pid: process.pid, counter: ++counter }));
    });
    server.listen(0, '127.0.0.1', () => process.send({ port: server.address().port }));
  `,
    ],
    {
      env: { HOME: context.account.config_dir, PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  const [ready] = (await once(child, 'message')) as [{ port: number }];
  const control = new FixtureControl(context);
  atomicPrivateJson(join(context.account.config_dir, `${context.opts.sessionId}.signals.json`), {
    url: context.signalUrl,
    nonce: context.signalNonce,
    port: ready.port,
    pid: child.pid,
    helpers: context.env?.['PUDDLE_AGENT_HELPER_DIR'],
    node: context.env?.['PUDDLE_AGENT_HELPER_NODE'],
    turnState: context.env?.['PUDDLE_AGENT_TURN_STATE_DIR'],
    captured: context.env?.['CAPTURED_FOR_TEST'],
  });
  return {
    args: [],
    control,
    sidecarPids: [child.pid!],
    hiddenPorts: [ready.port],
    async dispose() {
      control.dispose();
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
      try {
        await exited;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

const fake: AgentAdapter = {
  id: 'runtime-test',
  displayName: 'Runtime test',
  binary: '/bin/sh',
  capabilities: {
    resume: true,
    presetSessionId: false,
    skipPermissions: false,
    migratableSessions: false,
  },
  env: () => ({}),
  runtimeAssets: () => ({
    'puddle-signal.mjs': 'process.stdout.write("pinned-runtime-helper\\n");',
  }),
  launchArgs: () => [],
  resumeArgs: () => [],
  loginArgs: () => [],
  resolveSessionRef: async () => 'unused',
  statusPatterns: { waitingInput: [] },
  prepareLifecycleLaunch: prepare,
  prepareHeadlessLaunch: prepare,
};
const args = process.argv.slice(2);
const host = await RuntimeHost.start(
  args[1]!,
  args[3]!,
  'runtime-test',
  new AdapterRegistry([fake]),
);
// Deterministically yield journal admission after the fixture controller's
// command has entered the host. No gate exists in ordinary fixture runs.
const flush = RuntimeJournal.prototype.flush;
RuntimeJournal.prototype.flush = async function () {
  const gate = join(args[1]!, 'journal-admission-gate.json');
  if (existsSync(gate)) {
    const wanted = JSON.parse(readFileSync(gate, 'utf8')) as { command: number };
    if (host.state().command_cursor >= wanted.command) {
      atomicPrivateJson(join(args[1]!, 'journal-admission-entered.json'), {
        command: host.state().command_cursor,
      });
      while (existsSync(gate)) await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  return flush.call(this);
};
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.on(signal, () => {
    void host.stop().then(() => process.exit(0));
  });

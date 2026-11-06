import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { LifecycleLaunchResource } from '../../../src/agents/adapter.js';
import { prepareCodexLifecycle } from '../../../src/agents/codex/lifecycle.js';

/** Opt-in installed Codex 0.166+ conformance: synthetic history, no inference turns. */
it.skipIf(process.env['PUDDLE_NATIVE_CODEX_TEST'] !== '1').each(['fork', 'new'] as const)(
  'keeps both conversations loaded in separate owners after native %s',
  async (operation) => {
    const home = mkdtempSync(join(tmpdir(), 'puddle-native-codex-'));
    const config = join(home, 'config');
    const work = join(home, 'work');
    mkdirSync(config);
    mkdirSync(work);
    writeFileSync(
      join(config, 'config.toml'),
      'approval_policy = "never"\nsandbox_mode = "read-only"\n',
    );
    const ref = randomUUID();
    const timestamp = new Date().toISOString();
    const directory = join(config, 'sessions', '2026', '11', '05');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `rollout-2026-11-05T00-00-00-${ref}.jsonl`);
    writeFileSync(
      path,
      [
        {
          timestamp,
          type: 'session_meta',
          payload: {
            id: ref,
            timestamp,
            cwd: work,
            originator: 'codex_cli_rs',
            cli_version: '0.166.0',
            source: 'cli',
            model_provider: 'openai',
            base_instructions: { text: 'Synthetic offline fixture' },
          },
        },
        {
          timestamp,
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Synthetic saved question' }],
          },
        },
        {
          timestamp,
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Synthetic saved answer' }],
          },
        },
      ]
        .map((record) => JSON.stringify(record))
        .join('\n') + '\n',
    );
    const signals: Record<string, unknown>[] = [];
    const signalServer = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      signals.push(JSON.parse(body));
      response.writeHead(204).end();
    });
    signalServer.listen(0, '127.0.0.1');
    await once(signalServer, 'listening');
    const address = signalServer.address();
    if (!address || typeof address === 'string') throw new Error('No signal address');
    const resources: LifecycleLaunchResource[] = [];
    const sockets: WebSocket[] = [];
    const unavailable = vi.fn();
    let serial = 0;
    async function connect() {
      const resource = await prepareCodexLifecycle({
        account: { config_dir: config },
        opts: { sessionId: randomUUID(), worktreePath: work, skipPermissions: false },
        args: [],
        env: { OPENAI_API_KEY: '' },
        signalUrl: `http://127.0.0.1:${(address as { port: number }).port}`,
        signalNonce: 'synthetic',
        reportLifecycleUnavailable: unavailable,
      });
      resources.push(resource);
      expect(resource.args).toContain('thread_unload_delay_secs=0');
      const socket = new WebSocket(resource.args[1]!);
      sockets.push(socket);
      const messages: Record<string, unknown>[] = [];
      socket.on('message', (data) => messages.push(JSON.parse(String(data))));
      await once(socket, 'open');
      const call = async (method: string, params: object) => {
        const id = ++serial;
        socket.send(JSON.stringify({ id, method, params }));
        await vi.waitFor(
          () => expect(messages.some((message) => message['id'] === id)).toBe(true),
          { timeout: 5000, interval: 10 },
        );
        const response = messages.find((message) => message['id'] === id)!;
        expect(response['error']).toBeUndefined();
        return response['result'] as { thread?: { id: string }; data?: string[] };
      };
      await call('initialize', {
        clientInfo: { name: 'puddle_synthetic_test', version: '1' },
        capabilities: { experimentalApi: true },
      });
      socket.send(JSON.stringify({ method: 'initialized' }));
      return { call, messages };
    }
    try {
      const a = await connect();
      await a.call('thread/resume', { threadId: ref, path, cwd: work });
      const fork = (
        await a.call(operation === 'fork' ? 'thread/fork' : 'thread/start', {
          ...(operation === 'fork' ? { threadId: ref } : {}),
          cwd: work,
        })
      ).thread!.id;
      expect(fork).not.toBe(ref);
      await a.call('thread/unsubscribe', { threadId: ref });
      await vi.waitFor(
        () =>
          expect(
            a.messages.some(
              (message) =>
                message['method'] === 'thread/closed' &&
                (message['params'] as { threadId: string }).threadId === ref,
            ),
          ).toBe(true),
        { timeout: 2000, interval: 10 },
      );
      const b = await connect();
      expect((await b.call('thread/resume', { threadId: ref, cwd: work })).thread!.id).toBe(ref);
      expect((await a.call('thread/loaded/list', {})).data).toContain(fork);
      await vi.waitFor(() =>
        expect(signals).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              source: operation === 'fork' ? 'fork' : 'clear',
              agent_session_ref: fork,
              ...(operation === 'fork' ? { parent_agent_session_ref: ref } : {}),
            }),
          ]),
        ),
      );
      expect(unavailable).not.toHaveBeenCalled();
    } finally {
      for (const socket of sockets) socket.terminate();
      for (const resource of resources.reverse()) await resource.dispose();
      signalServer.closeAllConnections();
      await new Promise<void>((resolve) => signalServer.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  },
  20_000,
);

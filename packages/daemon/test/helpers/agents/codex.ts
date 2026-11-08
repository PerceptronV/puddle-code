import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { WebSocket } from 'ws';
import type { AgentNativeTurn, AgentSignalRequest } from '@puddle/shared';
import type { RuntimeByteAllowance } from '../../../src/runtime/resources/budget.js';
import { prepareCodexLifecycle } from '../../../src/agents/codex/lifecycle.js';

export async function codexBridgeFixture(allowance?: RuntimeByteAllowance) {
  const directory = mkdtempSync(join(tmpdir(), 'puddle-codex-bridge-'));
  const nonce = randomUUID();
  writeCodexFixture(directory);
  const signals: AgentSignalRequest[] = [];
  const events: Array<{ event: AgentNativeTurn; bound: string | null }> = [];
  const gaps: Array<[string, string]> = [];
  let bound: string | null = null,
    unavailable = false;
  try {
    const resource = await prepareCodexLifecycle({
      account: { config_dir: directory },
      opts: { sessionId: randomUUID(), worktreePath: directory, skipPermissions: false },
      args: [],
      env: { PATH: `${directory}:${process.env['PATH']}` },
      signalUrl: 'http://127.0.0.1:1/unused-direct-delivery',
      signalNonce: nonce,
      bufferAllowance: allowance,
      receiveSignal: (signal) => {
        signals.push(signal);
        if ('event' in signal && signal.event === 'session_start')
          bound = signal.agent_session_ref!;
        return true;
      },
      reportLifecycleUnavailable: () => {
        unavailable = true;
      },
      reportNativeTurn: (event) => events.push({ event, bound }),
      reportNativeTurnGap: (ref, id) => gaps.push([ref, id]),
    });
    const socket = new WebSocket(resource.args[1]!, { perMessageDeflate: false });
    socket.on('error', () => {});
    try {
      await once(socket, 'open');
    } catch (error) {
      await resource.dispose();
      throw error;
    }
    const received: unknown[] = [];
    socket.on('message', (body) => received.push(JSON.parse(String(body))));
    return {
      directory,
      nonce,
      resource,
      socket,
      signals,
      events,
      gaps,
      received,
      unavailable: () => unavailable,
      async close() {
        socket.terminate();
        await resource.dispose();
        rmSync(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Pinned native-protocol fixture executable; never calls an installed provider. */
export function writeCodexFixture(directory: string): void {
  const ws = createRequire(import.meta.url).resolve('ws');
  writeFileSync(
    join(directory, 'codex'),
    `#!${process.execPath}
    if (process.argv.includes('--version')) { console.log('codex-cli 0.166.0'); process.exit(0); }
    const { WebSocketServer, WebSocket } = require(${JSON.stringify(ws)});
    if (process.argv.includes('--remote')) {
      const fs = require('node:fs'), path = require('node:path');
      const socket = new WebSocket(process.argv[process.argv.indexOf('--remote') + 1], { perMessageDeflate: false });
      socket.on('open', () => socket.send(JSON.stringify([
        { id: 1, method: 'thread/start', params: {} },
        { method: 'fixture/batch', params: { messages: [{ id: 1, result: { thread: { id: 'thread' } } }] } }
      ])));
      const input = path.join(__dirname, 'codex-input.json');
      const timer = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN || !fs.existsSync(input)) return;
        const body = fs.readFileSync(input, 'utf8'); fs.unlinkSync(input); socket.send(body);
      }, 20);
      socket.on('close', () => { clearInterval(timer); process.exit(0); });
      socket.on('error', () => process.exit(1));
      return;
    }
    const url = new URL(process.argv[process.argv.indexOf('--listen') + 1]);
    const server = new WebSocketServer({ host: '127.0.0.1', port: Number(url.port), perMessageDeflate: false });
    let serial = 0;
    server.on('connection', socket => socket.on('message', bytes => {
      const body = JSON.parse(String(bytes));
      for (const message of Array.isArray(body) ? body : [body]) {
        if (message.method === 'fixture/batch') socket.send(JSON.stringify(message.params.messages));
        if (message.method === 'turn/start' && String(message.id).startsWith('puddlang:')) {
          const id = 'automated-' + (++serial), threadId = message.params.threadId;
          socket.send(JSON.stringify([
            { method: 'turn/started', params: { threadId, turn: { id, status: 'inProgress' } } },
            { method: 'item/completed', params: { threadId, turnId: id, item: { type: 'agentMessage', phase: 'final_answer', text: 'answer' } } },
            { method: 'turn/completed', params: { threadId, turn: { id, status: 'completed', items: [] } } },
            { id: message.id, result: { turn: { id, status: 'inProgress' } } }
          ]));
        }
      }
    }));
  `,
    { mode: 0o700 },
  );
}

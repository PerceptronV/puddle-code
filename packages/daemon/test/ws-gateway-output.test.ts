import { EventEmitter } from 'node:events';
import type { WSContext } from 'hono/ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogStore } from '../src/logs/log-store.js';
import type { PtyManager } from '../src/pty/pty-manager.js';
import type { TerminalTheme } from '../src/pty/terminal-theme.js';
import type { SessionService } from '../src/sessions/service.js';
import { WsGateway } from '../src/ws/gateway.js';

function fixture() {
  const ptys = Object.assign(new EventEmitter(), {
    resize: vi.fn(),
    write: vi.fn(),
  });
  const service = Object.assign(new EventEmitter(), {
    get: vi.fn(() => ({})),
    spawnShell: vi.fn(() => 'shell-1'),
    expectExit: vi.fn(),
  });
  const logs = { readTail: vi.fn(() => 'replayed tail') };
  const theme = { set: vi.fn() };
  const gateway = new WsGateway({
    token: 'secret',
    ptys: ptys as unknown as PtyManager,
    logs: logs as unknown as LogStore,
    service: service as unknown as SessionService,
    theme: theme as unknown as TerminalTheme,
  });
  const send = vi.fn();
  const ws = { readyState: 1, send, close: vi.fn() } as unknown as WSContext;
  const connection = gateway.connection();
  const receive = (message: object) => connection.onMessage({ data: JSON.stringify(message) }, ws);
  receive({ t: 'auth', token: 'secret' });
  receive({ t: 'attach', session: 'session-1', term: 'agent', cols: 120, rows: 40 });
  send.mockClear(); // ignore the initial replay
  return { ptys, send };
}

function messages(send: ReturnType<typeof vi.fn>) {
  return send.mock.calls.map(
    ([message]) => JSON.parse(String(message)) as { t: string; data?: string },
  );
}

afterEach(() => {
  vi.useRealTimers();
});

describe('WebSocket terminal output batching', () => {
  it('coalesces PTY chunks into one ordered frame message', () => {
    vi.useFakeTimers();
    const { ptys, send } = fixture();

    ptys.emit('data', { stream: 'session-1', term: 'agent', data: 'one' });
    ptys.emit('data', { stream: 'session-1', term: 'agent', data: '-two' });
    ptys.emit('data', { stream: 'session-1', term: 'agent', data: '-three' });

    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(16);
    expect(messages(send)).toEqual([
      {
        t: 'output',
        session: 'session-1',
        term: 'agent',
        data: 'one-two-three',
      },
    ]);
  });

  it('flushes pending bytes before the exit message', () => {
    vi.useFakeTimers();
    const { ptys, send } = fixture();

    ptys.emit('data', { stream: 'session-1', term: 'agent', data: 'last output' });
    ptys.emit('exit', { stream: 'session-1', term: 'agent', exitCode: 7 });

    expect(messages(send)).toEqual([
      {
        t: 'output',
        session: 'session-1',
        term: 'agent',
        data: 'last output',
      },
      { t: 'exit', session: 'session-1', term: 'agent', code: 7 },
    ]);
  });
});

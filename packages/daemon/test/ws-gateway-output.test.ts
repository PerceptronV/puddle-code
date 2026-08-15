import { EventEmitter } from 'node:events';
import type { WSContext } from 'hono/ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LogStore } from '../src/logs/log-store.js';
import type { PtyManager } from '../src/pty/pty-manager.js';
import type { TerminalTheme } from '../src/pty/terminal-theme.js';
import type { SessionService } from '../src/sessions/service.js';
import { WsGateway } from '../src/ws/gateway.js';

function fixture(snapshot: Promise<string> = Promise.resolve('restored screen')) {
  const ptys = Object.assign(new EventEmitter(), {
    resize: vi.fn(),
    write: vi.fn(),
    snapshot: vi.fn(() => snapshot),
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
  // finishAttach's await continuation was registered by receive() first.
  const attached = snapshot.then(() => Promise.resolve());
  return { ptys, send, attached };
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
  it('coalesces PTY chunks into one ordered frame message', async () => {
    vi.useFakeTimers();
    const { ptys, send, attached } = fixture();
    await attached;
    send.mockClear(); // ignore the initial replay

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

  it('flushes pending bytes before the exit message', async () => {
    vi.useFakeTimers();
    const { ptys, send, attached } = fixture();
    await attached;
    send.mockClear(); // ignore the initial replay

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

  it('holds live output behind an in-progress screen restore', async () => {
    vi.useFakeTimers();
    let resolveSnapshot!: (snapshot: string) => void;
    const snapshot = new Promise<string>((resolve) => {
      resolveSnapshot = resolve;
    });
    const { ptys, send, attached } = fixture(snapshot);
    ptys.emit('data', { stream: 'session-1', term: 'agent', data: 'after snapshot' });
    vi.advanceTimersByTime(16);
    expect(send).not.toHaveBeenCalled();
    resolveSnapshot('complete screen');
    await attached;
    expect(messages(send)).toEqual([
      {
        t: 'replay',
        session: 'session-1',
        term: 'agent',
        data: 'complete screen',
      },
      {
        t: 'output',
        session: 'session-1',
        term: 'agent',
        data: 'after snapshot',
      },
    ]);
  });
});

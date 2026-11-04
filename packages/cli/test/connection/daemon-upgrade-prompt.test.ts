import { reviewedHostUpdate } from '../../../shared/test/helpers/host-update.js';
import { confirmHostUpdateInterruption } from '../../src/cli/daemon-upgrade-prompt.js';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import {
  requestDaemonUpgradeApproval,
  relayDaemonUpgradePrompt,
} from '../../src/cli/daemon-upgrade-prompt.js';

afterEach(() => vi.restoreAllMocks());

function pipe() {
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    send: vi.fn(),
    disconnect: vi.fn(),
  });
  return child;
}

it.each([true, false])(
  'relays one terminal decision (%s) to the requesting child',
  async (approved) => {
    const child = pipe();
    let answer!: (value: boolean) => void;
    const ask = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          answer = resolve;
        }),
    );
    const stop = relayDaemonUpgradePrompt(child as unknown as ChildProcess, ask);
    child.emit('message', { t: 'unrelated' });
    child.emit('message', {
      t: 'puddle:confirm-daemon-upgrade',
      id: 'one',
      message: 'Host update',
    });
    child.emit('message', {
      t: 'puddle:confirm-daemon-upgrade',
      id: 'duplicate',
      message: 'Host update',
    });
    expect(ask).toHaveBeenCalledExactlyOnceWith('Host update');
    expect(child.send).not.toHaveBeenCalled();
    answer(approved);
    await vi.waitFor(() =>
      expect(child.send).toHaveBeenCalledExactlyOnceWith(
        { t: 'puddle:daemon-upgrade-answer', id: 'one', approved },
        expect.any(Function),
      ),
    );
    stop();
    expect(child.listenerCount('message')).toBe(0);
    expect(child.disconnect).toHaveBeenCalledOnce();
  },
);

it('never sends a late approval after the launcher has detached', async () => {
  const child = pipe();
  let answer!: (value: boolean) => void;
  const stop = relayDaemonUpgradePrompt(
    child as unknown as ChildProcess,
    () =>
      new Promise<boolean>((resolve) => {
        answer = resolve;
      }),
  );
  child.emit('message', { t: 'puddle:confirm-daemon-upgrade', id: 'one', message: 'Host update' });
  stop();
  answer(true);
  await new Promise((resolve) => setImmediate(resolve));
  expect(child.send).not.toHaveBeenCalled();
});

it('accepts only its correlated boolean answer and removes its IPC listeners', async () => {
  const child = pipe();
  const pending = requestDaemonUpgradeApproval('Host update', child as unknown as NodeJS.Process);
  const sent = child.send.mock.calls[0]?.[0] as { id: string; message: string };
  expect(sent.message).toBe('Host update');
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  child.emit('message', { t: 'puddle:daemon-upgrade-answer', id: 'wrong', approved: true });
  child.emit('message', { t: 'puddle:daemon-upgrade-answer', id: sent.id, approved: 'yes' });
  await Promise.resolve();
  expect(settled).toBe(false);
  child.emit('message', { t: 'puddle:daemon-upgrade-answer', id: sent.id, approved: true });
  expect(await pending).toBe(true);
  expect(child.listenerCount('message')).toBe(0);
  expect(child.listenerCount('disconnect')).toBe(0);
});

it('declines if the launching terminal disconnects before replying', async () => {
  const child = pipe();
  const pending = requestDaemonUpgradeApproval('Host update', child as unknown as NodeJS.Process);
  child.emit('disconnect');
  expect(await pending).toBe(false);
  expect(child.listenerCount('message')).toBe(0);
});

it('uses a fresh correlated parent decision for exact interruption after initial approval', async () => {
  const send = vi.fn();
  vi.stubGlobal('process', Object.assign(Object.create(process), { send, connected: true }));
  try {
    const pending = confirmHostUpdateInterruption('fixture', reviewedHostUpdate());
    const sent = send.mock.calls[0]![0] as { id: string; message: string };
    expect(sent.message).toContain('2 daemon-owned terminal(s), 1 notebook kernel(s)');
    expect(sent.message).toContain('daemon 0.4.0 on fixture');
    (process as EventEmitter).emit('message', {
      t: 'puddle:daemon-upgrade-answer',
      id: 'earlier-approval',
      approved: true,
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    (process as EventEmitter).emit('message', {
      t: 'puddle:daemon-upgrade-answer',
      id: sent.id,
      approved: false,
    });
    expect(await pending).toBe(false);
  } finally {
    vi.unstubAllGlobals();
  }
});

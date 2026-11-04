import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { HeadlessWrites } from '../../../src/agents/headless/writes.js';
import { HeadlessControl } from '../../../src/agents/headless/control.js';
import type { HeadlessContext, HeadlessDriver } from '../../../src/agents/headless/codec.js';
import { RuntimeBufferBudget } from '../../../src/runtime/resources/budget.js';

function socket() {
  return Object.assign(new EventEmitter(), {
    destroyed: false,
    write: vi.fn(),
    setEncoding: vi.fn(),
    destroy: vi.fn(),
  }) as unknown as Socket;
}

describe('bounded headless helper sends', () => {
  it('holds actual queued writes and refuses serialisation before admission without closing the terminal', () => {
    const owner = new RuntimeBufferBudget({ bytes: 1024, count: 1 });
    const peer = socket();
    const writes = new HeadlessWrites(peer, owner);
    expect(writes.send({ type: 'display', text: 'first' })).toBe(true);
    expect(owner.usedCount).toBe(1);
    const stringify = vi.spyOn(JSON, 'stringify');
    expect(writes.send({ type: 'display', text: 'next' })).toBe(false);
    expect(stringify).not.toHaveBeenCalled();
    stringify.mockRestore();
    expect(peer.destroy).not.toHaveBeenCalled();
    const callback = (peer.write as ReturnType<typeof vi.fn>).mock.calls[0]![1] as () => void;
    callback();
    expect(owner.usedBytes).toBe(0);
    expect(writes.send({ type: 'display', text: 'last' })).toBe(true);
    peer.emit('close');
    expect(owner.usedBytes).toBe(0);
  });
  it('refuses an unsent turn explicitly and leaves the helper socket alive', async () => {
    const peer = socket();
    const unavailable = vi.fn();
    const context = {
      opts: {},
      bufferAllowance: new RuntimeBufferBudget({ bytes: 0, count: 0 }),
      reportLifecycleUnavailable: unavailable,
    } as unknown as HeadlessContext;
    const driver = {
      binary: 'fake',
      env: {},
      command: () => ({ args: [], stdin: '' }),
      decoder: () => () => ({}),
    } as HeadlessDriver;
    const control = new HeadlessControl(context, driver);
    control.connect(peer);
    peer.emit('data', '{"type":"ready"}\n');
    await expect(control.ask('hello', new AbortController().signal)).rejects.toThrow(
      'no turn was dispatched',
    );
    expect(peer.write).not.toHaveBeenCalled();
    expect(peer.destroy).not.toHaveBeenCalled();
    expect(unavailable).toHaveBeenCalledOnce();
    expect(control.ready).toBe(true);
    control.dispose();
  });
});

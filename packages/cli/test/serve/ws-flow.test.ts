import type WebSocket from 'ws';
import { expect, it, vi } from 'vitest';
import { forwardWsMessage } from '../../src/lib/serve/ws-flow.js';

function fixture() {
  const callbacks: Array<(error?: Error) => void> = [];
  const source = { readyState: 1, pause: vi.fn(), resume: vi.fn() };
  const destination = {
    readyState: 1,
    bufferedAmount: 0,
    send: vi.fn((_data, _options, callback) => {
      callbacks.push(callback);
    }),
  };
  const close = vi.fn();
  let valid = true;
  const send = () =>
    forwardWsMessage(
      source as unknown as WebSocket,
      destination as unknown as WebSocket,
      'exact bytes',
      () => valid,
      close,
    );
  return {
    source,
    destination,
    close,
    send,
    complete: (error?: Error) => callbacks.shift()!(error),
    revoke: () => {
      valid = false;
    },
  };
}

it('paces a congested direction until its queue drains without changing or replaying bytes', () => {
  const f = fixture();
  f.destination.bufferedAmount = 300_000;
  f.send();
  expect(f.source.pause).toHaveBeenCalledOnce();
  // A second message already parsed from the same socket read can still arrive.
  f.send();
  f.complete();
  expect(f.source.resume).not.toHaveBeenCalled();
  f.destination.bufferedAmount = 0;
  f.complete();
  expect(f.source.resume).toHaveBeenCalledOnce();
  expect(f.destination.send).toHaveBeenCalledTimes(2);
  expect(f.destination.send).toHaveBeenNthCalledWith(
    1,
    'exact bytes',
    { binary: false },
    expect.any(Function),
  );
});

it('retains immediate fast-link delivery and closes on send failure or authority loss', () => {
  const f = fixture();
  f.send();
  expect(f.source.pause).not.toHaveBeenCalled();
  f.complete(new Error('lost'));
  expect(f.close).toHaveBeenCalledOnce();
  expect(f.destination.send).toHaveBeenCalledOnce();
  const revoked = fixture();
  revoked.send();
  revoked.revoke();
  revoked.complete();
  expect(revoked.source.resume).not.toHaveBeenCalled();
  expect(revoked.close).toHaveBeenCalledOnce();
});

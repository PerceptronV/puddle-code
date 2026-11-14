import { errorMonitor } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { HostControlClient } from '../../src/node/host-control.js';

it('disposes a channel arriving after shutdown without an unhandled abort or opening authority', async () => {
  let deliver!: (channel: Duplex) => void;
  const open = vi.fn(
    () =>
      new Promise<Duplex>((resolve) => {
        deliver = resolve;
      }),
  );
  const client = new HostControlClient(open);
  const pending = client.establish();
  client.close();

  // Match the SSH transport: destroying an unfinished Duplex.from emits AbortError.
  const readable = new PassThrough();
  const writable = new PassThrough();
  const channel = Duplex.from({ readable, writable });
  const write = vi.spyOn(channel, 'write');
  const abort = vi.fn();
  channel.on(errorMonitor, abort); // Observe errors without handling them for the client.
  const closed = new Promise<void>((resolve) => channel.once('close', resolve));
  deliver(channel);
  await pending;
  await closed;

  expect(abort).toHaveBeenCalledWith(expect.objectContaining({ code: 'ABORT_ERR' }));
  expect(readable.destroyed).toBe(true);
  expect(writable.destroyed).toBe(true);
  expect(write).not.toHaveBeenCalled();
  expect(client.state).toBe('upstream_unavailable');
  expect(client.generation).toBeNull();
  expect(() => client.credential()).toThrow('connection authority is unavailable');
  await client.establish();
  expect(open).toHaveBeenCalledOnce();
});

it('still rejects a connection when its active channel fails', async () => {
  const readable = new PassThrough();
  const writable = new PassThrough();
  const channel = Duplex.from({ readable, writable });
  const client = new HostControlClient(async () => channel, false);
  writable.once('data', () => readable.destroy(new Error('SSH channel failed')));
  try {
    await expect(client.establish()).rejects.toThrow('Host control channel is unavailable');
    expect(client.state).toBe('upstream_unavailable');
    expect(() => client.credential()).toThrow('connection authority is unavailable');
  } finally {
    client.close();
  }
});

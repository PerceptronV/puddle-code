import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { HostUpdateRequests } from '../src/node/host-updates.js';
import { hostUpdateCommandSchema } from '../src/api/connection/host-updates.js';

afterEach(() => vi.useRealTimers());

it('abandons a generation after a synchronous transport failure without retaining pending calls', async () => {
  vi.useFakeTimers();
  const channel = new PassThrough();
  const write = vi.spyOn(channel, 'write').mockImplementation(() => {
    throw new Error('transport failed after accepting bytes');
  });
  const requests = new HostUpdateRequests(channel);
  await expect(requests.request({ action: 'status' })).rejects.toThrow('inspect the operation');
  expect(channel.destroyed).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  await expect(requests.request({ action: 'status' })).rejects.toThrow('unavailable');
  expect(write).toHaveBeenCalledTimes(1);
});

it('expires an unanswered call and ignores its one late reply without replay', async () => {
  vi.useFakeTimers();
  const channel = new PassThrough();
  const messages: Array<{ request_id: string }> = [];
  channel.on('data', (data: Buffer) => messages.push(JSON.parse(data.toString())));
  const requests = new HostUpdateRequests(channel);
  const pending = expect(requests.request({ action: 'status' })).rejects.toThrow(
    'inspect the operation',
  );
  await vi.advanceTimersByTimeAsync(120_000);
  await pending;
  expect(messages).toHaveLength(1);
  const response = {
    t: 'host-update-result' as const,
    request_id: messages[0]!.request_id,
    result: { ok: true as const, operation: null },
  };
  expect(requests.receive(response)).toBe(true);
  expect(requests.receive(response)).toBe(false);
  expect(messages).toHaveLength(1);
  requests.close();
  channel.destroy();
});

it('rejects command injection and arbitrary installation locations at the shared boundary', () => {
  expect(
    hostUpdateCommandSchema.safeParse({
      action: 'begin',
      targets: [{ component: 'runtime', version: '0.4.0' }],
      url: 'https://example.invalid/archive',
    }).success,
  ).toBe(false);
  expect(
    hostUpdateCommandSchema.safeParse({
      action: 'begin',
      targets: [{ component: 'runtime', version: '0.4.0; command' }],
    }).success,
  ).toBe(false);
  expect(hostUpdateCommandSchema.safeParse({ action: 'exec', command: 'anything' }).success).toBe(
    false,
  );
});

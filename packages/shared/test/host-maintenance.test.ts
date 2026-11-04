import { randomUUID } from 'node:crypto';
import { Duplex, PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  REMOTE_POLICY,
  hostMaintenanceCommandSchema,
  type ControlRequest,
  type HostMaintenanceCommand,
  type HostMaintenanceReply,
} from '../src/index.js';
import { HostControlClient } from '../src/node/host-control.js';
import { HostControlRequests } from '../src/node/control/requests.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
  vi.useRealTimers();
});
const claim = () => ({
  device: randomUUID(),
  peer: 'a'.repeat(64),
  account: 'account',
  host: randomUUID(),
  grant: randomUUID(),
});
const success: HostMaintenanceReply = { kind: 'result', result: { ok: true, operation: null } };

it('requires a profile and current application capability before sending maintenance', async () => {
  const open = vi.fn(async () => new PassThrough());
  expect(() => new HostControlClient(open, false, undefined, undefined, claim())).toThrow(
    'requires a profile',
  );
  for (const [profile, grant] of [
    [undefined, undefined],
    ['0123456789', undefined],
    ['0123456789', claim()],
  ] as const) {
    const client = new HostControlClient(open, false, undefined, profile, grant);
    cleanups.push(() => client.close());
    client.version = { version: '0.4.0', protocol: { major: 25, minor: 20 } };
    await expect(client.hostMaintenance({ action: 'status' })).rejects.toThrow('unavailable');
  }
  expect(open).not.toHaveBeenCalled();
});

it('never renews or reconnects a maintenance child autonomously even when requested', async () => {
  vi.useFakeTimers();
  const messages: ControlRequest[] = [];
  const channel = new Duplex({
    read() {},
    write(data: Buffer, _encoding, done) {
      const message = JSON.parse(data.toString()) as ControlRequest;
      messages.push(message);
      if (message.t === 'open')
        this.push(
          JSON.stringify({
            t: 'authority',
            generation: randomUUID(),
            token: 'cn_' + 'b'.repeat(64),
            validForMs: 45_000,
            port: 7434,
            version: { version: '0.4.0', protocol: PROTOCOL_VERSION },
          }) + '\n',
        );
      done();
    },
  });
  const open = vi.fn(async () => channel);
  const maintenance = claim();
  const client = new HostControlClient(open, true, undefined, '0123456789', maintenance);
  cleanups.push(() => client.close());
  await client.establish();
  expect(messages).toEqual([{ t: 'open', profile: '0123456789', maintenance }]);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(messages).toHaveLength(1);
  await expect(client.hostUpdate({ action: 'status' })).rejects.toThrow('unavailable');
  const pending = client.hostMaintenance({ action: 'status' });
  const message = messages.at(-1)!;
  if (message.t !== 'host-maintenance') throw new Error('Missing maintenance request');
  channel.push(
    JSON.stringify({
      t: 'host-maintenance-result',
      request_id: message.request_id,
      result: success,
    }) + '\n',
  );
  expect(await pending).toEqual(success);
  channel.destroy();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(open).toHaveBeenCalledOnce();
});

it('allows the bounded combined preparation time without retrying a lost call', async () => {
  vi.useFakeTimers();
  const channel = new PassThrough();
  cleanups.push(() => channel.destroy());
  const messages: Array<{ request_id: string }> = [];
  channel.on('data', (chunk: Buffer) => messages.push(JSON.parse(chunk.toString())));
  const requests = new HostControlRequests<HostMaintenanceCommand, HostMaintenanceReply>(channel, {
    type: 'host-maintenance',
    parse: hostMaintenanceCommandSchema.parse,
    timeoutMs: REMOTE_POLICY.maintenanceRequestMs,
  });
  cleanups.push(() => requests.close());
  const pending = expect(requests.request({ action: 'status' })).rejects.toThrow(
    'inspect the operation',
  );
  await vi.advanceTimersByTimeAsync(120_001);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(REMOTE_POLICY.maintenanceRequestMs - 120_001);
  await pending;
  expect(messages).toHaveLength(1);
  expect(requests.receive({ request_id: messages[0]!.request_id, result: success })).toBe(true);
  expect(requests.receive({ request_id: messages[0]!.request_id, result: success })).toBe(false);
});

it('bounds total correlated requests and never reuses consumed request identities', async () => {
  const channel = new PassThrough();
  let last: { request_id: string };
  channel.on('data', (chunk: Buffer) => {
    last = JSON.parse(chunk.toString());
  });
  const requests = new HostControlRequests<HostMaintenanceCommand, HostMaintenanceReply>(channel, {
    type: 'host-maintenance',
    parse: hostMaintenanceCommandSchema.parse,
  });
  cleanups.push(() => {
    requests.close();
    channel.destroy();
  });
  const seen = new Set<string>();
  for (let i = 0; i < 1024; i++) {
    const pending = requests.request({ action: 'status' });
    expect(seen.has(last!.request_id)).toBe(false);
    seen.add(last!.request_id);
    expect(requests.receive({ request_id: last!.request_id, result: success })).toBe(true);
    await pending;
  }
  await expect(requests.request({ action: 'status' })).rejects.toThrow('limit reached');
  expect(seen.size).toBe(1024);
});

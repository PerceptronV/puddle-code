import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { HostUpdateRequests } from '../src/node/control/updates.js';
import { hostUpdateCommandSchema } from '../src/api/connection/host-updates.js';
import { HostControlClient } from '../src/node/host-control.js';

afterEach(() => vi.useRealTimers());

it('does not request the optional release catalogue from an older host', async () => {
  const client = new HostControlClient(async () => {
    throw new Error('No connection expected');
  }, false);
  client.version = { version: '0.4.0', protocol: { major: 25, minor: 13 } };
  try {
    await expect(client.hostUpdate({ action: 'status', include_catalogue: true })).rejects.toThrow(
      'catalogue is unavailable',
    );
  } finally {
    client.close();
  }
});

it('requires 25.12 before sending continuation or requesting recorded recovery details', async () => {
  const client = new HostControlClient(async () => {
    throw new Error('No connection expected');
  }, false);
  client.version = { version: '0.4.0', protocol: { major: 25, minor: 11 } };
  try {
    await expect(
      client.hostUpdate({
        action: 'recover',
        strategy: 'continue',
        reference: { id: randomUUID(), revision: 1 },
      }),
    ).rejects.toThrow('continuation is unavailable');
    await expect(client.hostUpdate({ action: 'status', include_recovery: true })).rejects.toThrow(
      'continuation is unavailable',
    );
  } finally {
    client.close();
  }
});

it('gates exact recovery verification on 25.11 and rejects arbitrary recovery commands', async () => {
  const command = {
    action: 'recover' as const,
    reference: { id: randomUUID(), revision: 1 },
    strategy: 'verify-completion' as const,
  };
  expect(hostUpdateCommandSchema.parse(command)).toEqual(command);
  expect(hostUpdateCommandSchema.safeParse({ ...command, strategy: 'restart' }).success).toBe(
    false,
  );
  expect(hostUpdateCommandSchema.safeParse({ ...command, command: 'anything' }).success).toBe(
    false,
  );
  const client = new HostControlClient(async () => {
    throw new Error('No connection expected');
  }, false);
  client.version = { version: '0.4.0', protocol: { major: 25, minor: 10 } };
  try {
    await expect(client.hostUpdate(command)).rejects.toThrow(
      'recovery verification is unavailable',
    );
  } finally {
    client.close();
  }
});

it('does not send interruption approval to an older host', async () => {
  const client = new HostControlClient(async () => {
    throw new Error('No connection expected');
  }, false);
  client.version = { version: '0.3.14', protocol: { major: 25, minor: 9 } };
  try {
    await expect(
      client.hostUpdate({
        action: 'apply',
        reference: { id: randomUUID(), revision: 1 },
        cockpit: { major: 25, minor: 10 },
        fingerprint: 'a'.repeat(64),
        interruption_approval: 'a'.repeat(64),
      }),
    ).rejects.toThrow('interruption approval is unavailable');
  } finally {
    client.close();
  }
});

it('accepts only bounded exact interruption consent on apply commands', () => {
  const command = {
    action: 'apply',
    reference: { id: randomUUID(), revision: 1 },
    cockpit: { major: 25, minor: 10 },
    fingerprint: 'a'.repeat(64),
  };
  expect(hostUpdateCommandSchema.parse(command)).toEqual(command);
  expect(
    hostUpdateCommandSchema.parse({ ...command, interruption_approval: command.fingerprint }),
  ).toMatchObject({ interruption_approval: command.fingerprint });
  for (const value of [true, 'anything', 'a'.repeat(65)]) {
    expect(
      hostUpdateCommandSchema.safeParse({ ...command, interruption_approval: value }).success,
    ).toBe(false);
  }
  expect(
    hostUpdateCommandSchema.safeParse({
      ...command,
      action: 'inspect',
      interruption_approval: command.fingerprint,
    }).success,
  ).toBe(false);
});

it('does not send adoption nonces to an older host', async () => {
  const client = new HostControlClient(async () => {
    throw new Error('No connection expected');
  }, false);
  client.version = { version: '0.3.14', protocol: { major: 25, minor: 7 } };
  try {
    await expect(
      client.hostUpdate({ action: 'status', id: randomUUID(), adoption_nonce: randomUUID() }),
    ).rejects.toThrow(/adoption inspection is unavailable/);
  } finally {
    client.close();
  }
});

it('binds fresh adoption observations to an exact operation and bounded nonce', () => {
  expect(
    hostUpdateCommandSchema.safeParse({ action: 'status', adoption_nonce: randomUUID() }).success,
  ).toBe(false);
  expect(
    hostUpdateCommandSchema.safeParse({
      action: 'status',
      id: randomUUID(),
      adoption_nonce: 'anything',
    }).success,
  ).toBe(false);
  const command = { action: 'status', id: randomUUID(), adoption_nonce: randomUUID() };
  expect(hostUpdateCommandSchema.parse(command)).toEqual(command);
  expect(hostUpdateCommandSchema.parse({ action: 'status' })).toEqual({ action: 'status' });
});

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

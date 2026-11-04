import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type Socket } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  controlResponseSchema,
  type HostUpdateReply,
  type HostUpdateCommand,
} from '@puddle/shared';
import { HostControlClient } from '@puddle/shared/node/host-control';
import { ipcPath, jsonLines } from '@puddle/shared/node';
import { LeaseRegistry } from '../../src/security/leases.js';
import { startHostControl } from '../../src/security/control.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture(
  handler?: Parameters<typeof startHostControl>[3],
  minor: number = PROTOCOL_VERSION.minor,
  major: number = PROTOCOL_VERSION.major,
) {
  const home = mkdtempSync(join(tmpdir(), 'puddle-control-updates-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  let now = 0;
  const registry = new LeaseRegistry(() => now);
  cleanups.push(() => registry.dispose());
  const handle = vi.fn(handler ?? (async () => ({ ok: true, operation: null }) as HostUpdateReply));
  cleanups.push(
    await startHostControl(
      home,
      registry,
      () => ({
        port: 7434,
        version: { version: 'fixture', protocol: { major, minor } },
      }),
      handle,
    ),
  );
  let socket!: Socket;
  const open = vi.fn(async () => {
    socket = connect(ipcPath(home, 'host'));
    return socket;
  });
  const client = new HostControlClient(open, false);
  cleanups.push(() => client.close());
  await client.establish();
  return {
    home,
    registry,
    handle,
    client,
    open,
    socket: () => socket,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it('correlates update replies independently of ordinary lease renewal', async () => {
  const gate = deferred();
  const f = await fixture(async (_command, valid) => {
    await gate.promise;
    expect(valid()).toBe(true);
    return { ok: true, operation: null };
  });
  const pending = f.client.hostUpdate({ action: 'status' });
  await expect.poll(() => f.handle.mock.calls.length).toBe(1);
  expect(f.client.participate([])).toBe(true);
  gate.release();
  expect(await pending).toEqual({ ok: true, operation: null });
  expect(f.registry.valid(f.client.credential())).toBe(true);
});

it('never renews authority through update traffic and rejects a late result after expiry', async () => {
  const gate = deferred();
  let valid: (() => boolean) | undefined;
  const f = await fixture(async (_command, authorised) => {
    valid = authorised;
    await gate.promise;
    return { ok: true, operation: null };
  });
  f.advance(44_000);
  const pending = f.client.hostUpdate({ action: 'status' });
  await expect.poll(() => f.handle.mock.calls.length).toBe(1);
  f.advance(2000);
  expect(valid?.()).toBe(false);
  gate.release();
  expect(await pending).toEqual({ ok: false, code: 'rejected', operation: null });
});

it('rejects pending calls on channel loss and never repeats them after reconnect', async () => {
  const gate = deferred();
  const f = await fixture(async () => {
    await gate.promise;
    return { ok: true, operation: null };
  });
  const pending = expect(f.client.hostUpdate({ action: 'status' })).rejects.toThrow(
    'inspect the operation',
  );
  await expect.poll(() => f.handle.mock.calls.length).toBe(1);
  f.socket().destroy();
  await pending;
  await f.client.establish();
  gate.release();
  expect(f.open).toHaveBeenCalledTimes(2);
  expect(f.handle).toHaveBeenCalledOnce();
  expect(await f.client.hostUpdate({ action: 'status' })).toEqual({ ok: true, operation: null });
});

async function exchange(socket: Socket, message: unknown) {
  const reply = new Promise<ReturnType<typeof controlResponseSchema.parse>>((resolve, reject) => {
    const stop = jsonLines(
      socket,
      (value) => {
        stop();
        resolve(controlResponseSchema.parse(value));
      },
      () => reject(new Error('invalid response')),
    );
    socket.once('error', reject);
  });
  socket.write(JSON.stringify(message) + '\n');
  return reply;
}

it.each([
  { action: 'status' },
  {
    action: 'recover',
    reference: { id: randomUUID(), revision: 1 },
    strategy: 'verify-completion',
  },
] satisfies HostUpdateCommand[])(
  'denies profile-scoped $action even if a connector sends a well-formed maintenance request',
  async (command) => {
    const f = await fixture();
    const socket = connect(ipcPath(f.home, 'host'));
    cleanups.push(() => {
      socket.destroy();
    });
    expect((await exchange(socket, { t: 'open', profile: '0123456789' })).t).toBe('authority');
    const request_id = randomUUID();
    expect(await exchange(socket, { t: 'host-update', request_id, command })).toEqual({
      t: 'host-update-result',
      request_id,
      result: { ok: false, code: 'rejected', operation: null },
    });
    expect(f.handle).not.toHaveBeenCalled();
  },
);

it('bounds concurrent update calls', async () => {
  const gate = deferred();
  const f = await fixture(async () => {
    await gate.promise;
    return { ok: true, operation: null };
  });
  const pending = Array.from({ length: 4 }, () => f.client.hostUpdate({ action: 'status' }));
  await expect(f.client.hostUpdate({ action: 'status' })).rejects.toThrow('limit');
  gate.release();
  await Promise.all(pending);
  expect(f.handle).toHaveBeenCalledTimes(4);
});

it('retains update controls on the compatible application 26.0 boundary', async () => {
  const compatible = await fixture(undefined, 0, 26);
  await expect(compatible.client.hostUpdate({ action: 'status' })).resolves.toEqual({
    ok: true,
    operation: null,
  });
  expect(compatible.handle).toHaveBeenCalledOnce();
});

it('rejects a legacy application major before ordinary control authority', async () => {
  await expect(fixture(undefined, 6, 25)).rejects.toThrow('does not match');
});

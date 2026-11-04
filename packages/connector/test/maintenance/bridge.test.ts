import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  type HostMaintenanceCommand,
  type HostMaintenanceReply,
  type RemoteMessage,
} from '@puddle/shared';
import { HostControlClient } from '@puddle/shared/node/host-control';
import { createIdentity, identityPeer, secureChannel, SocketWire } from '@puddle/remote-transport';
import { startHostControl } from '../../../daemon/src/security/control.js';
import { LeaseRegistry } from '../../../daemon/src/security/leases.js';
import { DeviceStore } from '../../src/devices.js';
import { admit } from '../../src/admission.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Actual Noise and private control; isolated approval store, no daemon/provider/service. */
async function fixture(granted = true) {
  const home = mkdtempSync(join(tmpdir(), 'puddle-maintenance-bridge-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const store = new DeviceStore(join(home, 'devices'));
  cleanups.push(() => store.close());
  const host = crypto.randomUUID();
  const profile = '0123456789';
  const browserIdentity = await createIdentity();
  const hostIdentity = await createIdentity();
  const peer = identityPeer(browserIdentity);
  const device = store.enrol(store.invite().invitation, peer, 'owner', 'Approved browser');
  store.approve(device.id);
  if (granted) store.setMaintenance(device.id, true, 'owner', host);
  const registry = new LeaseRegistry();
  cleanups.push(() => registry.dispose());
  const check = vi.fn(
    (scope: string, claim: unknown) =>
      scope === profile &&
      JSON.stringify(claim) ===
        JSON.stringify(store.maintenanceClaim(device.id, peer, 'owner', host)),
  );
  const execute = vi.fn(
    async (
      _command: HostMaintenanceCommand,
      _authorised: () => boolean,
    ): Promise<HostMaintenanceReply> => ({
      kind: 'result',
      result: { ok: true, operation: null },
    }),
  );
  cleanups.push(
    await startHostControl(
      home,
      registry,
      () => ({
        port: 7434,
        version: { version: '0.4.0', protocol: PROTOCOL_VERSION },
      }),
      undefined,
      { check, execute },
    ),
  );
  const outbound: Uint8Array[] = [];
  const a = new SocketWire(
    {
      bufferedAmount: 0,
      close: () => b.onTransportClosed(),
      send: (data) => {
        outbound.push(data.slice());
        queueMicrotask(() => b.receive(data.slice()));
      },
    },
    'outbound',
  );
  const b = new SocketWire(
    {
      bufferedAmount: 0,
      close: () => a.onTransportClosed(),
      send: (data) => queueMicrotask(() => a.receive(data.slice())),
    },
    'inbound',
  );
  const context = {
    service: 'https://relay.example.test',
    host,
    hostPeer: identityPeer(hostIdentity),
    connection: crypto.randomUUID(),
  };
  const [browser, connector] = await Promise.all([
    secureChannel(a, browserIdentity, context, 'outbound'),
    secureChannel(b, hostIdentity, context, 'inbound'),
  ]);
  const received: RemoteMessage[] = [];
  const reading = (async () => {
    try {
      for await (const message of browser.messages()) received.push(message);
    } catch {
      /* Closing the encrypted connection ends outstanding readers. */
    }
  })();
  const admission = admit(connector, {
    home,
    profile,
    account: 'owner',
    host,
    devices: store,
    enabled: () => true,
    admin: () => ({}),
  });
  cleanups.push(async () => {
    browser.close();
    connector.close();
    await Promise.all([reading, admission]);
  });
  await browser.send({ t: 'hello', account: 'owner', label: 'Approved browser' });
  await vi.waitFor(() => expect(received.some((message) => message.t === 'admitted')).toBe(true));
  return {
    home,
    profile,
    host,
    device,
    peer,
    store,
    browser,
    connector,
    received,
    execute,
    check,
    outbound,
  };
}

function mutation(id = crypto.randomUUID()): Extract<RemoteMessage, { t: 'request' }> {
  return {
    t: 'request',
    id,
    method: 'POST',
    path: '/api/host/updates',
    body: {
      action: 'apply',
      reference: { id: crypto.randomUUID(), revision: 3 },
      fingerprint: 'a'.repeat(64),
      interruption_approval: 'b'.repeat(64),
    },
  };
}

it('binds actual Noise identity to parent/child leases and routes exact review approval only over private control', async () => {
  const f = await fixture();
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const request = mutation();
  await f.browser.send(request);
  await vi.waitFor(() =>
    expect(
      f.received.some((message) => message.t === 'response' && message.id === request.id),
    ).toBe(true),
  );
  expect(f.execute).toHaveBeenCalledExactlyOnceWith(request.body, expect.any(Function));
  expect(f.check).toHaveBeenCalledWith(f.profile, {
    device: f.device.id,
    peer: f.peer,
    account: 'owner',
    host: f.host,
    grant: f.store.maintenanceClaim(f.device.id, f.peer, 'owner', f.host)!.grant,
  });
  expect(fetcher).not.toHaveBeenCalled();
  expect(f.outbound.some((bytes) => Buffer.from(bytes).includes('interruption_approval'))).toBe(
    false,
  );
});

it('denies ordinary approved browsers and requires fresh admission when a maintenance grant appears', async () => {
  const f = await fixture(false);
  f.store.setMaintenance(f.device.id, true, 'owner', f.host);
  await vi.waitFor(() => expect(f.connector.closed).toBe(true));
  expect(f.execute).not.toHaveBeenCalled();
  const ordinary = await fixture(false);
  await ordinary.browser.send(mutation());
  await vi.waitFor(() => expect(ordinary.connector.closed).toBe(true));
  expect(ordinary.execute).not.toHaveBeenCalled();
});

it.each(['cancel', 'revoke', 'disconnect'] as const)(
  'ends pending dispatch authority on %s without repeating the command',
  async (action) => {
    const f = await fixture();
    let authorised: (() => boolean) | undefined;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.execute.mockImplementation(async (_command, current) => {
      authorised = current;
      await pending;
      return {
        kind: 'result',
        result: current()
          ? { ok: true, operation: null }
          : { ok: false, code: 'rejected', operation: null },
      };
    });
    cleanups.push(finish);
    const request = mutation();
    await f.browser.send(request);
    await vi.waitFor(() => expect(authorised?.()).toBe(true));
    if (action === 'cancel') await f.browser.send({ t: 'cancel', id: request.id });
    else if (action === 'disconnect') f.browser.close();
    else {
      f.store.setMaintenance(f.device.id, false, 'owner', f.host);
      f.store.setMaintenance(f.device.id, true, 'owner', f.host);
    }
    await vi.waitFor(() => expect(authorised?.()).toBe(false));
    finish();
    expect(f.execute).toHaveBeenCalledTimes(1);
    if (action === 'cancel') expect(f.connector.closed).toBe(false);
  },
);

it.each([true, false])(
  'renews the child only when the browser explicitly includes its request: %s',
  async (included) => {
    const f = await fixture();
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    f.execute.mockImplementation(async () => {
      await pending;
      return { kind: 'result', result: { ok: true, operation: null } };
    });
    cleanups.push(finish);
    const participate = vi.spyOn(HostControlClient.prototype, 'participate');
    const request = mutation();
    await f.browser.send(request);
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
    expect(participate).not.toHaveBeenCalled();
    const challenge = f.received.find((message) => message.t === 'challenge');
    if (!challenge || challenge.t !== 'challenge') throw new Error('Missing challenge');
    await f.browser.send({
      t: 'participate',
      nonce: challenge.nonce,
      generation: challenge.generation,
      resources: included ? [request.id] : [],
    });
    await vi.waitFor(() => expect(participate).toHaveBeenCalledTimes(included ? 2 : 1));
    expect(participate.mock.calls[0]?.[0]).toHaveLength(included ? 1 : 0);
    if (included) {
      expect(participate.mock.calls[1]?.[0]).toEqual([]);
      expect(participate.mock.instances[0]).not.toBe(participate.mock.instances[1]);
    }
    finish();
  },
);

it.each([true, false])(
  'advertises update capability only for the current admitted grant: %s',
  async (granted) => {
    const f = await fixture(granted);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          version: '0.4.0',
          protocol: PROTOCOL_VERSION,
          remote_host_updates: true,
        }),
      ),
    );
    const id = crypto.randomUUID();
    await f.browser.send({ t: 'request', id, method: 'GET', path: '/api/version' });
    await vi.waitFor(() =>
      expect(f.received.some((message) => message.t === 'response' && message.id === id)).toBe(
        true,
      ),
    );
    const response = f.received.find((message) => message.t === 'response' && message.id === id);
    expect(response).toMatchObject({ t: 'response', body: { version: '0.4.0' } });
    if (response?.t !== 'response') throw new Error('Missing response');
    expect(response.body).toEqual(
      expect.objectContaining(granted ? { remote_host_updates: true } : {}),
    );
    if (!granted) expect(response.body).not.toHaveProperty('remote_host_updates');
  },
);

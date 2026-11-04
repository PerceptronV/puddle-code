import { expect, it, vi } from 'vitest';
import { cockpitHostUpdateStatusSchema } from '@puddle/shared';
import { startUiServer } from '../../src/lib/serve/ui-server.js';
import { cockpitUpdatesFixture } from '../helpers/cockpit-updates.js';

async function gateway(kind: 'local' | 'ssh' = 'local') {
  const f = await cockpitUpdatesFixture(kind);
  const ui = await startUiServer({
    assetsDir: f.home,
    authHome: f.home,
    identity: kind === 'local' ? 'local' : 'user@fixture-host',
    port: 0,
    target: { host: '127.0.0.1', port: 1 },
    authority: f.authority,
    hostUpdates: f.control,
  });
  f.cleanup(() => ui.close());
  const invitation = new URLSearchParams(new URL(ui.createInvitation()).hash.slice(1)).get(
    'invite',
  );
  const admitted = await fetch(ui.origin + '/cockpit/bootstrap', {
    method: 'POST',
    headers: { origin: ui.origin, 'content-type': 'application/json' },
    body: JSON.stringify({ invitation }),
  });
  const { credential } = (await admitted.json()) as { credential: string };
  const request = (
    method: string,
    body?: unknown,
    headers: Record<string, string> = {},
    query = '',
  ) =>
    fetch(ui.origin + '/cockpit/updates' + query, {
      method,
      headers: {
        origin: ui.origin,
        authorization: `Bearer ${credential}`,
        'content-type': 'application/json',
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { ...f, ui, credential, http: request };
}

it('retains browser protection while showing recorded status through a disconnected cockpit', async () => {
  const f = await gateway();
  f.authority.close();
  const response = await f.http('GET');
  expect(response.status).toBe(200);
  expect(cockpitHostUpdateStatusSchema.parse(await response.json())).toMatchObject({
    availability: 'unavailable',
    observation: 'recorded',
    result: { ok: true, operation: { id: f.operation.id } },
  });
  expect((await f.http('GET', undefined, { authorization: '' })).status).toBe(401);
  expect(
    (
      await f.http('POST', {
        action: 'recover',
        reference: { id: f.operation.id, revision: f.operation.revision },
        strategy: 'continue',
      })
    ).status,
  ).toBe(503);
  expect(f.commands).toEqual([]);
  expect(f.dispatch).not.toHaveBeenCalled();
});

it.each(['local', 'ssh'] as const)(
  'requires exact browser authority and bounded commands on the %s cockpit',
  async (kind) => {
    const f = await gateway(kind);
    expect(
      cockpitHostUpdateStatusSchema.parse(await (await f.http('GET')).json()).availability,
    ).toBe('ready');
    expect((await f.http('GET', undefined, { authorization: '' })).status).toBe(401);
    const request = {
      action: 'cancel',
      reference: { id: f.operation.id, revision: f.operation.revision },
    };
    expect((await f.http('POST', request, { origin: 'https://foreign.example.test' })).status).toBe(
      403,
    );
    expect((await f.http('POST', request, { origin: '' })).status).toBe(403);
    expect((await f.http('POST', request, { authorization: '' })).status).toBe(401);
    const commands = f.commands.length;
    for (const body of [
      { ...request, host: 'another-host' },
      { ...request, cockpit: { major: 1, minor: 0 } },
      { action: 'stage', reference: request.reference, receipt: f.stage },
      { action: 'prepare', targets: [{ component: 'daemon', version: '$(echo injected)' }] },
      { action: 'prepare', targets: f.operation.targets, tarball: '/private/archive.tar.gz' },
      { action: 'prepare', targets: [...f.operation.targets, ...f.operation.targets] },
      { action: 'apply', reference: request.reference, fingerprint: 'a'.repeat(63) },
    ])
      expect((await f.http('POST', body)).status).toBe(400);
    for (const query of ['?host=other', '?id=bad', `?id=${f.operation.id}&id=${f.operation.id}`])
      expect((await f.http('GET', undefined, {}, query)).status).toBe(400);
    expect((await f.http('POST', request, {}, `?id=${f.operation.id}`)).status).toBe(400);
    expect((await f.http('DELETE')).status).toBe(405);
    expect(f.commands).toHaveLength(commands);
    expect((await f.http('POST', request)).status).toBe(200);
    expect(f.store.read()?.phase).toBe('cancelled');
    expect(f.dispatch).not.toHaveBeenCalled();
  },
);

it('keeps reads available while serialising mutations and never reflects subprocess diagnostics', async () => {
  const f = await gateway();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const action = vi.spyOn(f.control, 'request').mockImplementationOnce(async () => {
    entered();
    await held;
    throw new Error('/private/path SECRET_TOKEN');
  });
  const request = {
    action: 'cancel',
    reference: { id: f.operation.id, revision: f.operation.revision },
  };
  const pending = f.http('POST', request);
  await started;
  try {
    expect((await f.http('GET')).status).toBe(200);
    expect((await f.http('POST', request)).status).toBe(409);
  } finally {
    release();
  }
  const result = await pending;
  expect(result.status).toBe(503);
  expect(await result.text()).not.toMatch(/private\/path|SECRET_TOKEN/);
  expect(action).toHaveBeenCalledOnce();
});

it('cancels uncommitted host dispatch on browser logout while retaining the cockpit lease', async () => {
  const f = await gateway();
  const reviewed = await f.request({
    action: 'inspect',
    reference: { id: f.operation.id, revision: f.operation.revision },
  });
  if (!reviewed.ok) throw new Error('Expected review');
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.inspect.mockImplementationOnce(async () => {
    entered();
    await held;
    return f.inspection;
  });
  const pending = f
    .http('POST', {
      action: 'apply',
      reference: { id: reviewed.operation!.id, revision: reviewed.operation!.revision },
      fingerprint: reviewed.review!.fingerprint,
    })
    .catch(() => null);
  await started;
  try {
    const logout = await fetch(f.ui.origin + '/cockpit/logout', {
      method: 'POST',
      headers: { origin: f.ui.origin, authorization: `Bearer ${f.credential}` },
    });
    expect(logout.status).toBe(200);
    await vi.waitFor(() => expect(f.active()).toBe(false));
  } finally {
    release();
  }
  await pending;
  expect(f.dispatch).not.toHaveBeenCalled();
  expect(f.authority.state).toBe('ready');
  expect(f.store.read()?.phase).toBe('preflight');
  expect((await f.http('GET')).status).toBe(401);
});

it('bounds concurrent status readers without blocking an explicit mutation', async () => {
  const f = await gateway();
  const status = await f.control.status(undefined, () => true, f.signal.signal);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let readers = 0;
  const read = vi.spyOn(f.control, 'status').mockImplementation(async () => {
    if (++readers === 4) entered();
    await held;
    return status;
  });
  const pending = Array.from({ length: 4 }, () => f.http('GET'));
  await started;
  try {
    expect((await f.http('GET')).status).toBe(409);
    expect(
      (
        await f.http('POST', {
          action: 'cancel',
          reference: { id: f.operation.id, revision: f.operation.revision },
        })
      ).status,
    ).toBe(200);
  } finally {
    release();
  }
  for (const response of await Promise.all(pending)) expect(response.status).toBe(200);
  expect(read).toHaveBeenCalledTimes(4);
});

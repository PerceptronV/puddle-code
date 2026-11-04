import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { hostReleaseCapabilities, type RuntimeResponse } from '@puddle/shared';
import type { RuntimeBinding } from '../../../src/db/stores/runtimes.js';
import { runtimeBindingIdentity } from '../../../src/runtime/transport/connections.js';
import type { RuntimeClient } from '../../../src/runtime/transport/client.js';
import { acquireHostClaim } from '../../../src/security/claims.js';
import { HostUpdateCompatibility } from '../../../src/updates/preflight/compatibility.js';
import { candidateFixture } from './helpers.js';

function fixture(
  component: 'daemon' | 'runtime' = 'daemon',
  candidate = hostReleaseCapabilities('0.4.0'),
) {
  const f = candidateFixture(component, candidate);
  const binding: RuntimeBinding = {
    runtime_id: randomUUID(),
    incarnation: randomUUID(),
    launch_id: randomUUID(),
    launch_fingerprint: 'fixture',
    profile_id: '1111111111',
    project_id: '2222222222',
    launch_session_id: randomUUID(),
    active_session_id: randomUUID(),
    active_segment_id: null,
    account_id: null,
    agent_type: null,
    canonical_worktree_path: f.home,
    conversation_id: null,
    build: '0.3.14',
    protocol_major: 1,
    protocol_minor: 8,
    release_path: f.root,
    state: 'running',
    event_cursor: 0,
    created_at: new Date().toISOString(),
    ended_at: null,
  };
  mkdirSync(join(f.home, 'runtimes', binding.runtime_id), { recursive: true });
  // The transport has already validated full responses; this double supplies the
  // identity fields consumed by compatibility inspection without creating a PTY.
  const state = {
    identity: runtimeBindingIdentity(binding),
    build: binding.build,
    protocol: { major: 1, minor: 8 },
  };
  const request = vi.fn(async () => ({ t: 'state', state }) as RuntimeResponse);
  const client = { request } as unknown as RuntimeClient;
  const bindings = new Map([[binding.runtime_id, binding]]);
  const clients = new Map([[binding.runtime_id, client]]);
  const current = hostReleaseCapabilities('0.3.14');
  const inspector = new HostUpdateCompatibility({
    home: f.home,
    current,
    runtimes: {
      live: () => [...bindings.values()].filter((b) => b.state === 'running'),
      get: (id) => bindings.get(id) ?? null,
    },
    connections: { get: (id) => clients.get(id) ?? null },
  });
  const inspect = (connector: number | null = null) =>
    inspector.inspect(f.operation, current.application, current.runtime, connector);
  return { ...f, binding, bindings, clients, request, state, inspect, current };
}

it('accepts different release versions and additive runtime minors, using supported majors alone', async () => {
  const f = fixture();
  expect((await f.inspect()).blockers).toEqual([]);
  expect(f.request).toHaveBeenCalledExactlyOnceWith({ t: 'inspect' });
  expect(f.store.read()?.phase).toBe('staged'); // Inspection cannot approve or dispatch.
});

it('blocks an incompatible live runtime without contacting or retiring it', async () => {
  const f = fixture();
  f.binding.protocol_major = 2;
  const result = await f.inspect();
  expect(result.blockers).toContainEqual({
    code: 'runtime_incompatible',
    target: f.binding.runtime_id,
  });
  expect(f.request).not.toHaveBeenCalled();
  expect(f.binding.state).toBe('running');
});

it.each(['missing', 'failure', 'identity', 'placement'])(
  'blocks %s owner evidence without starting recovery',
  async (failure) => {
    const f = fixture();
    if (failure === 'missing') f.clients.clear();
    if (failure === 'failure') f.request.mockRejectedValueOnce(new Error('disconnected'));
    if (failure === 'identity') f.state.identity.incarnation = randomUUID();
    if (failure === 'placement')
      f.request.mockImplementationOnce(async () => {
        f.bindings.set(f.binding.runtime_id, { ...f.binding, active_session_id: randomUUID() });
        return { t: 'state', state: f.state } as RuntimeResponse;
      });
    expect((await f.inspect()).blockers).toContainEqual({
      code: ['missing', 'failure'].includes(failure)
        ? 'runtime_unavailable'
        : 'runtime_identity_changed',
      target: f.binding.runtime_id,
    });
    expect(f.store.read()?.phase).toBe('staged');
  },
);

it('blocks unknown records and owners still holding supposedly ended bindings', async () => {
  const f = fixture();
  const unknown = randomUUID();
  mkdirSync(join(f.home, 'runtimes', unknown));
  f.binding.state = 'exited';
  const claim = acquireHostClaim(f.home, `runtime:${f.binding.runtime_id}`);
  try {
    const result = await f.inspect();
    expect(result.blockers).toContainEqual({ code: 'runtime_inventory_unknown', target: unknown });
    expect(result.blockers).toContainEqual({
      code: 'runtime_inventory_unknown',
      target: f.binding.runtime_id,
    });
  } finally {
    claim.release();
  }
});

it('rejects an inventory that gains a runtime while owners are being inspected', async () => {
  const f = fixture();
  f.request.mockImplementationOnce(async () => {
    const id = randomUUID();
    f.bindings.set(id, { ...f.binding, runtime_id: id });
    return { t: 'state', state: f.state } as RuntimeResponse;
  });
  expect((await f.inspect()).blockers).toContainEqual({
    code: 'runtime_inventory_unknown',
    target: 'inventory',
  });
});

it('checks the installed default, cockpit and active connector independently', async () => {
  const candidate = hostReleaseCapabilities('0.4.0');
  candidate.application.major++;
  candidate.remote++;
  candidate.supported_runtime_majors = [2];
  const f = fixture('daemon', candidate);
  expect((await f.inspect(f.current.remote)).blockers.map((b) => b.code)).toEqual(
    expect.arrayContaining([
      'cockpit_incompatible',
      'connector_incompatible',
      'runtime_default_incompatible',
      'runtime_incompatible',
    ]),
  );
  expect((await f.inspect()).blockers.map((b) => b.code)).not.toContain('connector_incompatible');
});

it('changes only the future runtime default without requiring adoption of current owners', async () => {
  const f = fixture('runtime');
  f.clients.clear();
  expect((await f.inspect()).blockers).toEqual([]);
  expect(f.request).not.toHaveBeenCalled();
  const candidate = hostReleaseCapabilities('0.4.0');
  candidate.runtime.major = 2;
  expect((await fixture('runtime', candidate).inspect()).blockers).toContainEqual({
    code: 'runtime_default_incompatible',
    target: 'runtime',
  });
});

import { expect, it, vi } from 'vitest';
import { hostUpdateCatalogue } from '../../../src/updates/catalogue/inventory.js';
import type { RuntimeBinding } from '../../../src/db/stores/runtimes.js';
import type { RuntimeClient } from '../../../src/runtime/transport/client.js';

function binding(
  id: string,
  state: RuntimeBinding['state'] = 'running',
  build = '0.4.0',
): RuntimeBinding {
  return {
    runtime_id: id,
    incarnation: 'incarnation',
    launch_id: 'launch',
    launch_fingerprint: 'hash',
    profile_id: 'profile',
    project_id: 'project',
    launch_session_id: 'placement',
    active_session_id: 'placement',
    active_segment_id: null,
    account_id: null,
    agent_type: null,
    canonical_worktree_path: '/private/project',
    conversation_id: null,
    build,
    protocol_major: 1,
    protocol_minor: 0,
    release_path: '/private/release',
    state,
    event_cursor: 0,
    created_at: '2026-11-04T12:00:00Z',
    ended_at: null,
  };
}
function fixture(rows: RuntimeBinding[]) {
  const live = vi.fn(() => rows);
  // Presence alone is consumed; no provider/runtime calls belong in catalogue inventory.
  const client = {} as RuntimeClient;
  const get = vi.fn((id: string) => (id === 'available' ? client : null));
  return {
    home: '/missing/puddle',
    version: '0.4.37',
    runtimes: { live },
    connections: { get },
    installed: () => ({
      releasePath: '/private/release',
      nodePath: '/private/node',
      entryPath: '/private/runtime',
      build: '0.4.2',
      protocol: { major: 1, minor: 3 },
    }),
    releases: {
      read: () => ({
        repository: null,
        state: 'unconfigured' as const,
        checked_at: null,
        succeeded_at: null,
        latest: null,
      }),
    },
  };
}

it('groups existing runtime builds without conflating installed defaults or unavailable owners', () => {
  const deps = fixture([
    binding('available'),
    binding('starting', 'prepared'),
    binding('missing', 'running', '0.3.14'),
  ]);
  const result = hostUpdateCatalogue(deps);
  expect(result).toMatchObject({
    daemon_version: '0.4.37',
    runtime_default: { version: '0.4.2', protocol: { major: 1, minor: 3 } },
    runtimes: {
      complete: true,
      versions: [
        { version: '0.3.14', running: 0, starting: 0, unavailable: 1 },
        { version: '0.4.0', running: 1, starting: 1, unavailable: 0 },
      ],
    },
  });
  expect(deps.runtimes.live).toHaveBeenCalledExactlyOnceWith(4097);
  expect(deps.connections.get).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(result)).not.toMatch(/private|placement|profile|project|runtime_id/);
});

it('reports missing selection and unreadable inventory as unknown, never as a complete empty host', () => {
  const deps = fixture([]);
  deps.installed = () => {
    throw new Error('Selection unavailable');
  };
  deps.runtimes.live.mockImplementation(() => {
    throw new Error('Database unavailable');
  });
  expect(hostUpdateCatalogue(deps)).toMatchObject({
    runtime_default: null,
    runtimes: { complete: false, versions: [] },
  });
});

it('bounds both binding reads and distinct build groups and marks truncation', () => {
  const deps = fixture(Array.from({ length: 4097 }, (_, id) => binding(String(id))));
  expect(hostUpdateCatalogue(deps).runtimes).toMatchObject({
    complete: false,
    versions: [{ unavailable: 4096 }],
  });
  deps.runtimes.live.mockReturnValue(
    Array.from({ length: 129 }, (_, id) => binding(String(id), 'prepared', `0.4.${id}`)),
  );
  const result = hostUpdateCatalogue(deps);
  expect(result.runtimes.complete).toBe(false);
  expect(result.runtimes.versions).toHaveLength(128);
});

import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { HUDDLE_RUNTIME_CAPABILITIES, huddleOwnerLaunchSchema } from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { huddleLedgerFixture } from '../../helpers/huddle/ledger.js';
import { runtimeDirectory } from '../../../src/runtime/ownership/storage.js';
import { runtimeServiceName } from '../../../src/runtime/lifecycle/supervisor.js';
import {
  recordHuddleContainment,
  hasHuddleContainment,
  requireHuddleDescendantsEnded,
} from '../../../src/runtime/huddle/recovery/containment.js';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    realpathSync: vi.fn(fs.realpathSync),
    statSync: vi.fn(fs.statSync),
    statfsSync: vi.fn(fs.statfsSync),
    openSync: vi.fn(fs.openSync),
    readlinkSync: vi.fn(fs.readlinkSync),
  };
});

it('captures the exact kernel scope before work and refuses surviving descendants or changed provenance', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  const f = huddleLedgerFixture();
  const originalProcess = process;
  try {
    vi.stubGlobal(
      'process',
      new Proxy(originalProcess, {
        get: (object, key) => (key === 'platform' ? 'linux' : Reflect.get(object, key)),
      }),
    );
    const identity = {
      runtime_id: f.identity.runtimeId,
      incarnation: randomUUID(),
      launch_id: randomUUID(),
      profile_id: f.identity.profileId,
      project_id: f.identity.projectId,
      session_id: f.identity.sessionId,
      canonical_worktree_path: actual.realpathSync(f.home),
    };
    const launch = huddleOwnerLaunchSchema.parse({
      format: 1,
      role: 'huddle',
      contract: 1,
      capabilities: HUDDLE_RUNTIME_CAPABILITIES,
      identity,
      scope: f.identity,
      secret: randomBytes(32).toString('hex'),
      build: 'fixture',
      boot_id: randomUUID(),
      lifetime: 'service',
      initial: {
        id: randomUUID(),
        revision: 'a'.repeat(64),
        worktree: identity.canonical_worktree_path,
        variables: {},
        bindings: {},
      },
    });
    const name = runtimeServiceName(f.home, identity, 'systemd');
    const path = `/user.slice/${name}`;
    const kernel = actual.realpathSync(f.home) + '/kernel';
    actual.mkdirSync(kernel + path, { recursive: true });
    actual.writeFileSync(join(kernel, 'membership'), `0::${path}\n`);
    actual.writeFileSync(kernel + path + '/cgroup.procs', `${process.pid}\n`);
    actual.writeFileSync(kernel + path + '/cgroup.events', 'populated 1\nfrozen 0\n');
    const mapped = (path: fs.PathLike) =>
      String(path).startsWith('/sys/fs/cgroup')
        ? String(path).replace('/sys/fs/cgroup', kernel)
        : String(path) === '/proc/self/cgroup'
          ? join(kernel, 'membership')
          : path;
    vi.mocked(fs.openSync).mockImplementation((path, flags, mode) =>
      actual.openSync(mapped(path), flags, mode),
    );
    vi.mocked(fs.statSync).mockImplementation(((path, options) =>
      actual.statSync(mapped(path), options)) as typeof fs.statSync);
    vi.mocked(fs.realpathSync).mockImplementation(((path, options) => {
      const result = actual.realpathSync(mapped(path), options);
      return typeof result === 'string' ? result.replace(kernel, '/sys/fs/cgroup') : result;
    }) as typeof fs.realpathSync);
    vi.mocked(fs.statfsSync).mockImplementation(((path, options) => {
      const result = actual.statfsSync(mapped(path), options);
      return String(path) === '/sys/fs/cgroup' ? { ...result, type: 0x63677270 } : result;
    }) as typeof fs.statfsSync);
    vi.mocked(fs.readlinkSync).mockImplementation(((path, options) =>
      String(path) === '/proc/self/ns/cgroup'
        ? 'cgroup:[42]'
        : actual.readlinkSync(path, options)) as typeof fs.readlinkSync);
    const directory = runtimeDirectory(f.home, identity.runtime_id);
    atomicPrivateJson(join(directory, 'supervisor.json'), {
      format: 1,
      identity,
      kind: 'systemd',
      name,
      domain: null,
      node_path: process.execPath,
      entry_path: '/fixture/puddler.js',
      state: 'dispatched',
    });
    recordHuddleContainment(f.home, launch);
    expect(hasHuddleContainment(f.home, launch)).toBe(true);
    // Parent absence alone is deliberately irrelevant: a surviving grandchild keeps populated=1.
    actual.writeFileSync(kernel + path + '/cgroup.procs', '999999\n');
    expect(() => requireHuddleDescendantsEnded(f.home, launch)).toThrow('descendants');
    actual.writeFileSync(kernel + path + '/cgroup.events', 'populated 0\nfrozen 0\n');
    const proof = requireHuddleDescendantsEnded(f.home, launch);
    expect(proof.identity).toEqual(identity);
    expect(() => requireHuddleDescendantsEnded(f.home, launch, { ...proof, inode: '0' })).toThrow(
      'provenance',
    );
    expect(() =>
      requireHuddleDescendantsEnded(f.home, { ...launch, boot_id: randomUUID() }),
    ).toThrow('provenance');
    // Removal of the verified kernel cgroup is also positive empty-scope evidence.
    actual.rmSync(kernel + path, { recursive: true });
    expect(requireHuddleDescendantsEnded(f.home, launch, proof)).toEqual(proof);
    vi.mocked(fs.readlinkSync).mockReturnValue('cgroup:[43]');
    expect(hasHuddleContainment(f.home, launch)).toBe(false);
    expect(() => requireHuddleDescendantsEnded(f.home, launch, proof)).toThrow('namespace');
  } finally {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
    f.cleanup();
  }
});

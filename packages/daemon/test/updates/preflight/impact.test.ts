import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { HostUpdateImpact } from '../../../src/updates/preflight/impact.js';
import { fixture, waitFor } from '../../helpers/daemon-fixtures.js';
import { candidateFixture } from './helpers.js';

function inventories() {
  return {
    controller: randomUUID(),
    ptys: { interruptionInventory: vi.fn(() => []) },
    notebooks: { interruptionInventory: vi.fn(() => []) },
    compilation: { interruptionInventory: vi.fn(() => []) },
    puddlang: { interruptionInventory: vi.fn(() => []) },
  };
}

it('changing only the runtime default never interrupts daemon-owned work', () => {
  const f = candidateFixture('runtime');
  const deps = inventories();
  // No provider inspection or side effect is needed for a default-only change.
  for (const key of ['ptys', 'notebooks', 'compilation', 'puddlang'] as const)
    deps[key].interruptionInventory.mockImplementation(() => {
      throw new Error('must not inspect');
    });
  expect(new HostUpdateImpact(deps).inspect(f.operation)).toMatchObject({
    requiresInterruption: false,
    affected: { terminals: [], notebooks: [], compilation: [], programmes: [] },
  });
});

it('inventories actual legacy and login PTYs without stopping them or trusting session status', async () => {
  const staged = candidateFixture();
  const f = fixture();
  try {
    const deps = { ...inventories(), ptys: f.ptys };
    const impact = new HostUpdateImpact(deps);
    const empty = impact.inspect(staged.operation);
    const session = await f.service.create({ project_id: f.ids.project, kind: 'terminal' });
    const login = `login-${f.ids.account}`;
    f.ptys.spawn(login, 'agent', '/bin/cat', [], { cwd: f.paths.home, record: false });
    const live = impact.inspect(staged.operation);
    expect(live.requiresInterruption).toBe(true);
    expect(live.fingerprint).not.toBe(empty.fingerprint);
    expect(live.affected.terminals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stream: session.id, term: 'agent' }),
        expect.objectContaining({ stream: login, term: 'agent' }),
      ]),
    );
    expect(f.ptys.liveCount()).toBe(2);
    expect(impact.inspect(staged.operation).fingerprint).toBe(live.fingerprint);
    const old = live.affected.terminals.find((item) => item.stream === login)!;
    f.ptys.kill(login, 'agent');
    await waitFor(() => !f.ptys.has(login, 'agent'));
    f.ptys.spawn(login, 'agent', '/bin/cat', [], { cwd: f.paths.home, record: false });
    const replacement = impact.inspect(staged.operation);
    expect(replacement.fingerprint).not.toBe(live.fingerprint);
    expect(replacement.affected.terminals.find((item) => item.stream === login)!.instance).not.toBe(
      old.instance,
    );
  } finally {
    f.service.beginShutdown();
    f.ptys.killAll();
    await waitFor(() => f.ptys.liveCount() === 0);
    await f.ptys.closeTerminalStates();
    f.onboarding.dispose();
    f.logs.closeAll();
  }
});

it('fingerprints idle kernels, watchers and programme runners, with stable inventory ordering', () => {
  const f = candidateFixture();
  const deps = {
    ...inventories(),
    notebooks: {
      interruptionInventory: () => [
        {
          instance: 'kernel',
          revision: 1,
          path: '/notebook',
          kernel: 'python3',
          state: 'idle' as const,
          busy: false,
          changing: false,
        },
      ],
    },
    compilation: {
      interruptionInventory: () => [
        {
          instance: 'watcher',
          source: { session: randomUUID(), path: 'main.tex' },
          provider: 'latex',
          revision: 1,
          running: false,
          watching: true,
          terminal_launch: false,
        },
      ],
    },
    puddlang: { interruptionInventory: () => [{ id: 'one' }, { id: 'two' }] },
  };
  // A real target keeps its immutable source selection across observations.
  const compilation = deps.compilation.interruptionInventory();
  deps.compilation.interruptionInventory = () => compilation;
  const impact = new HostUpdateImpact(deps);
  const first = impact.inspect(f.operation);
  expect(first.requiresInterruption).toBe(true);
  expect(first.affected.terminals).toEqual([]);
  deps.puddlang.interruptionInventory = () => [{ id: 'two' }, { id: 'one' }];
  expect(impact.inspect(f.operation).fingerprint).toBe(first.fingerprint);
  compilation[0]!.revision += 1;
  expect(impact.inspect(f.operation).fingerprint).not.toBe(first.fingerprint);
  expect(
    new HostUpdateImpact({ ...deps, controller: randomUUID() }).inspect(f.operation).fingerprint,
  ).not.toBe(impact.inspect(f.operation).fingerprint);
});

it('fails closed when an inventory is unavailable or exceeds the bound', () => {
  const f = candidateFixture();
  const deps = inventories();
  deps.notebooks.interruptionInventory.mockImplementation(() => {
    throw new Error('unavailable');
  });
  expect(() => new HostUpdateImpact(deps).inspect(f.operation)).toThrow('unavailable');
  expect(() =>
    new HostUpdateImpact({
      ...inventories(),
      puddlang: {
        interruptionInventory: () => Array.from({ length: 4097 }, () => ({ id: randomUUID() })),
      },
    }).inspect(f.operation),
  ).toThrow('exceeds limit');
});

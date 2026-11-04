import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, onTestFinished, vi } from 'vitest';
import type { RepoStore } from '../../src/db/stores/repos.js';
import type { SessionStore } from '../../src/db/stores/sessions.js';
import { NO_SESSION } from '../../src/http/routes/worktrees/worktree-shared.js';
import { NotebookKernels } from '../../src/notebooks/kernels.js';

const bridge = vi.hoisted(() => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }
  class FakeBridge {
    readonly discovery = deferred<[]>();
    readonly result = deferred<{ ok: boolean }>();
    readonly ready = this.discovery.promise;
    closed = false;
    readonly request = vi.fn((_message: Record<string, unknown>) => this.result.promise);
    readonly close = vi.fn(async () => {
      this.closed = true;
      this.discovery.reject(new Error('Bridge closed'));
      this.result.reject(new Error('Bridge closed'));
    });
    constructor() {
      // Either phase may not be awaited when shutdown wins the startup race.
      void this.ready.catch(() => {});
      void this.result.promise.catch(() => {});
      instances.push(this);
    }
  }
  const instances: FakeBridge[] = [];
  return { FakeBridge, instances };
});

vi.mock('../../src/notebooks/kernel-bridge.js', () => ({ KernelBridge: bridge.FakeBridge }));
vi.mock('../../src/code/discovery.js', () => ({ findCodeExecutable: () => '/fixture/python3' }));

function fixture() {
  bridge.instances.length = 0;
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'puddle-notebook-maintenance-')));
  const source = { session: NO_SESSION, root, path: 'example.ipynb' };
  writeFileSync(join(root, source.path), '{}');
  const kernels = new NotebookKernels({ sessions: {} as SessionStore, repos: {} as RepoStore });
  onTestFinished(async () => {
    await kernels.dispose();
    rmSync(root, { recursive: true, force: true });
  });
  return { kernels, source };
}

it('drains kernel startup through dispatch, retaining submitted cells and rejecting new commands', async () => {
  const { kernels, source } = fixture();
  await kernels.executeCells({ source, cells: [{ id: 'accepted', source: 'value = 41' }] });
  const owner = bridge.instances[0]!;
  const hold = kernels.pause();
  await expect(hold.drain(20)).rejects.toThrow('did not drain');
  expect(owner.request).not.toHaveBeenCalled();
  expect(kernels.interruptionInventory()).toMatchObject([{ busy: true }]);
  owner.discovery.resolve([]);
  await hold.drain();
  expect(owner.request).toHaveBeenCalledTimes(1);
  expect(owner.close).not.toHaveBeenCalled();
  expect((await kernels.executionStatus(source)).execution?.state).toBe('running');
  for (const action of [
    () => kernels.executeCells({ source, cells: [{ id: 'later', source: 'value = 0' }] }),
    () => kernels.action({ source, action: 'restart' }),
    () => kernels.intelligence({ source, kind: 'complete', code: 'val', cursor: 3 }),
    () => kernels.catalogue(),
  ])
    await expect(action()).rejects.toMatchObject({ code: 'host_maintenance' });
  owner.result.resolve({ ok: true });
  await expect
    .poll(async () => (await kernels.executionStatus(source)).execution?.state)
    .toBe('succeeded');
  expect(kernels.interruptionInventory()).toMatchObject([{ busy: false }]);
  hold.release();
  await kernels.executeCells({ source, cells: [{ id: 'next', source: 'value + 1' }] });
  await expect.poll(() => owner.request.mock.calls.length).toBe(2);
  expect(bridge.instances).toHaveLength(1);
  expect(owner.request.mock.calls.map(([request]) => request.cells)).toEqual([
    [{ id: 'accepted', source: 'value = 41' }],
    [{ id: 'next', source: 'value + 1' }],
  ]);
});

it.each(['failure', 'shutdown'] as const)(
  'settles admitted startup after %s without dispatch or reopening a closed service',
  async (outcome) => {
    const { kernels, source } = fixture();
    await kernels.executeCells({ source, cells: [{ id: 'unsent', source: 'print(1)' }] });
    const owner = bridge.instances[0]!;
    const hold = kernels.pause();
    if (outcome === 'failure') owner.discovery.reject(new Error('Discovery failed'));
    else await kernels.dispose();
    await hold.drain();
    expect(owner.request).not.toHaveBeenCalled();
    hold.release();
    if (outcome === 'shutdown') {
      await expect(
        kernels.executeCells({ source, cells: [{ id: 'late', source: '1' }] }),
      ).rejects.toMatchObject({ code: 'host_maintenance' });
      expect(owner.closed).toBe(true);
    } else {
      expect((await kernels.executionStatus(source)).execution).toMatchObject({
        state: 'failed',
        error: 'Discovery failed',
      });
    }
  },
);

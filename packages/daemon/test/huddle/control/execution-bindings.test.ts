import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { huddleExecutionBindings } from '../../../src/huddle/execution/bindings.js';
import { huddleHostIdentity } from '../../../src/huddle/execution/host.js';
import { schedulerSnapshot } from '../../helpers/huddle/scheduler.js';
import { initialisePrivateHome } from '@puddle/shared/node';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function home() {
  const path = mkdtempSync(join(tmpdir(), 'puddle-huddle-bindings-'));
  homes.push(path);
  initialisePrivateHome(path);
  return path;
}

it('resolves explicit worktree variables to registered canonical roots and rejects unrelated paths', () => {
  const directory = home();
  const alias = `${directory}-alias`;
  symlinkSync(directory, alias);
  const snapshot = schedulerSnapshot('a'.repeat(32), '');
  snapshot.definition.variables = { tree: { schema: { type: 'string' }, required: true } };
  snapshot.definition.nodes.find((node) => node.id === 'worker')!.parameters = {
    worktree: { kind: 'variable', name: 'tree' },
  };
  snapshot.components.worker!.parameters = {
    worktree: { schema: { type: 'string' }, required: true, editor: 'worktree' },
  };
  try {
    const canonical = realpathSync(directory);
    // realpath is used by admission, regardless of the caller's alias spelling.
    const roots = [directory, canonical];
    expect(huddleExecutionBindings(snapshot, { tree: alias }, roots)).toEqual({
      worker: { worktree: canonical },
    });
    expect(() => huddleExecutionBindings(snapshot, { tree: alias }, [])).toThrow('not registered');
    expect(() => huddleExecutionBindings(snapshot, { tree: '.' }, roots)).toThrow('absolute');
    expect(() => huddleExecutionBindings(snapshot, {}, roots)).toThrow('Missing huddle variable');
  } finally {
    rmSync(alias);
  }
});

it('refuses bridge and adapter features before execution and validates variables even in an empty graph', () => {
  const snapshot = schedulerSnapshot('a'.repeat(32), '');
  snapshot.components.worker!.capabilities = ['sessions'];
  expect(() => huddleExecutionBindings(snapshot, {}, [])).toThrow('bridge');
  snapshot.components.worker!.capabilities = [];
  snapshot.components.worker!.category = 'readout';
  expect(() => huddleExecutionBindings(snapshot, {}, [])).toThrow('adapters');
  snapshot.definition.nodes = [];
  snapshot.definition.variables = { required: { schema: { type: 'boolean' }, required: true } };
  expect(() => huddleExecutionBindings(snapshot, {}, [])).toThrow('Missing huddle variable');
  expect(() => huddleExecutionBindings(snapshot, { required: 'wrong' }, [])).toThrow(
    'Invalid huddle variable',
  );
  expect(() => huddleExecutionBindings(snapshot, { extra: false }, [])).toThrow(
    'Unknown huddle variable',
  );
  expect(huddleExecutionBindings(snapshot, { required: false }, [])).toEqual({});
});

it('keeps installation identity across controllers and refuses corrupt or symlinked records', () => {
  const first = home();
  const second = home();
  const id = huddleHostIdentity(first);
  expect(huddleHostIdentity(first)).toBe(id);
  expect(huddleHostIdentity(second)).not.toBe(id);
  writeFileSync(join(first, 'huddle-host.json'), '{broken');
  expect(() => huddleHostIdentity(first)).toThrow();
  rmSync(join(first, 'huddle-host.json'));
  symlinkSync(join(second, 'huddle-host.json'), join(first, 'huddle-host.json'));
  expect(() => huddleHostIdentity(first)).toThrow();
});

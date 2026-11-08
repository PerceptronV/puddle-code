import { expect, it } from 'vitest';
import { compareHuddleRevisions } from '../../../../src/huddle/execution/review/compare.js';
import { schedulerSnapshot } from '../../../helpers/huddle/scheduler.js';

it('reports added, removed, unchanged and modified entries, including empty and Unicode source', () => {
  const a = schedulerSnapshot('a'.repeat(32), 'export default "old";');
  a.files['empty.txt'] = '';
  a.files['removed.ts'] = 'removed';
  const b = structuredClone(a);
  b.files['nodes/example/run.ts'] = 'export default "é";';
  b.files['added.ts'] = 'added';
  delete b.files['removed.ts'];
  b.components['worker']!.title = 'New contract';
  const result = compareHuddleRevisions(a, b, { kind: 'file', path: 'nodes/example/run.ts' });
  const file = (path: string) =>
    result.entries.find((item) => item.entry.kind === 'file' && item.entry.path === path)!;
  expect(file('empty.txt')).toMatchObject({
    change: 'unchanged',
    before: { bytes: 0 },
    after: { bytes: 0 },
  });
  expect(file('added.ts')).toMatchObject({ change: 'added', before: null });
  expect(file('removed.ts')).toMatchObject({ change: 'removed', after: null });
  expect(file('nodes/example/run.ts')).toMatchObject({
    change: 'modified',
    after: { bytes: Buffer.byteLength(b.files['nodes/example/run.ts']!) },
  });
  expect(result.content?.before).toBe(a.files['nodes/example/run.ts']);
  expect(result.content?.after).toBe(b.files['nodes/example/run.ts']);
  expect(
    result.entries.find((item) => item.entry.kind === 'component' && item.entry.path === 'worker')
      ?.change,
  ).toBe('modified');
  expect(compareHuddleRevisions(a, b, { kind: 'file', path: 'empty.txt' }).content).toMatchObject({
    before: '',
    after: '',
  });
  expect(compareHuddleRevisions(a, b, { kind: 'file', path: 'removed.ts' }).content).toMatchObject({
    before: 'removed',
    after: null,
  });
});
it('canonicalises contracts and sorts the inventory without reordering exact source bytes', () => {
  const a = schedulerSnapshot('a'.repeat(32), 'source');
  const b = structuredClone(a);
  b.components['worker'] = Object.fromEntries(
    Object.entries(b.components['worker']!).reverse(),
  ) as (typeof b.components)['worker'];
  expect(compareHuddleRevisions(a, b).entries.every((entry) => entry.change === 'unchanged')).toBe(
    true,
  );
  expect(() => compareHuddleRevisions(a, b, { kind: 'file', path: 'not-captured' })).toThrow(
    'closure',
  );
});

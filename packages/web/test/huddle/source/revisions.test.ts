import { expect, it } from 'vitest';
import {
  huddleDraftBaselineSchema,
  restoreHuddleDraftBaseline,
  desktopBufferSnapshotSchema,
  uiStateSnapshotSchema,
  type DesktopWorkspaceContent,
} from '@puddle/shared';
import {
  capturedSource,
  sourceHash,
  followsOwnWrite,
} from '../../../src/features/huddle/documents/source/revision';
import {
  afterOwnWrites,
  acknowledgeSourceWrite,
  queueSourceWrite,
} from '../../../src/features/huddle/documents/source/writes';
import { huddleDocumentSchema, huddleRevisionContent } from '@puddle/shared';
import { SavedStateMap } from '../../../src/features/editor/buffers/buffer-logic';
import { draftDisposition } from '../../../src/lib/persistence/drafts';
import { mergeWindowBuffers } from '../../../src/features/windows/transfers/content/merge-buffers';
import { assertDraftsRetained } from '../../../../desktop/src/windows/persistence/drafts';

const hash = (char: string) => char.repeat(64);
const target = {
  project_id: '0000000002',
  worktree: '/repo',
  huddle_id: 'a'.repeat(32),
  profile: '0000000001',
  scope: 'host',
};
const baseline = huddleDraftBaselineSchema.parse({
  ...target,
  format: 1,
  digest: hash('a'),
  files: { 'huddle.json': hash('b'), 'layout.json': hash('c'), 'run.ts': hash('d') },
  components: {},
});
const next = {
  ...baseline,
  digest: hash('e'),
  files: { ...baseline.files, 'huddle.json': hash('f') },
};

it('verifies exact captured bytes before constructing recovery metadata', async () => {
  const files = {
    'huddle.json': JSON.stringify({
      format: 1,
      id: target.huddle_id,
      name: 'Test',
      nodes: [],
      edges: [],
    }),
  };
  const document = huddleDocumentSchema.parse({
    definition: JSON.parse(files['huddle.json']),
    digest: await sourceHash(huddleRevisionContent(files, {})),
    components: {},
    diagnostics: [],
  });
  const result = await capturedSource(target, { document, files });
  expect(result.baseline.files['huddle.json']).toBe(await sourceHash(files['huddle.json']));
  expect(JSON.stringify(result.baseline)).not.toContain('"name"');
  await expect(
    capturedSource(target, { document, files: { 'huddle.json': files['huddle.json'] + '\n' } }),
  ).rejects.toThrow('digest');
});

it('preserves text when a native draft has missing, unknown or malformed metadata', () => {
  const draft = { session: 's', path: 'huddle.json', content: 'unsaved', baseMtimeMs: 0 };
  expect(
    desktopBufferSnapshotSchema.parse({ ...draft, baseRevision: baseline }).baseRevision,
  ).toEqual(baseline);
  for (const value of [
    undefined,
    {},
    { ...baseline, format: 2 },
    { ...baseline, files: {} },
    { ...baseline, scope: '' },
    { ...baseline, files: { '../bad': hash('a') } },
  ]) {
    expect(restoreHuddleDraftBaseline(value)).toBeUndefined();
    expect(desktopBufferSnapshotSchema.parse({ ...draft, baseRevision: value })).toEqual({
      ...draft,
      baseRevision: undefined,
    });
  }
});

it('uses full baseline identity for restore and keeps already typed content dirty', () => {
  const draft = { content: 'draft', base_mtime_ms: 0, baseRevision: baseline };
  expect(draftDisposition(draft, 'saved', 0, baseline)).toBe('restore');
  expect(draftDisposition(draft, 'saved', 0, next)).toBe('offer');
  expect(draftDisposition({ ...draft, baseRevision: undefined }, 'saved', 0, next)).toBe('offer');
  expect(draftDisposition(draft, 'draft', 0, next)).toBe('discard');
  const state = new SavedStateMap();
  state.mark('file', 1, 0, next);
  state.baseline('file', 0, baseline);
  expect(state.isDirty('file', 2)).toBe(true);
  state.rekey('file', 'renamed');
  expect(state.revision('renamed')).toEqual(baseline);
  state.mark('renamed', 2, 0, next);
  expect(state.isDirty('renamed', 3)).toBe(true);
});

it('advances only sibling drafts through acknowledged writes, never the edited file', () => {
  acknowledgeSourceWrite(baseline, next, 'huddle.json');
  expect(afterOwnWrites(baseline, 'layout.json')).toEqual(next);
  expect(afterOwnWrites(baseline, 'huddle.json')).toEqual(baseline);
  const external = { ...next, files: { ...next.files, 'run.ts': hash('e') } };
  expect(followsOwnWrite(baseline, external, 'huddle.json')).toBe(false);
  expect(followsOwnWrite(baseline, { ...next, scope: 'other' }, 'huddle.json')).toBe(false);
  expect(
    followsOwnWrite(baseline, { ...baseline, components: { node: hash('a') } }, 'layout.json'),
  ).toBe(false);
});

it('serialises writes without retrying a rejection or poisoning later work', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const order: number[] = [];
  const first = queueSourceWrite('test-queue', async () => {
    order.push(1);
    await held;
    throw Error('lost reply');
  });
  const failure = expect(first).rejects.toThrow('lost reply');
  const second = queueSourceWrite('test-queue', async () => {
    order.push(2);
    return 42;
  });
  await Promise.resolve();
  expect(order).toEqual([1]);
  release();
  await failure;
  expect(await second).toBe(42);
  expect(order).toEqual([1, 2]);
});

it('does not merge or discard identical text that carries different reviewed baselines', () => {
  const content = (baseRevision = baseline): DesktopWorkspaceContent => ({
    snapshot: uiStateSnapshotSchema.parse({}),
    views: {},
    buffers: [
      { session: 's', path: 'huddle.json', content: 'draft', baseMtimeMs: 0, baseRevision },
    ],
  });
  expect(mergeWindowBuffers(content(), content())).toHaveLength(1);
  expect(() => mergeWindowBuffers(content(), content(next))).toThrow('different unsaved edits');
  expect(() => assertDraftsRetained(content(), [content(next)])).toThrow('discard');
  expect(() => assertDraftsRetained(content(), [content()])).not.toThrow();
});

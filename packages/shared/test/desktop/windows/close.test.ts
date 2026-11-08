import { expect, it } from 'vitest';
import {
  desktopPaneCloseReview,
  desktopWorkspaceContentSchema,
  type TabRef,
} from '../../../src/index.js';

const file: TabRef = {
  type: 'editor',
  tab: { session: '00000000-0000-4000-8000-000000000001', path: 'file.txt' },
};
const terminal: TabRef = { type: 'terminal', session: '00000000-0000-4000-8000-000000000001' };
const snapshot = (tabs: TabRef[]) => ({
  layout_tree: { kind: 'leaf', id: 'pane', tabs, activeKey: null },
});
const buffer = {
  session: '00000000-0000-4000-8000-000000000001',
  path: 'file.txt',
  content: 'unsaved',
  baseMtimeMs: 1,
};

it('permits closing clean file and terminal views, but always reviews untitled drafts', () => {
  expect(
    desktopPaneCloseReview(
      desktopWorkspaceContentSchema.parse({ snapshot: snapshot([file, terminal]) }),
    ).required,
  ).toBe(false);
  const untitled: TabRef = {
    type: 'editor',
    tab: {
      session: '00000000-0000-4000-8000-000000000001',
      path: 'untitled-1.md',
      kind: 'untitled',
    },
  };
  const review = desktopPaneCloseReview(
    desktopWorkspaceContentSchema.parse({ snapshot: snapshot([untitled]) }),
  );
  expect(review.targets).toEqual([{ paneId: 'pane', ref: untitled }]);
  expect(review.required).toBe(true);
});

it('retains orphaned or differently rooted drafts instead of treating unrelated tabs as review', () => {
  const content = desktopWorkspaceContentSchema.parse({
    snapshot: snapshot([file]),
    buffers: [{ ...buffer, root: '/another-root' }],
  });
  expect(desktopPaneCloseReview(content)).toEqual({ targets: [], orphaned: 1, required: true });
  content.buffers = [buffer];
  expect(desktopPaneCloseReview(content)).toEqual({
    targets: [{ paneId: 'pane', ref: file }],
    orphaned: 0,
    required: true,
  });
});

it('reviews the authoritative project layout and does not let commit views consume dirty text', () => {
  const content = desktopWorkspaceContentSchema.parse({
    snapshot: {
      ...snapshot([file]),
      layout_mode: 'project',
      project_layouts: {
        '0000000001': {
          layout_tree: {
            kind: 'leaf',
            id: 'project-pane',
            tabs: [{ type: 'editor', tab: { ...file.tab, kind: 'commit', sha: 'abc' } }],
            activeKey: null,
          },
        },
      },
    },
    buffers: [buffer],
  });
  expect(desktopPaneCloseReview(content)).toEqual({ targets: [], orphaned: 1, required: true });
});

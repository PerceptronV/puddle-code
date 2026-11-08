import { expect, it } from 'vitest';
import type { DesktopArrangementApplyRequest } from '@puddle/shared';
import { matchArrangementWindows } from '../../../src/windows/arrangements/matching.js';

const profileId = 'aaaaaaaaaa';
const projectId = '1111111111';
type Entry = Parameters<typeof matchArrangementWindows>[2][number];
const host: Entry = {
  record: { target: 'local', window: { kind: 'host', id: 'host' } },
  open: true,
  returnedProject: false,
  version: null,
};
const pane = (id: string): Entry => ({
  record: { target: 'local', window: { kind: 'pane', id, profileId, projectId } },
  open: true,
  returnedProject: false,
  version: null,
});
const slot = (key: string) => ({
  key,
  kind: 'pane' as const,
  project_id: projectId,
  layout_mode: 'profile' as const,
  layout_tree: null,
  active_session: null,
  project_layouts: {},
});
const request = (keys: string[]): DesktopArrangementApplyRequest => ({
  id: 'apply',
  profileId,
  scope: 'profile',
  arrangement: { version: 1, windows: keys.map(slot) },
});

it('reserves exact pane matches before assigning portable slots to remaining compatible windows', () => {
  const result = matchArrangementWindows('host', request(['portable', 'pane']), [
    host,
    pane('pane'),
    pane('other'),
  ]);
  expect(result.slots.find((slot) => slot.key === 'pane')!.identity.id).toBe('pane');
  expect(result.slots.find((slot) => slot.key === 'portable')!.identity.id).toBe('other');
  expect([...result.openIds].sort()).toEqual(['host', 'other', 'pane']);
});

it('reuses stable generated ids after cancelled native creation and scopes them to the host', () => {
  const first = matchArrangementWindows('host', request(['portable']), [host]);
  const created = first.entries.find((entry) => entry.record.window?.kind === 'pane')!;
  const second = matchArrangementWindows('host', request(['portable']), [host, created]);
  expect(second.slots).toEqual(first.slots);
  const remote = matchArrangementWindows('host', request(['portable']), [
    { ...host, record: { ...host.record, target: 'user@remote' } },
  ]);
  expect(remote.slots[0]!.identity.id).not.toBe(first.slots[0]!.identity.id);
});

it('keeps the unique returned project owner and native placement when reopening its saved slot', () => {
  const returned: Entry = {
    ...pane('returned'),
    record: {
      ...pane('returned').record,
      window: { kind: 'project', id: 'returned', profileId, projectId },
      placement: { bounds: { x: 10, y: 20, width: 900, height: 700 } },
    },
    open: false,
    returnedProject: true,
  };
  const config = request(['project-slot']);
  config.arrangement.windows[0]!.kind = 'project';
  const matched = matchArrangementWindows('host', config, [host, returned]);
  expect(matched.slots[0]!.identity.id).toBe('returned');
  expect(
    matched.entries.find((entry) => entry.record.window?.id === 'returned')!.record.placement,
  ).toEqual(returned.record.placement);
});

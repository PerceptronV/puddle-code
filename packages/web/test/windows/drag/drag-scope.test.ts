import { afterEach, expect, it, vi } from 'vitest';
import type { DesktopWindowContext } from '@puddle/shared';
import {
  encodeTabTransfer,
  decodeTabTransfer,
} from '../../../src/features/workspace/tabs/tab-transfer';
import { encodeDragPaths, decodeDragPaths } from '../../../src/features/explorer/explorer-paths';
import {
  encodeSessionDrag,
  decodeSessionDrag,
} from '../../../src/features/workspace/sessions/session-selection';

const state = vi.hoisted(() => ({
  context: null as DesktopWindowContext | null,
  profile: '1234567890',
  begin: vi.fn(async () => undefined),
}));
vi.mock('../../../src/features/windows/window-context', () => ({
  desktopWindowContext: () => state.context,
}));
vi.mock('../../../src/features/profile/profile-store', () => ({
  currentProfileId: () => state.profile,
}));
vi.mock('../../../src/lib/desktop', () => ({
  desktopBridge: () => ({ windows: { transfers: { beginTabDrag: state.begin } } }),
}));
vi.mock('../../../src/lib/transport/errors', () => ({ toastError: vi.fn() }));
const session = '00000000-0000-4000-8000-000000000001';
const ref = { type: 'editor' as const, tab: { session, path: 'draft.ts' } };
afterEach(() => {
  state.context = null;
  state.profile = '1234567890';
  vi.clearAllMocks();
});

it('keeps legacy browser drags and native same-window operations working', () => {
  expect(decodeTabTransfer(encodeTabTransfer(ref))).toEqual(ref);
  expect(decodeDragPaths(encodeDragPaths(['a', 'b']))).toEqual(['a', 'b']);
  expect(decodeSessionDrag(encodeSessionDrag([session]))).toEqual([session]);
  state.context = { identity: { kind: 'host', id: 'source' }, hostId: 'host' };
  const tab = encodeTabTransfer(ref, { projectId: 'abcdef1234' });
  expect(decodeTabTransfer(tab)).toEqual(ref);
  expect(decodeDragPaths(encodeDragPaths(['a']))).toEqual(['a']);
  expect(decodeSessionDrag(encodeSessionDrag([session]))).toEqual([session]);
  expect(state.begin).toHaveBeenCalledOnce();
  expect(JSON.parse(tab)).toMatchObject({
    sourceId: 'source',
    hostId: 'host',
    profileId: state.profile,
    ref,
  });
});

it('never interprets a foreign or unscoped drag as a local file move, archive or tab open', () => {
  state.context = { identity: { kind: 'host', id: 'source' }, hostId: 'host' };
  const tab = encodeTabTransfer(ref, { projectId: 'abcdef1234' });
  const files = encodeDragPaths(['dangerous-relative-path']);
  const sessions = encodeSessionDrag([session]);
  for (const context of [
    { identity: { kind: 'host' as const, id: 'destination' }, hostId: 'host' },
    { identity: { kind: 'host' as const, id: 'source' }, hostId: 'another-host' },
  ]) {
    state.context = context;
    expect(decodeTabTransfer(tab)).toBeNull();
    expect(decodeDragPaths(files)).toEqual([]);
    expect(decodeSessionDrag(sessions)).toEqual([]);
  }
  expect(decodeTabTransfer(JSON.stringify(ref))).toBeNull();
  expect(decodeDragPaths(JSON.stringify(['path']))).toEqual([]);
  expect(decodeSessionDrag(JSON.stringify([session]))).toEqual([]);
  state.context = { identity: { kind: 'host', id: 'source' }, hostId: 'host' };
  state.profile = '0000000000';
  expect(decodeTabTransfer(tab)).toBeNull();
  expect(decodeDragPaths(files)).toEqual([]);
  expect(decodeSessionDrag(sessions)).toEqual([]);
});

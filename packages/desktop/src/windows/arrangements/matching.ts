import { createHash } from 'node:crypto';
import type {
  DesktopArrangementApplyRequest,
  DesktopWindowIdentity,
  SavedWindowLayout,
} from '@puddle/shared';
import { reopenWindowId, type ReopenWindow } from '../../reopen.js';
import type { DesktopWindowState } from '../persistence/state.js';

type Entry = ReturnType<DesktopWindowState['arrangementEntries']>[number];

/** Logical saved keys only match candidates already admitted to this host/profile/scope. */
export function matchArrangementWindows(
  ownerId: string,
  request: DesktopArrangementApplyRequest,
  candidates: Entry[],
) {
  const host = candidates.find((entry) => reopenWindowId(entry.record) === ownerId);
  if (!host || host.record.window?.kind !== 'host')
    throw new Error('The host window is unavailable');
  const used = new Set([ownerId]);
  const slots = new Map<string, Entry>();
  const compatible = (entry: Entry, slot: SavedWindowLayout) => {
    const identity = entry.record.window;
    return (
      identity?.kind === slot.kind &&
      identity.kind !== 'host' &&
      identity.profileId === request.profileId &&
      identity.projectId === slot.project_id &&
      entry.record.target === host.record.target
    );
  };
  const stableId = (slot: SavedWindowLayout) =>
    `layout-${slot.kind}-${createHash('sha256')
      .update(
        JSON.stringify([
          host.record.target,
          request.profileId,
          slot.kind,
          slot.project_id,
          slot.kind === 'project' ? null : slot.key,
        ]),
      )
      .digest('hex')
      .slice(0, 32)}`;
  const claim = (slot: SavedWindowLayout, entry: Entry) => {
    slots.set(slot.key, entry);
    used.add(reopenWindowId(entry.record));
  };
  // Reserve exact matches before filling gaps, so a portable slot cannot steal
  // a later slot's native window. Dedicated project ownership takes precedence.
  for (const slot of request.arrangement.windows) {
    if (slot.kind === 'host') {
      claim(slot, host);
      continue;
    }
    const matching = candidates.filter(
      (entry) => !used.has(reopenWindowId(entry.record)) && compatible(entry, slot),
    );
    const entry =
      slot.kind === 'project'
        ? (matching.find((entry) => entry.open || entry.returnedProject) ??
          matching.find((entry) => reopenWindowId(entry.record) === stableId(slot)))
        : (matching.find((entry) => reopenWindowId(entry.record) === slot.key) ??
          matching.find((entry) => reopenWindowId(entry.record) === stableId(slot)));
    if (entry) claim(slot, entry);
  }
  for (const slot of request.arrangement.windows) {
    if (slots.has(slot.key)) continue;
    const existing = candidates.find(
      (entry) => entry.open && !used.has(reopenWindowId(entry.record)) && compatible(entry, slot),
    );
    if (existing) {
      claim(slot, existing);
      continue;
    }
    if (slot.kind === 'host' || !slot.project_id) throw new Error('Invalid detached window slot');
    const identity: DesktopWindowIdentity = {
      id: stableId(slot),
      kind: slot.kind,
      profileId: request.profileId,
      projectId: slot.project_id,
    };
    if (candidates.some((entry) => reopenWindowId(entry.record) === identity.id))
      throw new Error('A saved window slot conflicts with another window identity');
    const record: ReopenWindow = {
      target: host.record.target,
      window: identity,
      route: `/project/${slot.project_id}`,
    };
    claim(slot, { record, open: false, returnedProject: false, version: null });
  }
  const entries = new Map(
    candidates
      .filter(
        (entry) => entry.open || entry.returnedProject || reopenWindowId(entry.record) === ownerId,
      )
      .map((entry) => [reopenWindowId(entry.record), entry]),
  );
  for (const entry of slots.values()) entries.set(reopenWindowId(entry.record), entry);
  if (entries.size > 128) throw new Error('Too many windows in this layout arrangement');
  return {
    entries: [...entries.values()],
    slots: [...slots].map(([key, entry]) => ({ key, identity: entry.record.window! })),
    openIds: new Set([
      ownerId,
      ...[...slots.values()].map((entry) => reopenWindowId(entry.record)),
    ]),
  };
}

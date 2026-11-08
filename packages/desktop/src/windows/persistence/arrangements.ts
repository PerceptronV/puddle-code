import {
  desktopArrangementTransactionSchema,
  desktopArrangementOutcomeSchema,
  desktopWindowIdSchema,
  desktopWorkspaceVersionSchema,
  type DesktopArrangementTransaction,
  type DesktopWorkspaceContent,
  type DesktopWorkspaceVersion,
} from '@puddle/shared';
import { parseReopenWindows, reopenWindowId, type ReopenWindow } from '../../reopen.js';
import { assertDraftsRetained, bufferIdentity } from './drafts.js';
import type { WindowState } from './model.js';

export interface ArrangementChange {
  record: ReopenWindow;
  revision: number;
  content: DesktopWorkspaceContent;
  open: boolean;
}
export interface ArrangementRequest {
  id: string;
  ownerId: string;
  profileId: string;
  scope: 'profile' | 'project';
  projectId?: string;
  changes: ArrangementChange[];
}

function records(transaction: DesktopArrangementTransaction): ArrangementChange[] {
  // A retiring project and its staged replacement may share the project anchor;
  // only the committed open/returned set must have unique project ownership.
  const parsed = transaction.changes.flatMap((change) => parseReopenWindows([change.record]));
  if (
    parsed.length !== transaction.changes.length ||
    new Set(parsed.map(reopenWindowId)).size !== parsed.length
  )
    throw new Error('Invalid arrangement windows');
  return transaction.changes.map((change, index) => ({ ...change, record: parsed[index]! }));
}

/** Include closed returned projects, whose workspace still belongs to this profile. */
export function arrangementParticipants(
  state: WindowState,
  request: Pick<ArrangementRequest, 'ownerId' | 'profileId' | 'scope' | 'projectId'>,
  retained = false,
): string[] {
  const owner = state.entries[request.ownerId];
  if (!owner?.open || (owner.record.window && owner.record.window.kind !== 'host'))
    throw new Error('Manage window layouts from an open host window');
  if (
    !/^[0-9a-f]{10}$/.test(request.profileId) ||
    (request.scope === 'project'
      ? !/^[0-9a-f]{10}$/.test(request.projectId ?? '')
      : request.projectId !== undefined)
  )
    throw new Error('Invalid arrangement scope');
  return Object.entries(state.entries)
    .flatMap(([id, entry]) => {
      if (id === request.ownerId) return [id];
      const identity = entry.record.window;
      return entry.record.target === owner.record.target &&
        (retained || entry.open || entry.returnedProject) &&
        identity &&
        identity.kind !== 'host' &&
        identity.profileId === request.profileId &&
        (request.scope === 'profile' || identity.projectId === request.projectId)
        ? [id]
        : [];
    })
    .sort();
}

export function stagedArrangement(state: WindowState, id: string) {
  for (const transaction of Object.values(state.arrangements)) {
    const change = transaction.changes.find(
      (candidate) => reopenWindowId(candidate.record as ReopenWindow) === id,
    );
    if (change) return { transaction, change };
  }
  return null;
}

function assertProjectOwners(state: WindowState): void {
  const projects = new Set<string>();
  for (const entry of Object.values(state.entries)) {
    const identity = entry.record.window;
    if ((!entry.open && !entry.returnedProject) || identity?.kind !== 'project') continue;
    const key = JSON.stringify([entry.record.target, identity.profileId, identity.projectId]);
    if (projects.has(key)) throw new Error('The arrangement would duplicate a project owner');
    projects.add(key);
  }
}

/** Validate all revisions and scope membership again before publishing a prepared outcome. */
export function validateArrangement(
  state: WindowState,
  transaction: DesktopArrangementTransaction,
): void {
  const active = arrangementParticipants(state, transaction);
  if (JSON.stringify(active) !== JSON.stringify([...transaction.activeIds].sort()))
    throw new Error('Window arrangement membership changed');
  const changes = records(transaction);
  const ids = new Set(changes.map((change) => reopenWindowId(change.record)));
  if (active.some((id) => !ids.has(id))) throw new Error('Arrangement omits an affected window');
  const owner = state.entries[transaction.ownerId]!;
  const after = structuredClone(state);
  const destinations = changes.filter((change) => change.open).map((change) => change.content);
  for (const change of changes) {
    const id = reopenWindowId(change.record);
    const identity = change.record.window;
    if (
      !identity ||
      change.record.target !== owner.record.target ||
      (identity.kind === 'host'
        ? id !== transaction.ownerId || !change.open
        : identity.profileId !== transaction.profileId ||
          (transaction.scope === 'project' && identity.projectId !== transaction.projectId))
    )
      throw new Error('Arrangement crosses a host, profile or project boundary');
    const previous = state.entries[id];
    if (
      previous &&
      (previous.record.target !== change.record.target ||
        (previous.record.window &&
          JSON.stringify(previous.record.window) !== JSON.stringify(identity)))
    )
      throw new Error('Window identity cannot change');
    const version = previous?.workspaces[transaction.profileId];
    if ((version?.revision ?? 0) !== change.revision) throw new Error('Window state changed');
    if (
      transaction.scope === 'project' &&
      identity.kind === 'host' &&
      version &&
      version.content.snapshot.layout_mode === 'project' &&
      change.content.snapshot.layout_mode === 'project'
    ) {
      const before = version.content.snapshot.project_layouts;
      const afterSlices = change.content.snapshot.project_layouts;
      for (const project of new Set([...Object.keys(before), ...Object.keys(afterSlices)]))
        if (
          project !== transaction.projectId &&
          JSON.stringify(before[project]) !== JSON.stringify(afterSlices[project])
        )
          throw new Error('Arrangement would change another project slice');
    }
    if (version) assertDraftsRetained(version.content, destinations);
    after.entries[id] = {
      record: change.record,
      open: change.open,
      workspaces: previous?.workspaces ?? {},
    };
  }
  assertProjectOwners(after);
}

export function prepareArrangement(state: WindowState, request: ArrangementRequest) {
  if (
    state.pending[request.id] ||
    state.outcomes[request.id] ||
    state.arrangements[request.id] ||
    state.arrangementOutcomes[request.id]
  )
    throw new Error('Arrangement already recorded; inspect its outcome');
  const transaction = desktopArrangementTransactionSchema.parse({
    ...request,
    activeIds: arrangementParticipants(state, request),
  });
  const changes = records(transaction);
  transaction.changes = changes;
  for (const change of changes) {
    const id = reopenWindowId(change.record);
    if (
      stagedArrangement(state, id) ||
      Object.values(state.pending).some((move) => move.sourceId === id || move.destinationId === id)
    )
      throw new Error('Window transfer is pending');
  }
  validateArrangement(state, transaction);
  const next = structuredClone(state);
  for (const change of changes) {
    const id = reopenWindowId(change.record);
    if (!next.entries[id])
      next.entries[id] = { record: change.record, open: false, workspaces: {} };
  }
  next.arrangements[transaction.id] = transaction;
  return { next, transaction };
}

function finish(state: WindowState, id: string, status: 'committed' | 'cancelled'): void {
  const transaction = state.arrangements[id]!;
  state.arrangementOutcomes[id] = {
    status,
    ownerId: transaction.ownerId,
    profileId: transaction.profileId,
  };
  delete state.arrangements[id];
  const outcomes = Object.keys(state.arrangementOutcomes);
  for (const old of outcomes.slice(0, Math.max(0, outcomes.length - 256)))
    delete state.arrangementOutcomes[old];
}

export function commitArrangement(
  state: WindowState,
  id: string,
  ownerId: string,
): WindowState | null {
  const outcome = state.arrangementOutcomes[id];
  if (outcome?.ownerId !== undefined && outcome.ownerId !== ownerId)
    throw new Error('Arrangement belongs to another window');
  if (outcome?.status === 'committed') return null;
  const transaction = state.arrangements[id];
  if (!transaction || transaction.ownerId !== ownerId)
    throw new Error('Arrangement is not prepared');
  validateArrangement(state, transaction);
  const next = structuredClone(state);
  for (const change of records(transaction)) {
    const entry = next.entries[reopenWindowId(change.record)]!;
    entry.record = {
      ...change.record,
      ...(entry.record.placement ? { placement: entry.record.placement } : {}),
    };
    entry.open = change.open;
    delete entry.returnedProject;
    entry.workspaces[transaction.profileId] = {
      revision: change.revision + 1,
      content: change.content,
    };
  }
  finish(next, id, 'committed');
  return next;
}

export function cancelArrangement(
  state: WindowState,
  id: string,
  ownerId: string,
): WindowState | null {
  const transaction = state.arrangements[id] ?? state.arrangementOutcomes[id];
  if (!transaction || transaction.ownerId !== ownerId)
    throw new Error('Arrangement belongs to another window');
  if (!state.arrangements[id]) return null;
  const next = structuredClone(state);
  finish(next, id, 'cancelled');
  return next;
}

/** A failed seal/plan still consumes its operation id without changing window ownership. */
export function cancelArrangementPreparation(
  state: WindowState,
  id: string,
  ownerId: string,
  profileId: string,
): WindowState | null {
  const previous = state.arrangements[id] ?? state.arrangementOutcomes[id];
  if (previous) {
    if (previous.profileId !== profileId) throw new Error('Arrangement belongs to another profile');
    return cancelArrangement(state, id, ownerId);
  }
  if (state.pending[id] || state.outcomes[id])
    throw new Error('A transfer already uses this operation id');
  arrangementParticipants(state, { ownerId, profileId, scope: 'profile' });
  const next = structuredClone(state);
  next.arrangementOutcomes[desktopWindowIdSchema.parse(id)] = desktopArrangementOutcomeSchema.parse(
    { status: 'cancelled', ownerId, profileId },
  );
  for (const old of Object.keys(next.arrangementOutcomes).slice(0, -256))
    delete next.arrangementOutcomes[old];
  return next;
}

/** Keep a cancelled destination's late work without erasing a retained closed slot's drafts. */
export function retainArrangementRecovery(
  state: WindowState,
  id: string,
  ownerId: string,
  profile: string,
  windowId: string,
  version: DesktopWorkspaceVersion,
): WindowState {
  const outcome = state.arrangementOutcomes[id];
  if (
    outcome?.status !== 'cancelled' ||
    outcome.ownerId !== ownerId ||
    outcome.profileId !== profile
  )
    throw new Error('The arrangement is not cancelled');
  const entry = state.entries[windowId];
  const identity = entry?.record.window;
  if (
    !entry ||
    entry.open ||
    !identity ||
    identity.kind === 'host' ||
    identity.profileId !== profile ||
    entry.record.target !== state.entries[ownerId]?.record.target
  )
    throw new Error('Invalid layout recovery destination');
  if (
    stagedArrangement(state, windowId) ||
    Object.values(state.pending).some(
      (move) => move.sourceId === windowId || move.destinationId === windowId,
    )
  )
    throw new Error('Window transfer is pending');
  const previous = entry.workspaces[profile];
  if ((previous?.revision ?? 0) !== version.revision) throw new Error('Window state changed');
  const recovered = desktopWorkspaceVersionSchema.parse({
    ...version,
    revision: version.revision + 1,
  });
  const keys = new Set(recovered.content.buffers.map(bufferIdentity));
  if (previous?.content.buffers.some((buffer) => !keys.has(bufferIdentity(buffer))))
    throw new Error('Layout recovery would discard a retained draft');
  const next = structuredClone(state);
  const recovery = next.entries[windowId]!;
  recovery.open = true;
  delete recovery.returnedProject;
  recovery.workspaces[profile] = recovered;
  assertProjectOwners(next);
  return next;
}

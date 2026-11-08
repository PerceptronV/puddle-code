import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  desktopWindowStateSchema,
  desktopWindowTransferSchema,
  desktopWorkspaceVersionSchema,
  uiStateSnapshotSchema,
  desktopTabKey,
  type TabRef,
  type LayoutNode,
  type DesktopProfileSeed,
  type DesktopWindowTransfer,
  type DesktopWorkspaceContent,
  type DesktopWorkspaceVersion,
} from '@puddle/shared';
import {
  loadReopenWindows,
  parseReopenWindows,
  reopenWindowId,
  type ReopenWindow,
} from '../../reopen.js';

import type { WindowState } from './model.js';
import { assertDraftsRetained } from './drafts.js';
import {
  arrangementParticipants,
  stagedArrangement,
  validateArrangement,
  prepareArrangement,
  commitArrangement,
  cancelArrangement,
  cancelArrangementPreparation,
  retainArrangementRecovery,
  type ArrangementRequest,
} from './arrangements.js';
type Transfer = DesktopWindowTransfer;

const MAX_STATE_BYTES = 64 * 1024 * 1024;
const MAX_OUTCOMES = 256;

function serialise(value: unknown): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > MAX_STATE_BYTES)
    throw new Error('Desktop window state is too large');
  return json;
}

/** Persist before publishing the in-memory revision; a failed write changes nothing. */
function writeState(file: string, state: WindowState): void {
  const windows = Object.values(state.entries)
    .filter((entry) => entry.open)
    .map((entry) => entry.record);
  const data = serialise({ ...state, windows });
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  let fd: number | undefined;
  let owned = false;
  try {
    fd = openSync(temporary, 'wx', 0o600);
    owned = true;
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
  } finally {
    if (fd !== undefined) closeSync(fd);
    // Never remove a pre-existing scratch path that prevented exclusive creation.
    if (owned) {
      try {
        rmSync(temporary);
      } catch {
        /* Retain the last complete snapshot. */
      }
    }
  }
}

/**
 * Durable desktop working sets and transfer decisions. The root's `windows`
 * projection preserves legacy reopen readers; entries also retain closed working
 * sets so returning a project never depends on a host renderer staying alive.
 */
export class DesktopWindowState {
  private state: WindowState;

  constructor(private readonly file: string) {
    this.state = {
      version: 3,
      entries: {},
      pending: {},
      outcomes: {},
      arrangements: {},
      arrangementOutcomes: {},
    };
    if (!existsSync(file)) return;
    const raw = readFileSync(file, 'utf8');
    if (Buffer.byteLength(raw) > MAX_STATE_BYTES)
      throw new Error('Desktop window state is too large');
    const value: unknown = JSON.parse(raw);
    if (typeof value === 'object' && value !== null && 'version' in value) {
      const parsed = desktopWindowStateSchema.parse(
        value.version === 2
          ? { ...value, version: 3, arrangements: {}, arrangementOutcomes: {} }
          : value,
      );
      const entries: WindowState['entries'] = {};
      for (const [id, entry] of Object.entries(parsed.entries)) {
        const record = parseReopenWindows([entry.record])[0];
        if (!record) throw new Error('Invalid saved window');
        entries[id] = { ...entry, record };
      }
      this.state = { ...parsed, entries };
      for (const [id, entry] of Object.entries(this.state.entries)) {
        if (id !== reopenWindowId(entry.record)) throw new Error('Saved window identity mismatch');
        if (
          entry.returnedProject &&
          (entry.open ||
            entry.record.window?.kind !== 'project' ||
            !entry.workspaces[entry.record.window.profileId])
        )
          throw new Error('Invalid returned project state');
      }
      this.validatePending();
    } else {
      for (const record of loadReopenWindows(file)) {
        this.state.entries[reopenWindowId(record)] = { record, open: true, workspaces: {} };
      }
    }
  }

  private publish(next: WindowState): void {
    writeState(this.file, next);
    this.state = next;
  }

  private validatePending(): void {
    const locked = new Set<string>();
    for (const [id, transfer] of Object.entries(this.state.pending)) {
      if (id !== transfer.id || this.state.outcomes[id])
        throw new Error('Invalid saved transfer identity');
      for (const windowId of [transfer.sourceId, transfer.destinationId]) {
        if (locked.has(windowId) || !this.state.entries[windowId])
          throw new Error('Invalid saved transfer ownership');
        locked.add(windowId);
      }
      const source = this.entry(transfer.sourceId);
      const destination = this.entry(transfer.destinationId);
      if (source.record.target !== destination.record.target)
        throw new Error('Invalid saved transfer host');
      this.assertRevision(transfer.sourceId, transfer.profileId, transfer.sourceRevision);
      this.assertRevision(transfer.destinationId, transfer.profileId, transfer.destinationRevision);
    }
    for (const [id, transaction] of Object.entries(this.state.arrangements)) {
      if (
        id !== transaction.id ||
        this.state.arrangementOutcomes[id] ||
        this.state.pending[id] ||
        this.state.outcomes[id]
      )
        throw new Error('Invalid saved arrangement identity');
      validateArrangement(this.state, transaction);
      for (const change of transaction.changes) {
        const windowId = reopenWindowId(change.record as ReopenWindow);
        if (locked.has(windowId) || !this.state.entries[windowId])
          throw new Error('Invalid saved arrangement ownership');
        locked.add(windowId);
      }
    }
  }

  private entry(id: string) {
    const entry = this.state.entries[id];
    if (!entry) throw new Error('Window state is unavailable');
    return entry;
  }

  private assertProfile(id: string, profile: string): void {
    if (!/^[0-9a-f]{10}$/.test(profile)) throw new Error('Invalid profile identity');
    const identity = this.entry(id).record.window;
    if (identity && identity.kind !== 'host' && identity.profileId !== profile)
      throw new Error('Window belongs to another profile');
  }

  private assertRevision(id: string, profile: string, revision: number): void {
    this.assertProfile(id, profile);
    if ((this.entry(id).workspaces[profile]?.revision ?? 0) !== revision)
      throw new Error('Window state changed');
  }

  private assertUnlocked(id: string): void {
    if (
      stagedArrangement(this.state, id) ||
      Object.values(this.state.pending).some(
        (transfer) => transfer.sourceId === id || transfer.destinationId === id,
      )
    ) {
      throw new Error('Window transfer is pending');
    }
  }

  openWindows(): ReopenWindow[] {
    return structuredClone(
      Object.values(this.state.entries)
        .filter((entry) => entry.open)
        .map((entry) => entry.record),
    );
  }

  /** Update shell placement/open state without overwriting any renderer working set. */
  syncOpenWindows(records: ReopenWindow[]): void {
    const parsed = records.flatMap((record) => parseReopenWindows([record]));
    if (
      parsed.length !== records.length ||
      new Set(parsed.map(reopenWindowId)).size !== parsed.length
    )
      throw new Error('Invalid or duplicate window identities');
    const next = structuredClone(this.state);
    for (const [id, entry] of Object.entries(next.entries))
      if (!stagedArrangement(this.state, id)) entry.open = false;
    for (const record of parsed) {
      const id = reopenWindowId(record);
      const previous = next.entries[id];
      const arrangement = stagedArrangement(this.state, id);
      if (previous?.returnedProject && !arrangement)
        throw new Error('Reopen the returned project before registering its window');
      if (
        previous &&
        (previous.record.target !== record.target ||
          (previous.record.window &&
            JSON.stringify(previous.record.window) !== JSON.stringify(record.window)))
      ) {
        throw new Error('Window identity cannot change');
      }
      const preparing = Object.values(this.state.pending).some(
        (transfer) => transfer.destinationId === id,
      );
      next.entries[id] = {
        ...(arrangement ? previous : {}),
        record:
          (preparing || arrangement) && previous
            ? { ...record, route: previous.record.route }
            : record,
        open: preparing || arrangement ? (this.state.entries[id]?.open ?? false) : true,
        workspaces: previous?.workspaces ?? {},
      };
    }
    const open = Object.values(next.entries)
      .filter((entry) => entry.open)
      .map((entry) => entry.record);
    if (parseReopenWindows(open).length !== open.length)
      throw new Error('Duplicate open window ownership');
    for (const transaction of Object.values(next.arrangements))
      validateArrangement(next, transaction);
    this.publish(next);
  }

  read(id: string, profile: string): DesktopWorkspaceVersion | null {
    this.assertProfile(id, profile);
    return structuredClone(this.entry(id).workspaces[profile] ?? null);
  }

  projectWindow(sourceId: string, profile: string, project: string) {
    this.assertProfile(sourceId, profile);
    const target = this.entry(sourceId).record.target;
    const entry = Object.values(this.state.entries).find((entry) => {
      const identity = entry.record.window;
      return (
        entry.record.target === target &&
        identity?.kind === 'project' &&
        identity.profileId === profile &&
        identity.projectId === project &&
        (entry.open || entry.returnedProject || this.staging(identity.id))
      );
    });
    return entry
      ? structuredClone({
          record: entry.record,
          open: entry.open,
          returned: !!entry.returnedProject,
        })
      : null;
  }

  returnedProject(id: string) {
    const entry = this.entry(id);
    const identity = entry.record.window;
    const version = identity?.kind === 'project' ? entry.workspaces[identity.profileId] : undefined;
    return identity?.kind === 'project' && entry.returnedProject && !entry.open && version
      ? structuredClone({ record: entry.record, identity, version })
      : null;
  }

  closeProject(id: string, revision: number): void {
    this.assertUnlocked(id);
    const entry = this.entry(id);
    const identity = entry.record.window;
    if (identity?.kind !== 'project')
      throw new Error('Only project windows can return a workspace');
    this.assertRevision(id, identity.profileId, revision);
    if (!entry.workspaces[identity.profileId]) throw new Error('Project workspace is unavailable');
    const next = structuredClone(this.state);
    next.entries[id]!.open = false;
    next.entries[id]!.returnedProject = true;
    this.publish(next);
  }

  reopenProject(id: string): ReopenWindow {
    this.assertUnlocked(id);
    const returned = this.returnedProject(id);
    if (!returned) throw new Error('The returned project is unavailable');
    const next = structuredClone(this.state);
    next.entries[id]!.open = true;
    delete next.entries[id]!.returnedProject;
    this.publish(next);
    return returned.record;
  }

  staging(id: string): Transfer | null {
    return structuredClone(
      Object.values(this.state.pending).find((transfer) => transfer.destinationId === id) ?? null,
    );
  }

  /** Prepared content is visible only to its exact destination, never as committed state. */
  readPresentation(id: string, profile: string): DesktopWorkspaceVersion | null {
    this.assertProfile(id, profile);
    const staged = this.staging(id);
    if (staged) {
      if (staged.profileId !== profile) throw new Error('Transfer belongs to another profile');
      return { revision: staged.destinationRevision, content: staged.destinationContent };
    }
    const arrangement = stagedArrangement(this.state, id);
    if (arrangement) {
      if (arrangement.transaction.profileId !== profile)
        throw new Error('Arrangement belongs to another profile');
      return structuredClone({
        revision: arrangement.change.revision,
        content: arrangement.change.content,
      });
    }
    return this.read(id, profile);
  }

  /** The same recovery records supply coherent layout capture and apply planning. */
  arrangementEntries(
    request: Pick<ArrangementRequest, 'ownerId' | 'profileId' | 'scope' | 'projectId'>,
    retained = false,
  ) {
    return arrangementParticipants(this.state, request, retained).map((id) => {
      const entry = this.entry(id);
      return structuredClone({
        record: entry.record,
        open: entry.open,
        returnedProject: !!entry.returnedProject,
        version: entry.workspaces[request.profileId] ?? null,
      });
    });
  }

  prepareArrangement(request: ArrangementRequest) {
    serialise(request);
    const { next, transaction } = prepareArrangement(this.state, request);
    this.publish(next);
    return structuredClone(transaction);
  }

  commitArrangement(id: string, ownerId: string): void {
    const next = commitArrangement(this.state, id, ownerId);
    if (next) this.publish(next);
  }

  cancelArrangement(id: string, ownerId: string): void {
    const next = cancelArrangement(this.state, id, ownerId);
    if (next) this.publish(next);
  }

  cancelArrangementPreparation(id: string, ownerId: string, profileId: string): void {
    const next = cancelArrangementPreparation(this.state, id, ownerId, profileId);
    if (next) this.publish(next);
  }

  /** Retain exceptional late work in an already-created destination after cancellation. */
  retainArrangementRecovery(
    id: string,
    ownerId: string,
    profile: string,
    windowId: string,
    version: DesktopWorkspaceVersion,
  ): void {
    this.publish(retainArrangementRecovery(this.state, id, ownerId, profile, windowId, version));
  }

  arrangementOutcome(
    id: string,
    ownerId: string,
    profileId?: string,
  ): 'prepared' | 'committed' | 'cancelled' | null {
    const transaction = this.state.arrangements[id] ?? this.state.arrangementOutcomes[id];
    if (!transaction) return null;
    if (transaction.ownerId !== ownerId) throw new Error('Arrangement belongs to another window');
    if (profileId !== undefined && transaction.profileId !== profileId)
      throw new Error('Arrangement belongs to another profile');
    return this.state.arrangements[id] ? 'prepared' : this.state.arrangementOutcomes[id]!.status;
  }

  stagingArrangement(id: string) {
    return structuredClone(stagedArrangement(this.state, id));
  }

  findPane(sourceId: string, profile: string, ref: TabRef): string | null {
    this.assertProfile(sourceId, profile);
    const target = this.entry(sourceId).record.target;
    const key = desktopTabKey(ref);
    const contains = (tree: LayoutNode | null): boolean =>
      !!tree &&
      (tree.kind === 'leaf'
        ? tree.tabs.some((tab) => desktopTabKey(tab) === key)
        : tree.children.some(contains));
    for (const [id, entry] of Object.entries(this.state.entries)) {
      const identity = entry.record.window;
      if (
        entry.open &&
        entry.record.target === target &&
        identity?.kind === 'pane' &&
        identity.profileId === profile &&
        contains(entry.workspaces[profile]?.content.snapshot.layout_tree ?? null)
      )
        return id;
    }
    return null;
  }

  transferParty(id: string, windowId: string): 'source' | 'destination' | null {
    const transfer = this.state.pending[id] ?? this.state.outcomes[id];
    return transfer?.sourceId === windowId
      ? 'source'
      : transfer?.destinationId === windowId
        ? 'destination'
        : null;
  }

  transferProfile(id: string): string | undefined {
    return (this.state.pending[id] ?? this.state.outcomes[id])?.profileId;
  }

  /** A complete profile seed, never one detached renderer's partial workspace. */
  seed(id: string, profile: string): DesktopProfileSeed {
    this.assertProfile(id, profile);
    const target = this.entry(id).record.target;
    const entries = Object.values(this.state.entries).filter(
      (entry) => entry.record.target === target,
    );
    const host = entries.find(
      (entry) => !entry.record.window || entry.record.window.kind === 'host',
    );
    return structuredClone({
      base: host?.workspaces[profile]?.content.snapshot ?? uiStateSnapshotSchema.parse({}),
      detached: entries.flatMap((entry) => {
        const identity = entry.record.window;
        const workspace = entry.workspaces[profile];
        return (entry.open || entry.returnedProject) &&
          identity &&
          identity.kind !== 'host' &&
          identity.profileId === profile &&
          workspace
          ? [{ identity, snapshot: workspace.content.snapshot }]
          : [];
      }),
    });
  }

  write(
    id: string,
    profile: string,
    revision: number,
    content: DesktopWorkspaceContent,
  ): DesktopWorkspaceVersion {
    this.assertUnlocked(id);
    if (this.entry(id).returnedProject) throw new Error('The returned project is closed');
    this.assertRevision(id, profile, revision);
    serialise(content);
    const version = desktopWorkspaceVersionSchema.parse({ revision: revision + 1, content });
    const next = structuredClone(this.state);
    next.entries[id]!.workspaces[profile] = version;
    this.publish(next);
    return structuredClone(version);
  }

  prepare(input: Omit<Transfer, 'destinationId'> & { destination: ReopenWindow }): Transfer {
    if (
      this.state.pending[input.id] ||
      this.state.outcomes[input.id] ||
      this.state.arrangements[input.id] ||
      this.state.arrangementOutcomes[input.id]
    )
      throw new Error('Transfer already recorded; inspect its outcome');
    const destination = parseReopenWindows([input.destination])[0];
    if (!destination) throw new Error('Invalid transfer destination');
    const destinationId = reopenWindowId(destination);
    if (destinationId === input.sourceId) throw new Error('Transfer requires another window');
    this.assertUnlocked(input.sourceId);
    this.assertUnlocked(destinationId);
    this.assertRevision(input.sourceId, input.profileId, input.sourceRevision);
    const source = this.entry(input.sourceId);
    if (source.record.target !== destination.target)
      throw new Error('Cannot transfer between hosts');
    const identity = destination.window;
    if (identity && identity.kind !== 'host' && identity.profileId !== input.profileId)
      throw new Error('Cannot transfer between profiles');
    if (identity?.kind === 'project') {
      const existing = this.projectWindow(input.sourceId, input.profileId, identity.projectId);
      if (existing && reopenWindowId(existing.record) !== destinationId)
        throw new Error('This project already has a window');
    }
    const previous = this.state.entries[destinationId];
    if (previous) {
      if (
        previous.record.target !== destination.target ||
        JSON.stringify(previous.record.window) !== JSON.stringify(destination.window)
      )
        throw new Error('Destination identity changed');
      this.assertRevision(destinationId, input.profileId, input.destinationRevision);
    } else if (input.destinationRevision !== 0) throw new Error('Destination state changed');
    serialise(input);
    const transfer = desktopWindowTransferSchema.parse({ ...input, destinationId });
    const sourceBefore = source.workspaces[input.profileId];
    if (!sourceBefore) throw new Error('Source workspace has not been captured');
    assertDraftsRetained(sourceBefore.content, [
      transfer.sourceContent,
      transfer.destinationContent,
    ]);
    const destinationBefore = previous?.workspaces[input.profileId];
    if (destinationBefore)
      assertDraftsRetained(destinationBefore.content, [
        transfer.sourceContent,
        transfer.destinationContent,
      ]);
    const next = structuredClone(this.state);
    if (!previous)
      next.entries[destinationId] = { record: destination, open: false, workspaces: {} };
    next.pending[transfer.id] = transfer;
    this.publish(next);
    return structuredClone(transfer);
  }

  pending(id: string): Transfer | null {
    return structuredClone(this.state.pending[id] ?? null);
  }

  outcome(id: string): 'prepared' | 'committed' | 'cancelled' | null {
    return this.state.pending[id] ? 'prepared' : (this.state.outcomes[id]?.status ?? null);
  }

  /** Destination acknowledgement commits both ownership revisions in one write. */
  commit(id: string, destinationId: string): void {
    const outcome = this.state.outcomes[id];
    if (outcome?.status === 'committed') {
      if (outcome.destinationId !== destinationId)
        throw new Error('Transfer acknowledgement does not match');
      return;
    }
    const transfer = this.state.pending[id];
    if (!transfer || transfer.destinationId !== destinationId)
      throw new Error('Transfer acknowledgement does not match');
    this.assertRevision(transfer.sourceId, transfer.profileId, transfer.sourceRevision);
    this.assertRevision(transfer.destinationId, transfer.profileId, transfer.destinationRevision);
    const next = structuredClone(this.state);
    next.entries[transfer.sourceId]!.workspaces[transfer.profileId] = {
      revision: transfer.sourceRevision + 1,
      content: transfer.sourceContent,
    };
    next.entries[transfer.sourceId]!.open =
      !transfer.closeSource && this.entry(transfer.sourceId).open;
    if (transfer.closeSource) delete next.entries[transfer.sourceId]!.returnedProject;
    if (transfer.sourceRoute) next.entries[transfer.sourceId]!.record.route = transfer.sourceRoute;
    next.entries[transfer.destinationId]!.workspaces[transfer.profileId] = {
      revision: transfer.destinationRevision + 1,
      content: transfer.destinationContent,
    };
    next.entries[transfer.destinationId]!.open = true;
    if (transfer.destinationRoute)
      next.entries[transfer.destinationId]!.record.route = transfer.destinationRoute;
    this.finish(next, id, 'committed');
    this.publish(next);
  }

  cancel(id: string): void {
    if (!this.state.pending[id]) return;
    const next = structuredClone(this.state);
    this.finish(next, id, 'cancelled');
    this.publish(next);
  }

  /** A cancelled destination plan must not later become a prepared move. */
  cancelPreparation(id: string, sourceId: string, destinationId: string, profileId: string): void {
    if (this.state.arrangements[id] || this.state.arrangementOutcomes[id])
      throw new Error('Identity belongs to an arrangement');
    if (this.outcome(id)) return;
    this.assertProfile(sourceId, profileId);
    this.assertProfile(destinationId, profileId);
    if (this.entry(sourceId).record.target !== this.entry(destinationId).record.target)
      throw new Error('Cannot transfer between hosts');
    const next = structuredClone(this.state);
    next.outcomes[id] = { status: 'cancelled', sourceId, destinationId, profileId };
    for (const old of Object.keys(next.outcomes).slice(
      0,
      Math.max(0, Object.keys(next.outcomes).length - MAX_OUTCOMES),
    ))
      delete next.outcomes[old];
    this.publish(next);
  }

  /** Retire only a sealed empty pane after its acknowledged handoff. */
  retireSource(id: string, sourceId: string, profileId: string, revision: number): void {
    const outcome = this.state.outcomes[id];
    if (
      outcome?.status !== 'committed' ||
      outcome.sourceId !== sourceId ||
      outcome.profileId !== profileId
    )
      throw new Error('The pane handoff has not committed');
    const entry = this.entry(sourceId);
    if (entry.record.window?.kind !== 'pane') throw new Error('Only a pane window can retire');
    this.assertUnlocked(sourceId);
    this.assertRevision(sourceId, profileId, revision);
    const content = entry.workspaces[profileId]!.content;
    const empty = (node: LayoutNode | null): boolean =>
      !node || (node.kind === 'leaf' ? node.tabs.length === 0 : node.children.every(empty));
    if (
      content.buffers.length ||
      (content.snapshot.layout_mode === 'project'
        ? Object.values(content.snapshot.project_layouts).some((slice) => !empty(slice.layout_tree))
        : !empty(content.snapshot.layout_tree))
    )
      throw new Error('The source pane still contains recoverable work');
    const next = structuredClone(this.state);
    next.entries[sourceId]!.open = false;
    this.publish(next);
  }

  /** A process restart cannot receive an old renderer's acknowledgement. */
  recoverPending(): void {
    if (
      Object.keys(this.state.pending).length === 0 &&
      Object.keys(this.state.arrangements).length === 0
    )
      return;
    let next = structuredClone(this.state);
    for (const id of Object.keys(next.pending)) this.finish(next, id, 'cancelled');
    for (const [id, transaction] of Object.entries(next.arrangements))
      next = cancelArrangement(next, id, transaction.ownerId)!;
    this.publish(next);
  }

  private finish(state: WindowState, id: string, outcome: 'committed' | 'cancelled'): void {
    const transfer = state.pending[id]!;
    delete state.pending[id];
    state.outcomes[id] = {
      status: outcome,
      sourceId: transfer.sourceId,
      destinationId: transfer.destinationId,
      profileId: transfer.profileId,
    };
    const outcomes = Object.keys(state.outcomes);
    for (const old of outcomes.slice(0, Math.max(0, outcomes.length - MAX_OUTCOMES)))
      delete state.outcomes[old];
  }
}

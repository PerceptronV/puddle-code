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
} from '../reopen.js';

interface WindowState {
  version: 2;
  entries: Record<
    string,
    { record: ReopenWindow; open: boolean; workspaces: Record<string, DesktopWorkspaceVersion> }
  >;
  pending: Record<string, DesktopWindowTransfer>;
  outcomes: Record<
    string,
    { status: 'committed' | 'cancelled'; sourceId: string; destinationId: string }
  >;
}
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

function bufferIdentity(buffer: DesktopWorkspaceContent['buffers'][number]): string {
  return JSON.stringify([buffer.session, buffer.path, buffer.root ?? null]);
}

function assertDraftsRetained(
  before: DesktopWorkspaceContent,
  after: DesktopWorkspaceContent[],
): void {
  for (const buffer of before.buffers) {
    if (
      !after.some((content) =>
        content.buffers.some(
          (next) =>
            bufferIdentity(next) === bufferIdentity(buffer) &&
            next.content === buffer.content &&
            next.baseMtimeMs === buffer.baseMtimeMs,
        ),
      )
    )
      throw new Error('Window transfer would discard an unsaved buffer');
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
    this.state = { version: 2, entries: {}, pending: {}, outcomes: {} };
    if (!existsSync(file)) return;
    const raw = readFileSync(file, 'utf8');
    if (Buffer.byteLength(raw) > MAX_STATE_BYTES)
      throw new Error('Desktop window state is too large');
    const value: unknown = JSON.parse(raw);
    if (typeof value === 'object' && value !== null && 'version' in value) {
      const parsed = desktopWindowStateSchema.parse(value);
      const entries: WindowState['entries'] = {};
      for (const [id, entry] of Object.entries(parsed.entries)) {
        const record = parseReopenWindows([entry.record])[0];
        if (!record) throw new Error('Invalid saved window');
        entries[id] = { ...entry, record };
      }
      this.state = { ...parsed, entries };
      for (const [id, entry] of Object.entries(this.state.entries)) {
        if (id !== reopenWindowId(entry.record)) throw new Error('Saved window identity mismatch');
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
    const parsed = parseReopenWindows(records);
    if (parsed.length !== records.length) throw new Error('Invalid or duplicate window identities');
    const next = structuredClone(this.state);
    for (const entry of Object.values(next.entries)) entry.open = false;
    for (const record of parsed) {
      const id = reopenWindowId(record);
      const previous = next.entries[id];
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
        record,
        open: preparing ? (this.state.entries[id]?.open ?? false) : true,
        workspaces: previous?.workspaces ?? {},
      };
    }
    this.publish(next);
  }

  read(id: string, profile: string): DesktopWorkspaceVersion | null {
    this.assertProfile(id, profile);
    return structuredClone(this.entry(id).workspaces[profile] ?? null);
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
        return entry.open &&
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
    this.assertRevision(id, profile, revision);
    serialise(content);
    const version = desktopWorkspaceVersionSchema.parse({ revision: revision + 1, content });
    const next = structuredClone(this.state);
    next.entries[id]!.workspaces[profile] = version;
    this.publish(next);
    return structuredClone(version);
  }

  prepare(input: Omit<Transfer, 'destinationId'> & { destination: ReopenWindow }): Transfer {
    if (this.state.pending[input.id] || this.state.outcomes[input.id])
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
    next.entries[transfer.destinationId]!.workspaces[transfer.profileId] = {
      revision: transfer.destinationRevision + 1,
      content: transfer.destinationContent,
    };
    next.entries[transfer.destinationId]!.open = true;
    this.finish(next, id, 'committed');
    this.publish(next);
  }

  cancel(id: string): void {
    if (!this.state.pending[id]) return;
    const next = structuredClone(this.state);
    this.finish(next, id, 'cancelled');
    this.publish(next);
  }

  /** A process restart cannot receive an old renderer's acknowledgement. */
  recoverPending(): void {
    if (Object.keys(this.state.pending).length === 0) return;
    const next = structuredClone(this.state);
    for (const id of Object.keys(next.pending)) this.finish(next, id, 'cancelled');
    this.publish(next);
  }

  private finish(state: WindowState, id: string, outcome: 'committed' | 'cancelled'): void {
    const transfer = state.pending[id]!;
    delete state.pending[id];
    state.outcomes[id] = {
      status: outcome,
      sourceId: transfer.sourceId,
      destinationId: transfer.destinationId,
    };
    const outcomes = Object.keys(state.outcomes);
    for (const old of outcomes.slice(0, Math.max(0, outcomes.length - MAX_OUTCOMES)))
      delete state.outcomes[old];
  }
}

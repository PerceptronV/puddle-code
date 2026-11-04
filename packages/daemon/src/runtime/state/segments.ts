import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RUNTIME_LIMITS,
  runtimeCheckpointSchema,
  runtimeSegmentSchema,
  runtimeTerminalSchema,
  type RuntimeCheckpoint,
  type RuntimeIdentity,
  type RuntimeLifecycle,
  type RuntimeSegment,
  type RuntimeTerminal,
} from '@puddle/shared';
import { privateDirectory, privatePath } from '@puddle/shared/node';
import type { LogStore } from '../../logs/log-store.js';

import { RuntimeStateWriter } from './persistence.js';

type CheckpointWriter = (file: string, json: string) => Promise<void>;

interface SegmentOptions {
  maxSegments?: number;
  logBytes?: number;
  logFiles?: number;
  snapshotBytes?: number;
  pendingBytes?: number;
  pendingCount?: number;
  write?: CheckpointWriter;
}

/** Stable live emulators, immutable historical checkpoints, and separately addressed raw output. */
export class RuntimeSegments {
  private current: RuntimeSegment;
  private count = 1;
  private rawBytes = 0;
  private readonly rawStreams = new Set<string>();
  private snapshotBytes = 0;
  private pendingBytes = 0;
  private gap = false;
  private readonly pending = new Set<Promise<void>>();
  private readonly limits: {
    segments: number;
    logs: number;
    logFiles: number;
    snapshots: number;
    pendingBytes: number;
    pendingCount: number;
  };
  private readonly write: CheckpointWriter;

  constructor(
    private readonly directory: string,
    private readonly identity: RuntimeIdentity,
    private readonly logs: LogStore,
    initialRef: string | null,
    options: SegmentOptions = {},
  ) {
    this.current = { id: identity.runtime_id, start_cursor: 0, agent_session_ref: initialRef };
    this.limits = {
      segments: Math.min(
        options.maxSegments ?? RUNTIME_LIMITS.historySegments,
        RUNTIME_LIMITS.historySegments,
      ),
      logs: Math.min(
        options.logBytes ?? RUNTIME_LIMITS.historyLogBytes,
        RUNTIME_LIMITS.historyLogBytes,
      ),
      logFiles: Math.min(
        options.logFiles ?? RUNTIME_LIMITS.historyLogFiles,
        RUNTIME_LIMITS.historyLogFiles,
      ),
      snapshots: Math.min(
        options.snapshotBytes ?? RUNTIME_LIMITS.historySnapshotBytes,
        RUNTIME_LIMITS.historySnapshotBytes,
      ),
      pendingBytes: Math.min(
        options.pendingBytes ?? RUNTIME_LIMITS.pendingCheckpointBytes,
        RUNTIME_LIMITS.pendingCheckpointBytes,
      ),
      pendingCount: Math.min(
        options.pendingCount ?? RUNTIME_LIMITS.pendingCheckpoints,
        RUNTIME_LIMITS.pendingCheckpoints,
      ),
    };
    const writer = new RuntimeStateWriter(join(directory, 'segments'), 'checkpoint');
    this.write = options.write ?? ((file, json) => writer.write(file, json));
    privateDirectory(join(directory, 'segments'));
  }

  state() {
    return { current: { ...this.current }, pending_checkpoints: this.pending.size, gap: this.gap };
  }

  append(term: RuntimeTerminal, data: string): void {
    const bytes = Buffer.byteLength(data);
    if (bytes === 0) return;
    if (this.count > this.limits.segments || this.rawBytes + bytes > this.limits.logs) {
      this.gap = true;
      return;
    }
    const stream = `${this.current.id}/${term.term}.${term.generation}`;
    if (!this.rawStreams.has(stream)) {
      // Terminal slots can be reused indefinitely. Bound lifetime file identities,
      // while admitted streams keep recording after later generations are refused.
      if (this.rawStreams.size >= this.limits.logFiles) {
        this.gap = true;
        return;
      }
      this.rawStreams.add(stream);
    }
    this.rawBytes += bytes;
    this.logs.append(this.current.id, `${term.term}.${term.generation}`, data);
  }

  lifecycle(
    lifecycle: RuntimeLifecycle,
    cursor: number,
    terminals: RuntimeTerminal[],
    capture: (term: RuntimeTerminal) => Promise<string>,
  ) {
    let previous: string | null = null;
    if (
      lifecycle.event === 'session_start' &&
      lifecycle.agent_session_ref !== this.current.agent_session_ref
    ) {
      if (this.current.agent_session_ref !== null) {
        previous = this.current.id;
        this.seal(
          cursor - 1,
          terminals.filter((term) => term.pid !== null),
          capture,
        );
        this.count++;
        if (this.count > this.limits.segments) this.gap = true;
        this.current = {
          id: randomUUID(),
          start_cursor: cursor,
          agent_session_ref: lifecycle.agent_session_ref!,
        };
      } else this.current = { ...this.current, agent_session_ref: lifecycle.agent_session_ref! };
    }
    return { segment: { ...this.current }, previous_segment_id: previous };
  }

  /** Capture is invoked synchronously at the boundary; only file IO runs afterwards. */
  seal(
    through: number,
    terminals: RuntimeTerminal[],
    capture: (term: RuntimeTerminal) => Promise<string>,
  ): void {
    const segment = { ...this.current };
    for (const term of terminals) {
      this.logs.close(segment.id, `${term.term}.${term.generation}`);
      if (this.count > this.limits.segments || this.pending.size >= this.limits.pendingCount) {
        this.gap = true;
        continue;
      }
      const terminal = { ...term };
      const snapshot = capture(terminal);
      let charged = 0;
      const task = snapshot
        .then(async (data) => {
          const record = runtimeCheckpointSchema.parse({
            format: 1,
            identity: this.identity,
            segment,
            through,
            terminal,
            data,
          });
          const json = JSON.stringify(record) + '\n';
          const bytes = Buffer.byteLength(json);
          // Leave room for the response envelope when reading through IPC.
          if (
            bytes > RUNTIME_LIMITS.frameBytes - 1024 ||
            this.snapshotBytes + bytes > this.limits.snapshots ||
            this.pendingBytes + bytes > this.limits.pendingBytes
          ) {
            this.gap = true;
            return;
          }
          charged = bytes;
          this.pendingBytes += bytes;
          this.snapshotBytes += bytes;
          await this.write(this.file(segment.id, terminal.term, terminal.generation), json);
        })
        .catch(() => {
          this.gap = true;
        })
        .finally(() => {
          this.pendingBytes -= charged;
          this.pending.delete(task);
        });
      this.pending.add(task);
    }
  }

  async drain(): Promise<void> {
    await Promise.all(this.pending);
  }

  async read(segment: string, term: string, generation: string): Promise<RuntimeCheckpoint> {
    return readRuntimeCheckpoint(this.directory, this.identity, segment, term, generation);
  }

  private file(segment: string, term: string, generation: string): string {
    // The private protocol validates UUIDs and terminal names before this lookup.
    return join(this.directory, 'segments', `${segment}.${term}.${generation}.json`);
  }
}

/** Read the owner's immutable checkpoint without requiring a live control socket. */
export async function readRuntimeCheckpoint(
  directory: string,
  identity: RuntimeIdentity,
  segment: string,
  term: string,
  generation: string,
): Promise<RuntimeCheckpoint> {
  runtimeSegmentSchema.shape.id.parse(segment);
  runtimeTerminalSchema.shape.term.parse(term);
  runtimeTerminalSchema.shape.generation.parse(generation);
  const file = join(directory, 'segments', `${segment}.${term}.${generation}.json`);
  privatePath(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let record: RuntimeCheckpoint;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > RUNTIME_LIMITS.frameBytes - 1024)
      throw new Error('Runtime checkpoint exceeds its byte limit');
    record = runtimeCheckpointSchema.parse(JSON.parse(await handle.readFile('utf8')));
  } finally {
    await handle.close();
  }
  for (const key of Object.keys(identity) as Array<keyof RuntimeIdentity>)
    if (record.identity[key] !== identity[key])
      throw new Error('Runtime checkpoint identity changed');
  if (
    record.segment.id !== segment ||
    record.terminal.term !== term ||
    record.terminal.generation !== generation
  )
    throw new Error('Runtime checkpoint address changed');
  return record;
}

import { randomUUID } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  RUNTIME_LIMITS,
  runtimeJournalSchema,
  runtimeRetainedEventSchema,
  type RuntimeEventPage,
  type RuntimeIdentity,
  type RuntimeJournalRecord,
  type RuntimeRetainedEvent,
} from '@puddle/shared';
import { privatePath } from '@puddle/shared/node';
import { readRuntimeJson } from './storage.js';

/** Async, atomic and fsynced: journal IO must never stop the owner draining its PTYs. */
async function writeJournal(file: string, record: RuntimeJournalRecord): Promise<void> {
  privatePath(dirname(file), true);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(record) + '\n');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, file);
    const directory = await open(dirname(file), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

export function readRuntimeJournal(
  directory: string,
  identity: RuntimeIdentity,
): RuntimeJournalRecord {
  const record = runtimeJournalSchema.parse(readRuntimeJson(join(directory, 'events.json')));
  for (const key of Object.keys(identity) as Array<keyof RuntimeIdentity>) {
    if (record.identity[key] !== identity[key]) throw new Error('Runtime journal identity changed');
  }
  if (Buffer.byteLength(JSON.stringify(record)) > RUNTIME_LIMITS.journalBytes)
    throw new Error('Runtime journal exceeds its byte limit');
  return record;
}

interface JournalOptions {
  /** Smaller limits and a controllable writer allow deterministic pressure/crash tests. */
  maxEvents?: number;
  maxBytes?: number;
  write?: typeof writeJournal;
}

export interface RuntimeJournalReservation {
  append(event: RuntimeRetainedEvent): void;
  release(): void;
}

/**
 * Single writer, bounded essential history. Never retain bulk PTY output here.
 * Acknowledgement follows the daemon's application transaction; it is the only
 * ordinary path that removes events. Overflow is sticky evidence of lost history.
 */
export class RuntimeJournal {
  private events: RuntimeRetainedEvent[] = [];
  private cursor = 0;
  private acknowledged = 0;
  private lostThrough = 0;
  private bytes = 0;
  private reservedBytes = 0;
  private reservedEvents = 0;
  private revision = 0;
  private savedRevision = -1;
  private saving: Promise<boolean> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private retryMs = 0;
  private retryAt = 0;
  private closed = false;
  private readonly maxEvents: number;
  private readonly maxBytes: number;
  private readonly write: typeof writeJournal;

  constructor(
    private readonly directory: string,
    private readonly identity: RuntimeIdentity,
    options: JournalOptions = {},
  ) {
    this.maxEvents = Math.min(
      options.maxEvents ?? RUNTIME_LIMITS.journalEvents,
      RUNTIME_LIMITS.journalEvents,
    );
    this.maxBytes = Math.min(
      options.maxBytes ?? RUNTIME_LIMITS.journalBytes,
      RUNTIME_LIMITS.journalBytes,
    );
    this.write = options.write ?? writeJournal;
    // Reserve the bounded identity/header and numeric counters, including future
    // growth to MAX_SAFE_INTEGER. The remaining budget is encoded event bytes.
    this.bytes = Buffer.byteLength(JSON.stringify(this.record())) + 128;
    if (this.maxEvents < 1 || this.maxBytes < this.bytes)
      throw new Error('Invalid runtime journal limits');
  }

  status(): RuntimeEventPage['journal'] {
    return {
      cursor: this.cursor,
      acknowledged: this.acknowledged,
      lost_through: this.lostThrough,
      persistence_pending: this.savedRevision !== this.revision,
    };
  }

  append(value: RuntimeRetainedEvent): boolean {
    if (this.closed) throw new Error('Runtime journal is closed');
    const event = runtimeRetainedEventSchema.parse(value);
    if (event.cursor <= this.cursor) throw new Error('Runtime event cursor must advance');
    const bytes = Buffer.byteLength(JSON.stringify(event)) + 1;
    this.cursor = event.cursor;
    // Replace observations only within the trailing observation run. Every
    // lifecycle/control/terminal event freezes earlier state for reconciliation.
    // Returned pages are copies: an already-offered cursor stays a valid commit
    // boundary, and its replacement always receives a newer cursor.
    const key = this.observationKey(event);
    let previous = -1;
    if (key !== null) {
      for (let i = this.events.length - 1; i >= 0; i--) {
        const candidate = this.events[i]!;
        const candidateKey = this.observationKey(candidate);
        if (candidateKey === null) break;
        if (candidateKey === key) {
          previous = i;
          break;
        }
      }
    }
    const reclaimed =
      previous < 0 ? 0 : Buffer.byteLength(JSON.stringify(this.events[previous])) + 1;
    const retained =
      this.events.length - (previous < 0 ? 0 : 1) + this.reservedEvents < this.maxEvents &&
      this.bytes - reclaimed + this.reservedBytes + bytes <= this.maxBytes;
    if (retained) {
      if (previous >= 0) {
        this.events.splice(previous, 1);
        this.bytes -= reclaimed;
      }
      this.events.push(event);
      this.bytes += bytes;
    } else {
      // Preserve previously unacknowledged events. A bounded marker records that
      // complete reconciliation is impossible; never evict silently or kill PTYs.
      this.lostThrough = event.cursor;
    }
    this.changed();
    return retained;
  }

  private observationKey(event: RuntimeRetainedEvent): string | null {
    // Captured env is shared by the runtime's shell tabs; cwd remains terminal-specific.
    if (event.t === 'env-delta') return `env:${event.delta.name}`;
    if (event.t === 'cwd') return `cwd:${event.term}:${event.generation}`;
    return null;
  }

  /** Reserve essential outcome space before admitting an irreversible operation. */
  reserve(bytes: number, events: number): RuntimeJournalReservation | null {
    if (
      this.closed ||
      this.lostThrough !== 0 ||
      Date.now() < this.retryAt ||
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      !Number.isSafeInteger(events) ||
      events < 1 ||
      this.bytes + this.reservedBytes + bytes > this.maxBytes ||
      this.events.length + this.reservedEvents + events > this.maxEvents
    )
      return null;
    this.reservedBytes += bytes;
    this.reservedEvents += events;
    let remainingBytes = bytes;
    let remainingEvents = events;
    let released = false;
    return {
      append: (value) => {
        if (released || this.closed) throw new Error('Runtime event reservation is closed');
        const event = runtimeRetainedEventSchema.parse(value);
        const size = Buffer.byteLength(JSON.stringify(event)) + 1;
        if (event.cursor <= this.cursor || remainingEvents < 1 || size > remainingBytes)
          throw new Error('Runtime event exceeds its reservation');
        remainingEvents--;
        remainingBytes -= size;
        this.reservedEvents--;
        this.reservedBytes -= size;
        if (!this.append(event)) throw new Error('Reserved runtime event could not be retained');
      },
      release: () => {
        if (released) return;
        released = true;
        this.reservedBytes -= remainingBytes;
        this.reservedEvents -= remainingEvents;
      },
    };
  }

  read(after: number): RuntimeEventPage {
    this.checkCursor(after);
    const remaining = this.events.filter((event) => event.cursor > after);
    const events = remaining.slice(0, RUNTIME_LIMITS.eventPage);
    const more = remaining.length > events.length;
    return {
      events: structuredClone(events),
      through: more ? events.at(-1)!.cursor : this.cursor,
      more,
      gap: this.lostThrough !== 0 || after < this.acknowledged,
      journal: this.status(),
    };
  }

  acknowledge(through: number): void {
    if (this.closed) throw new Error('Runtime journal is closed');
    this.checkCursor(through);
    if (through <= this.acknowledged) return;
    if (this.lostThrough !== 0) throw new Error('Runtime event history is incomplete');
    for (const event of this.events) {
      if (event.cursor <= through) this.bytes -= Buffer.byteLength(JSON.stringify(event)) + 1;
    }
    this.events = this.events.filter((event) => event.cursor > through);
    this.acknowledged = through;
    this.changed();
  }

  private checkCursor(cursor: number): void {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > this.cursor)
      throw new Error('Invalid runtime journal cursor');
  }

  private record(): RuntimeJournalRecord {
    return {
      format: 1,
      identity: this.identity,
      cursor: this.cursor,
      acknowledged: this.acknowledged,
      lost_through: this.lostThrough,
      events: this.events.slice(),
    };
  }

  private changed(): void {
    this.revision++;
    this.schedule();
  }

  private schedule(): void {
    if (this.closed || this.timer || this.saving || this.savedRevision === this.revision) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.flush();
      },
      Math.max(10, this.retryAt - Date.now()),
    );
    this.timer.unref();
  }

  /** One bounded write attempt; failures stay visible and retry with backoff. */
  async flush(): Promise<boolean> {
    if (this.saving) await this.saving;
    if (this.savedRevision === this.revision) return true;
    if (Date.now() < this.retryAt) return false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Another waiter may have started a write while this caller was suspended.
    if (this.saving) return this.saving;
    const revision = this.revision;
    const record = this.record();
    const saving = this.write(join(this.directory, 'events.json'), record).then(
      () => {
        this.savedRevision = revision;
        this.retryMs = 0;
        this.retryAt = 0;
        return true;
      },
      () => {
        this.retryMs = Math.min(this.retryMs ? this.retryMs * 2 : 1000, 30_000);
        this.retryAt = Date.now() + this.retryMs;
        return false;
      },
    );
    this.saving = saving;
    try {
      await saving;
      return this.savedRevision === this.revision;
    } finally {
      this.saving = null;
      this.schedule();
    }
  }

  async close(): Promise<boolean> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.saving) await this.saving;
    // Give final exit records one last attempt even after a recent failure.
    this.retryAt = 0;
    return this.flush();
  }
}

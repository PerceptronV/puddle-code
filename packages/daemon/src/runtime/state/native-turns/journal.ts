import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  NATIVE_TURN_LIMITS,
  runtimeNativeTurnRecordSchema,
  runtimeNativeTurnCursorSchema,
  type RuntimeIdentity,
  type RuntimeNativeTurnRecord,
  type RuntimeNativeTurnCursor,
  type RuntimeNativeTurnPage,
} from '@puddle/shared';
import { RuntimeBufferBudget, type RuntimeByteAllowance } from '../../resources/budget.js';
import { runtimeJsonBytes, runtimeJsonRetainedBytes } from '../../transport/encoding.js';
import { RuntimeStateWriter } from '../persistence.js';
import type { NativeTurnJournalRecord } from './records.js';

/** Independent bounded source history; ordinary controller event acknowledgement cannot consume it. */
export class RuntimeNativeTurnJournal {
  private readonly epoch = randomBytes(16).toString('hex');
  private readonly entries: Array<{
    record: RuntimeNativeTurnRecord;
    bytes: number;
    release(): void;
  }> = [];
  private readonly retained: RuntimeBufferBudget;
  private readonly writing: RuntimeBufferBudget;
  private readonly write: (file: string, record: NativeTurnJournalRecord) => Promise<void>;
  private readonly maxBytes: number;
  private readonly maxRecords: number;
  private readonly headerBytes: number;
  private bytes = 0;
  private head = 0;
  private floor = 0;
  private revision = 0;
  private savedRevision = -1;
  private saving: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private retryAt = 0;
  private retryMs = 0;
  private closed = false;
  constructor(
    private readonly directory: string,
    private readonly identity: RuntimeIdentity,
    allowance?: RuntimeByteAllowance,
    options: {
      maxBytes?: number;
      maxRecords?: number;
      write?: (file: string, record: NativeTurnJournalRecord) => Promise<void>;
    } = {},
  ) {
    this.retained = new RuntimeBufferBudget(
      { bytes: 8 * 1024 * 1024, count: NATIVE_TURN_LIMITS.records },
      allowance,
    );
    this.writing = new RuntimeBufferBudget({ bytes: 12 * 1024 * 1024, count: 1 }, allowance);
    this.maxBytes = options.maxBytes ?? NATIVE_TURN_LIMITS.bytes;
    this.maxRecords = options.maxRecords ?? NATIVE_TURN_LIMITS.records;
    this.headerBytes = runtimeJsonBytes(this.record()) + 128;
    if (
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < this.headerBytes ||
      this.maxBytes > NATIVE_TURN_LIMITS.bytes ||
      !Number.isInteger(this.maxRecords) ||
      this.maxRecords < 1 ||
      this.maxRecords > NATIVE_TURN_LIMITS.records
    )
      throw new Error('Invalid native turn retention limits');
    const writer = new RuntimeStateWriter(directory, 'native-turns', { maxBytes: this.maxBytes });
    this.write =
      options.write ?? ((file, record) => writer.write(file, JSON.stringify(record) + '\n'));
  }
  status() {
    return {
      version: 1 as const,
      cursor: { epoch: this.epoch, sequence: this.head },
      floor: this.floor,
      persistencePending: this.savedRevision !== this.revision,
    };
  }
  append(input: Omit<RuntimeNativeTurnRecord, 'sequence'>): boolean {
    if (this.closed) return false;
    const parsed = runtimeNativeTurnRecordSchema.safeParse({ ...input, sequence: this.head + 1 });
    if (!parsed.success) {
      this.lose();
      return false;
    }
    const record = parsed.data;
    const prior = this.entries.find(
      (entry) =>
        entry.record.agentSessionRef === record.agentSessionRef &&
        entry.record.nativeTurnId === record.nativeTurnId &&
        entry.record.event === record.event,
    );
    if (prior) {
      const comparable = (value: RuntimeNativeTurnRecord) =>
        JSON.stringify({ ...value, sequence: 0, observedAt: '' });
      if (comparable(prior.record) !== comparable(record)) this.lose();
      return false;
    }
    const bytes = runtimeJsonBytes(record) + 1;
    this.head++;
    while (
      this.entries.length &&
      (this.entries.length >= this.maxRecords ||
        this.bytes + bytes + this.headerBytes > this.maxBytes)
    )
      this.evict();
    const release =
      bytes + this.headerBytes <= this.maxBytes
        ? this.retained.reserve(runtimeJsonRetainedBytes(record))
        : null;
    if (release) {
      this.entries.push({ record, bytes, release });
      this.bytes += bytes;
    } else this.floor = this.head;
    this.revision++;
    this.schedule();
    return !!release;
  }
  unmatched(agentSessionRef: string, nativeTurnId: string): void {
    // Late duplicates of a retained terminal observation are harmless; an unseen
    // completion proves that exact admission history is missing.
    if (
      !this.entries.some(
        ({ record }) =>
          record.agentSessionRef === agentSessionRef &&
          record.nativeTurnId === nativeTurnId &&
          record.event !== 'started',
      )
    )
      this.lose();
  }
  lose(): void {
    if (this.closed) return;
    this.floor = ++this.head;
    this.revision++;
    this.schedule();
  }
  private evict() {
    const entry = this.entries.shift()!;
    this.bytes -= entry.bytes;
    this.floor = Math.max(this.floor, entry.record.sequence);
    entry.release();
  }
  read(after: RuntimeNativeTurnCursor | null): RuntimeNativeTurnPage {
    const status = this.status(),
      common = { cursor: status.cursor, persistencePending: status.persistencePending };
    if (!after) return { state: 'baseline', ...common };
    runtimeNativeTurnCursorSchema.parse(after);
    const reason =
      after.epoch !== this.epoch
        ? 'epoch'
        : after.sequence < this.floor
          ? 'retention'
          : after.sequence > this.head
            ? 'ahead'
            : null;
    if (reason) return { state: 'gap', ...common, floor: this.floor, reason };
    const records = this.entries
      .filter((entry) => entry.record.sequence > after.sequence)
      .slice(0, NATIVE_TURN_LIMITS.page)
      .map((entry) => structuredClone(entry.record));
    return {
      state: 'events',
      ...common,
      head: this.head,
      cursor: { epoch: this.epoch, sequence: records.at(-1)?.sequence ?? this.head },
      records,
    };
  }
  private record(): NativeTurnJournalRecord {
    return {
      format: 1,
      identity: this.identity,
      cursor: { epoch: this.epoch, sequence: this.head },
      floor: this.floor,
      records: this.entries.map((entry) => entry.record),
    };
  }
  private schedule() {
    if (this.closed || this.timer || this.saving || this.savedRevision === this.revision) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.flush();
      },
      Math.max(10, this.retryAt - Date.now()),
    ).unref();
  }
  async flush(): Promise<boolean> {
    if (this.saving) await this.saving;
    if (this.savedRevision === this.revision) return true;
    if (Date.now() < this.retryAt) return false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.saving) return this.saving;
    const revision = this.revision;
    // Charge the write snapshot and encoded replacement while appends may evict its records.
    const snapshot = this.record();
    const release = this.writing.reserve(
      runtimeJsonRetainedBytes(snapshot) + 2 * runtimeJsonBytes(snapshot),
    );
    const record = release ? snapshot : null;
    const saving = (
      record
        ? Promise.resolve().then(() =>
            this.write(join(this.directory, 'native-turns.json'), record),
          )
        : Promise.reject(new Error('Native turn persistence capacity unavailable'))
    )
      .then(
        () => {
          this.savedRevision = revision;
          this.retryAt = this.retryMs = 0;
          return true;
        },
        () => {
          this.retryMs = Math.min(this.retryMs ? 2 * this.retryMs : 1000, 30000);
          this.retryAt = Date.now() + this.retryMs;
          return false;
        },
      )
      .finally(() => release?.());
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
    this.retryAt = 0;
    const saved = await this.flush();
    for (const entry of this.entries) entry.release();
    this.entries.length = 0;
    this.bytes = 0;
    return saved;
  }
}

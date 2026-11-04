import type { Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export interface AtomicFileOptions {
  directory: string;
  prefix: string;
  slots: number;
  maxBytes: number;
  syncFile?: boolean;
  syncDirectory?: boolean;
}
export interface AtomicFileIdentity {
  dev: number;
  ino: number;
}
export function atomicFileIdentity(stat: Stats): AtomicFileIdentity {
  if (!stat.isFile() || stat.nlink !== 1)
    throw new Error('Atomic persistence scratch is not exclusive');
  return { dev: stat.dev, ino: stat.ino };
}
export function requireAtomicFile(stat: Stats, identity: AtomicFileIdentity | undefined): void {
  const actual = atomicFileIdentity(stat);
  if (!identity || actual.dev !== identity.dev || actual.ino !== identity.ino)
    throw new Error('Atomic persistence scratch identity changed');
}

/** Finite names and retained uncertainty shared by synchronous and asynchronous writers. */
export class AtomicSlotPool {
  readonly options: Readonly<AtomicFileOptions>;
  private readonly occupied = new Set<number>();
  private readonly uncertain = new Set<number>();
  // Keep uncertain async descriptors alive until the owning process ends; never retry close.
  private readonly handles = new Map<number, FileHandle>();
  constructor(options: AtomicFileOptions) {
    if (
      !isAbsolute(options.directory) ||
      !/^[a-z][a-z-]*$/.test(options.prefix) ||
      !Number.isSafeInteger(options.slots) ||
      options.slots < 1 ||
      options.slots > 64 ||
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 1
    )
      throw new Error('Invalid atomic persistence limits');
    this.options = Object.freeze({ ...options });
  }
  reserve(json: string): number {
    if (Buffer.byteLength(json) > this.options.maxBytes)
      throw new Error('Atomic persistence record exceeds its byte limit');
    let slot = 0;
    while (slot < this.options.slots && this.occupied.has(slot)) slot++;
    if (slot === this.options.slots)
      throw new Error('Atomic persistence scratch capacity: temporary slots are unavailable');
    this.occupied.add(slot);
    return slot;
  }
  path(slot: number): string {
    return join(this.options.directory, `.${this.options.prefix}-${slot}.tmp`);
  }
  retain(slot: number, handle?: FileHandle): void {
    this.uncertain.add(slot);
    if (handle) this.handles.set(slot, handle);
  }
  isUncertain(slot: number): boolean {
    return this.uncertain.has(slot);
  }
  release(slot: number): void {
    if (!this.uncertain.has(slot)) this.occupied.delete(slot);
  }
}

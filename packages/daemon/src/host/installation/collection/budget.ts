import { lstatSync } from 'node:fs';

/** Aggregate reference-inventory limits across a pass; control journals retain their own bounds. */
export class CollectionBudget {
  private bytes = 0;
  private entries = 0;
  private references = 0;
  constructor(
    private readonly limits = { bytes: 16 * 1024 * 1024, entries: 16_384, references: 8192 },
  ) {}
  record(path: string): void {
    try {
      this.value(lstatSync(path).size);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  value(bytes: number): void {
    this.bytes += bytes;
    if (this.bytes > this.limits.bytes) throw new Error('Collection metadata byte budget reached');
  }
  entry(): void {
    if (++this.entries > this.limits.entries)
      throw new Error('Collection metadata entry budget reached');
  }
  reference(): void {
    if (++this.references > this.limits.references)
      throw new Error('Collection reference budget reached');
  }
}

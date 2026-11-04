import { dirname, isAbsolute } from 'node:path';
import { RUNTIME_LIMITS } from '@puddle/shared';
import { privatePath } from '@puddle/shared/node';
import { AtomicFileSlots } from '../../storage/atomic/slots.js';

type Kind = 'journal' | 'checkpoint';

/**
 * One pool per owner/kind, protected by the existing lifetime owner claim.
 * Fixed exclusive names bound orphan files even when cleanup keeps failing.
 * An occupied or uncertain slot is retained; no later write guesses it is free.
 */
export class RuntimeStateWriter {
  private readonly files: AtomicFileSlots;

  constructor(
    private readonly directory: string,
    kind: Kind,
    options: { slots?: number; maxBytes?: number } = {},
  ) {
    const slots = kind === 'journal' ? 1 : RUNTIME_LIMITS.pendingCheckpoints;
    const bytes =
      kind === 'journal' ? RUNTIME_LIMITS.journalBytes : RUNTIME_LIMITS.frameBytes - 1024;
    const selectedSlots = options.slots ?? slots;
    const maxBytes = options.maxBytes ?? bytes;
    if (
      !isAbsolute(directory) ||
      !Number.isSafeInteger(selectedSlots) ||
      selectedSlots < 1 ||
      selectedSlots > slots ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1 ||
      maxBytes > bytes
    )
      throw new Error('Invalid runtime persistence limits');
    this.files = new AtomicFileSlots({
      directory,
      prefix: kind,
      slots: selectedSlots,
      maxBytes,
      syncFile: true,
      syncDirectory: true,
    });
  }

  /** Async atomic replacement; caller budgets include the exact encoded newline. */
  async write(file: string, json: string): Promise<void> {
    if (dirname(file) !== this.directory || !file.endsWith('.json'))
      throw new Error('Runtime persistence destination changed');
    privatePath(this.directory, true);
    await this.files.write(file, json);
  }
}

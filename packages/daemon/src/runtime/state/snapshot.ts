import { join } from 'node:path';
import { RUNTIME_LIMITS, type RuntimeState } from '@puddle/shared';
import { privatePath } from '@puddle/shared/node';
import { AtomicFileSlotsSync } from '../../storage/atomic/sync.js';

/** One owner-private state replacement slot; persistence failure never owns PTY lifetime. */
export class RuntimeStateFile {
  private readonly files: AtomicFileSlotsSync;
  constructor(private readonly directory: string) {
    this.files = new AtomicFileSlotsSync({
      directory,
      prefix: 'state',
      slots: 1,
      maxBytes: RUNTIME_LIMITS.frameBytes,
      syncFile: true,
    });
  }
  write(state: RuntimeState): void {
    privatePath(this.directory, true);
    this.files.write(join(this.directory, 'state.json'), JSON.stringify(state) + '\n');
  }
}

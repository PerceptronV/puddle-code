import { hostUpdateOperationSchema, type HostUpdateOperation } from '@puddle/shared';
import { digest } from '@puddle/shared/node';
import type { PtyManager } from '../../pty/pty-manager.js';
import type { NotebookKernels } from '../../notebooks/kernels.js';
import type { CompilationService } from '../../compilation/service.js';
import type { PuddlangService } from '../../puddlang/service.js';

type Inventories = {
  terminals: ReturnType<PtyManager['interruptionInventory']>;
  notebooks: ReturnType<NotebookKernels['interruptionInventory']>;
  compilation: ReturnType<CompilationService['interruptionInventory']>;
  programmes: ReturnType<PuddlangService['interruptionInventory']>;
};

/** Internal host-wide observation, not browser authority or permission to dispatch. */
export interface UpdateImpact {
  affected: Inventories;
  fingerprint: string;
  requiresInterruption: boolean;
}

export class HostUpdateImpact {
  // A controller restart invalidates its in-memory observations even when empty.
  constructor(
    private readonly deps: {
      controller: string;
      ptys: Pick<PtyManager, 'interruptionInventory'>;
      notebooks: Pick<NotebookKernels, 'interruptionInventory'>;
      compilation: Pick<CompilationService, 'interruptionInventory'>;
      puddlang: Pick<PuddlangService, 'interruptionInventory'>;
    },
  ) {}

  inspect(input: HostUpdateOperation): UpdateImpact {
    const operation = hostUpdateOperationSchema.parse(input);
    const affected: Inventories = { terminals: [], notebooks: [], compilation: [], programmes: [] };
    if (operation.targets.some((target) => target.component === 'daemon')) {
      affected.terminals = this.deps.ptys.interruptionInventory();
      affected.notebooks = this.deps.notebooks.interruptionInventory();
      affected.compilation = this.deps.compilation.interruptionInventory();
      affected.programmes = this.deps.puddlang.interruptionInventory();
    }
    // Stable order permits a later coordinator to reject stale approval. This does
    // not freeze admission or replace the final inspection under quiescence.
    for (const items of Object.values(affected)) {
      if (items.length > 4096) throw new Error('Host interruption inventory exceeds limit');
      items.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    }
    const observation = JSON.stringify({ controller: this.deps.controller, affected });
    if (Buffer.byteLength(observation) > 1024 * 1024)
      throw new Error('Host interruption inventory exceeds limit');
    return {
      affected,
      fingerprint: digest(observation),
      requiresInterruption: Object.values(affected).some((items) => items.length > 0),
    };
  }
}

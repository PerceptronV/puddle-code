import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  hostUpdateOperationSchema,
  type HostUpdateOperation,
  type HostServiceReplacement,
} from '@puddle/shared';
import type { CompilationCommandRunner } from '../../compilation/process.js';
import {
  inspectRunningService,
  inspectHostServiceManager,
  type ServiceTarget,
} from '../../host/supervision/inspection.js';
import { prepareServiceReplacement } from '../../host/supervision/replacement.js';

export interface UpdateSupervision {
  worker: Pick<ServiceTarget, 'kind' | 'domain'> | null;
  daemon: HostServiceReplacement | null;
  blockers: Array<{
    code: 'supervisor_unavailable' | 'daemon_supervision_unknown';
    target: string;
  }>;
}

async function readMarker(home: string, uid: number): Promise<string> {
  const file = await open(
    join(home, 'supervisor'),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    // Legacy installers made this public-readable, but never trust a shared writer.
    if (!stat.isFile() || stat.size > 32 || stat.uid !== uid || (stat.mode & 0o022) !== 0)
      throw new Error('Invalid supervisor marker');
    const bytes = Buffer.alloc(33);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== stat.size || bytesRead > 32) throw new Error('Invalid supervisor marker');
    return bytes.subarray(0, bytesRead).toString('utf8').trim();
  } finally {
    await file.close();
  }
}

export class HostUpdateSupervision {
  constructor(
    private readonly deps: {
      home: string;
      pid: number;
      platform?: NodeJS.Platform;
      uid?: number;
      run?: CompilationCommandRunner;
      definitionPath?: string;
    },
  ) {}

  async inspect(input: HostUpdateOperation): Promise<UpdateSupervision> {
    const operation = hostUpdateOperationSchema.parse(input);
    const result: UpdateSupervision = { worker: null, daemon: null, blockers: [] };
    const uid = this.deps.uid ?? process.getuid?.();
    try {
      result.worker = await inspectHostServiceManager(this.deps.home, this.deps);
    } catch {
      result.blockers.push({ code: 'supervisor_unavailable', target: 'updater' });
      return result;
    }
    // A default-runtime update replaces no daemon; a manually started daemon need
    // not masquerade as a supervised one to select future runtime software.
    if (!operation.targets.some((target) => target.component === 'daemon')) return result;
    const kind = result.worker.kind;
    try {
      if ((await readMarker(this.deps.home, uid!)) !== kind)
        throw new Error('Unknown daemon supervision');
      const observed = await inspectRunningService(
        this.deps.home,
        {
          ...result.worker,
          name: kind === 'systemd' ? 'puddled.service' : 'dev.puddle.puddled',
        },
        this.deps.pid,
        this.deps.run,
      );
      result.daemon = await prepareServiceReplacement(this.deps.home, observed, this.deps);
    } catch {
      result.blockers.push({ code: 'daemon_supervision_unknown', target: 'daemon' });
    }
    return result;
  }
}

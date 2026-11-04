import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { hostUpdateOperationSchema, type HostUpdateOperation } from '@puddle/shared';
import type { CompilationCommandRunner } from '../../compilation/process.js';
import {
  inspectRunningService,
  inspectServiceManager,
  type ServiceObservation,
  type ServiceTarget,
} from '../../host/supervision/inspection.js';

export interface UpdateSupervision {
  worker: Pick<ServiceTarget, 'kind' | 'domain'> | null;
  daemon: ServiceObservation | null;
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
    },
  ) {}

  async inspect(input: HostUpdateOperation): Promise<UpdateSupervision> {
    const operation = hostUpdateOperationSchema.parse(input);
    const result: UpdateSupervision = { worker: null, daemon: null, blockers: [] };
    const platform = this.deps.platform ?? process.platform;
    const kind = platform === 'linux' ? 'systemd' : platform === 'darwin' ? 'launchd' : null;
    const uid = this.deps.uid ?? process.getuid?.();
    try {
      if (!kind || uid === undefined) throw new Error('No supported independent supervisor');
      result.worker = await inspectServiceManager(this.deps.home, kind, uid, this.deps.run);
    } catch {
      result.blockers.push({ code: 'supervisor_unavailable', target: 'updater' });
      return result;
    }
    // A default-runtime update replaces no daemon; a manually started daemon need
    // not masquerade as a supervised one to select future runtime software.
    if (!operation.targets.some((target) => target.component === 'daemon')) return result;
    try {
      if ((await readMarker(this.deps.home, uid!)) !== kind)
        throw new Error('Unknown daemon supervision');
      result.daemon = await inspectRunningService(
        this.deps.home,
        {
          ...result.worker,
          name: kind === 'systemd' ? 'puddled.service' : 'dev.puddle.puddled',
        },
        this.deps.pid,
        this.deps.run,
      );
    } catch {
      result.blockers.push({ code: 'daemon_supervision_unknown', target: 'daemon' });
    }
    return result;
  }
}

import { connect } from 'node:net';
import {
  hostMaintenanceReplySchema,
  type HostMaintenanceCommand,
  type RemoteMaintenanceClaim,
} from '@puddle/shared';
import { ipcPath, privatePath } from '@puddle/shared/node';
import { HostControlClient } from '@puddle/shared/node/host-control';

/** Each request owns a manual child channel; browser participation alone renews it. */
export class RemoteMaintenance {
  private readonly pending = new Map<string, HostControlClient>();

  constructor(
    private readonly home: string,
    private readonly profile: string,
    private readonly claim: RemoteMaintenanceClaim,
    private readonly current: () => boolean,
  ) {}

  participate(ids: string[], at: number): void {
    for (const id of ids) {
      const child = this.pending.get(id);
      if (!child || child.state !== 'ready') continue;
      if (!this.current() || !child.participate([], at)) child.close();
    }
  }

  async request(id: string, command: HostMaintenanceCommand, signal: AbortSignal) {
    if (signal.aborted || !this.current() || this.pending.has(id))
      throw new Error('Host update authority is unavailable');
    const child = new HostControlClient(
      async () => {
        const path = ipcPath(this.home, 'host');
        privatePath(path);
        return connect(path);
      },
      false,
      undefined,
      this.profile,
      this.claim,
    );
    const close = () => child.close();
    this.pending.set(id, child);
    signal.addEventListener('abort', close, { once: true });
    try {
      await child.establish();
      if (signal.aborted || !this.current()) throw new Error('Host update authority changed');
      const reply = hostMaintenanceReplySchema.parse(await child.hostMaintenance(command));
      if (signal.aborted || !this.current()) throw new Error('Host update authority changed');
      if (command.action === 'status' && reply.kind === 'status') return reply.status;
      if (command.action !== 'status' && reply.kind === 'result') return reply.result;
      throw new Error('Unexpected host update reply');
    } finally {
      this.pending.delete(id);
      signal.removeEventListener('abort', close);
      close();
    }
  }

  dispose(): void {
    for (const child of this.pending.values()) child.close();
    this.pending.clear();
  }
}

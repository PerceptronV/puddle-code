import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { realpathSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import {
  versionResponseSchema,
  type HostUpdateAdoption,
  type HostUpdateOperation,
} from '@puddle/shared';
import { HostControlClient } from '@puddle/shared/node/host-control';
import { ipcPath, privatePath } from '@puddle/shared/node';
import { readRuntimeController } from '../../runtime/ownership/storage.js';
import { readRuntime } from '../../runtime-file.js';
import { resolvePaths } from '../../paths.js';
import { readHostUpdateCheckpointEvidence } from '../checkpoints/store.js';
import { readHostUpdateAdoption } from '../checkpoints/adoption.js';
import { requireVerificationOperation } from './operation.js';

/** Recheck after other completion probes yield; an earlier receipt cannot certify a new controller. */
export function requireCurrentAdoption(home: string, observed: HostUpdateAdoption): void {
  const controller = readRuntimeController(home);
  const runtime = readRuntime(resolvePaths(home));
  if (
    !controller.active ||
    controller.id !== observed.daemon.controller.id ||
    controller.epoch !== observed.daemon.controller.epoch ||
    runtime?.pid !== observed.daemon.pid ||
    runtime.port !== observed.daemon.port
  )
    throw new Error('Replacement daemon has not proved the current adoption');
}

/** Fresh host authority and exact adoption evidence; never restarts or retries a command. */
export async function verifyHostUpdateAdoption(
  home: string,
  input: HostUpdateOperation,
): Promise<HostUpdateAdoption> {
  const operation = requireVerificationOperation(home, input);
  const stage = operation.stages.find((item) => item.record.component === 'daemon');
  if (!stage) throw new Error('Daemon adoption requires an executing verification operation');
  const authority = new HostControlClient(async () => {
    const path = ipcPath(home, 'host');
    privatePath(path);
    const socket = connect(path);
    socket.setTimeout(5000, () =>
      socket.destroy(new Error('Adoption authority inspection timed out')),
    );
    try {
      await once(socket, 'connect');
      return socket;
    } catch (error) {
      socket.destroy();
      throw error;
    }
  }, false);
  try {
    await authority.establish();
    const nonce = randomUUID();
    const reply = await authority.hostUpdate({
      action: 'status',
      id: operation.id,
      adoption_nonce: nonce,
    });
    if (
      !reply.ok ||
      reply.operation?.id !== operation.id ||
      reply.operation.phase !== operation.phase ||
      reply.operation?.revision !== operation.revision ||
      reply.operation.dispatch_id !== operation.dispatch_id ||
      reply.operation.worker_id !== operation.worker_id
    )
      throw new Error('Host update changed during adoption verification');
    const response = await fetch(`http://127.0.0.1:${authority.port}/api/version`, {
      headers: { authorization: `Bearer ${authority.credential()}` },
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('Replacement daemon HTTP authority is unavailable');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 16 * 1024) throw new Error('Replacement version response exceeds its limit');
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => {});
    }
    const httpVersion = versionResponseSchema.parse(
      JSON.parse(Buffer.concat(chunks).toString('utf8')),
    );
    const { checkpoint, digest: checkpointDigest } = readHostUpdateCheckpointEvidence(
      home,
      operation.id,
    );
    const observed = readHostUpdateAdoption(home, operation.id);
    const versions = realpathSync(join(home, 'bin', 'versions'));
    const release = realpathSync(join(versions, stage.record.generation));
    if (
      dirname(release) !== versions ||
      release !== join(versions, stage.record.generation) ||
      observed.nonce !== nonce ||
      observed.dispatch_id !== operation.dispatch_id ||
      observed.preflight !== operation.approved ||
      observed.stage !== stage.digest ||
      checkpoint.dispatch_id !== operation.dispatch_id ||
      checkpoint.preflight !== operation.approved ||
      observed.checkpoint !== checkpointDigest ||
      observed.daemon.version !== stage.record.version ||
      observed.daemon.release_path !== release ||
      observed.daemon.node_path !== join(release, 'bin', 'node') ||
      observed.daemon.entry_path !== join(release, 'daemon', 'puddled.mjs') ||
      observed.daemon.schema_version < checkpoint.daemon.schema_version ||
      observed.daemon.controller.id === checkpoint.daemon.controller.id ||
      observed.daemon.controller.epoch <= checkpoint.daemon.controller.epoch ||
      authority.state !== 'ready' ||
      authority.port !== observed.daemon.port ||
      authority.version?.version !== observed.daemon.version ||
      authority.version.protocol.major !== observed.daemon.protocol.major ||
      authority.version.protocol.minor !== observed.daemon.protocol.minor ||
      httpVersion.version !== observed.daemon.version ||
      httpVersion.protocol.major !== observed.daemon.protocol.major ||
      httpVersion.protocol.minor !== observed.daemon.protocol.minor ||
      observed.daemon.protocol.major !== stage.record.protocol.major ||
      observed.daemon.protocol.minor !== stage.record.protocol.minor ||
      observed.owners.length !== checkpoint.owners.length
    )
      throw new Error('Replacement daemon has not proved the approved adoption');
    const owners = new Map(observed.owners.map((owner) => [owner.runtime_id, owner]));
    for (const previous of checkpoint.owners) {
      const owner = owners.get(previous.identity.runtime_id);
      if (
        !owner ||
        owner.event_cursor < Math.max(0, previous.event_cursor) ||
        previous.state === 'interrupted' ||
        (['exited', 'failed'].includes(previous.state) && previous.state !== owner.state)
      )
        throw new Error('Checkpointed runtime adoption is incomplete');
    }
    requireVerificationOperation(home, operation);
    requireCurrentAdoption(home, observed);
    return observed;
  } finally {
    authority.close();
  }
}

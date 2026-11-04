import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import {
  runtimeRetiredSchema,
  runtimeSupervisorSchema,
  type RuntimeIdentity,
  type RuntimeSupervisor,
} from '@puddle/shared';
import { atomicPrivateJson, digest } from '@puddle/shared/node';
import { runCompilationCommand, type CompilationCommandRunner } from '../../compilation/process.js';
import { acquireHostClaim, HostClaimBusy } from '../../security/claims.js';
import { readRuntimeJson, runtimeDirectory } from '../ownership/storage.js';
import { serviceIsRemoved } from '../../host/supervision/removed.js';

import {
  independentServiceDefinition,
  validServicePath,
  writeServiceDefinition,
  supervisorCommand,
  dispatchService,
} from '../../host/services.js';

interface LaunchOptions {
  kind: RuntimeSupervisor['kind'];
  nodePath: string;
  entryPath: string;
  uid?: number;
  run?: CompilationCommandRunner;
}

/** No restart policy or dependency on puddled: each owner has its own service lifetime. */
export function runtimeServiceDefinition(home: string, record: RuntimeSupervisor): string {
  validServicePath(record.node_path);
  validServicePath(record.entry_path);
  return independentServiceDefinition({
    home,
    kind: record.kind,
    name: record.name,
    description: `Puddle runtime ${record.identity.runtime_id}`,
    args: [
      record.node_path,
      record.entry_path,
      '--home',
      home,
      '--runtime',
      record.identity.runtime_id,
    ],
  });
}

/**
 * Dispatch once. A repeated call only returns the recorded attempt, including
 * an uncertain one; readiness is established by authenticated runtime adoption.
 */
export async function startRuntimeService(
  home: string,
  identity: RuntimeIdentity,
  opts: LaunchOptions,
): Promise<RuntimeSupervisor> {
  const directory = runtimeDirectory(home, identity.runtime_id);
  validServicePath(home);
  validServicePath(opts.nodePath);
  validServicePath(opts.entryPath);
  // Resolve symlinks now: updates to current/default must not change this job's code.
  const nodePath = realpathSync(opts.nodePath);
  const entryPath = realpathSync(opts.entryPath);
  const hostKey = digest(realpathSync(home)).slice(0, 8);
  const uid = opts.uid ?? process.getuid?.();
  if (uid === undefined || !Number.isSafeInteger(uid) || uid < 0)
    throw new Error('Runtime supervision requires a host user');
  const record = runtimeSupervisorSchema.parse({
    format: 1,
    identity,
    kind: opts.kind,
    name:
      opts.kind === 'systemd'
        ? `puddler-${hostKey}-${identity.runtime_id}.service`
        : `dev.puddle.runtime.${hostKey}.${identity.runtime_id}`,
    domain: opts.kind === 'launchd' ? `gui/${uid}` : null,
    node_path: nodePath,
    entry_path: entryPath,
    state: 'dispatching',
  });
  const claim = acquireHostClaim(home, `runtime-dispatch:${identity.runtime_id}`);
  try {
    try {
      readRuntimeJson(join(directory, 'retired.json'));
      throw new Error('Runtime launch has been retired');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const file = join(directory, 'supervisor.json');
    try {
      const previous = runtimeSupervisorSchema.parse(readRuntimeJson(file));
      if (JSON.stringify({ ...previous, state: 'dispatching' }) !== JSON.stringify(record))
        throw new Error('Runtime supervisor attempt belongs to another launch');
      return previous;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const definition = join(directory, record.kind === 'systemd' ? record.name : 'runtime.plist');
    writeServiceDefinition(definition, runtimeServiceDefinition(home, record));
    // Persist before invoking the supervisor, so a lost reply never retries launch.
    atomicPrivateJson(file, record);
    await dispatchService(home, record, definition, opts.run);
    record.state = 'dispatched';
    atomicPrivateJson(file, record);
    return record;
  } finally {
    claim.release();
  }
}

/** Only collect an inactive owner. Runtime termination itself uses explicit control. */
export async function removeRuntimeService(
  home: string,
  identity: RuntimeIdentity,
  run: CompilationCommandRunner = runCompilationCommand,
): Promise<'removed' | 'absent' | 'owned'> {
  const directory = runtimeDirectory(home, identity.runtime_id);
  let claim: ReturnType<typeof acquireHostClaim>;
  let launchClaim: ReturnType<typeof acquireHostClaim> | undefined;
  let dispatchClaim: ReturnType<typeof acquireHostClaim> | undefined;
  try {
    launchClaim = acquireHostClaim(home, `runtime-launch:${identity.runtime_id}`);
    dispatchClaim = acquireHostClaim(home, `runtime-dispatch:${identity.runtime_id}`);
    claim = acquireHostClaim(home, `runtime:${identity.runtime_id}`);
  } catch (error) {
    dispatchClaim?.release();
    launchClaim?.release();
    if (error instanceof HostClaimBusy) return 'owned';
    throw error;
  }
  try {
    const retire = () => {
      const file = join(directory, 'retired.json');
      try {
        const previous = runtimeRetiredSchema.parse(readRuntimeJson(file));
        if (JSON.stringify(previous.identity) !== JSON.stringify(identity))
          throw new Error('Runtime retirement identity mismatch');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        atomicPrivateJson(file, { format: 1, identity });
      }
    };
    const file = join(directory, 'supervisor.json');
    let record: RuntimeSupervisor;
    try {
      record = runtimeSupervisorSchema.parse(readRuntimeJson(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      retire();
      return 'absent';
    }
    if (JSON.stringify(record.identity) !== JSON.stringify(identity))
      throw new Error('Runtime supervisor identity mismatch');
    const hostKey = digest(realpathSync(home)).slice(0, 8);
    const expectedName =
      record.kind === 'systemd'
        ? `puddler-${hostKey}-${identity.runtime_id}.service`
        : `dev.puddle.runtime.${hostKey}.${identity.runtime_id}`;
    if (
      record.name !== expectedName ||
      record.domain !== (record.kind === 'launchd' ? `gui/${process.getuid?.()}` : null)
    )
      throw new Error('Runtime supervisor target mismatch');
    // Fence a queued service start before releasing this lock after unregistering.
    retire();
    const execute = supervisorCommand(home, run);
    const absent = () => serviceIsRemoved(home, record, run);
    // A recorded removal is historical evidence, not proof of current manager state.
    if (await absent()) {
      if (record.state !== 'removed') atomicPrivateJson(file, { ...record, state: 'removed' });
      return 'removed';
    }
    if (record.kind === 'systemd') {
      try {
        await execute('systemctl', ['--user', 'stop', record.name]);
      } catch (error) {
        if (!(await absent())) throw error;
      }
      try {
        await execute('systemctl', ['--user', 'disable', record.name]);
      } catch (error) {
        await execute('systemctl', ['--user', 'daemon-reload']);
        if (!(await absent())) throw error;
      }
      await execute('systemctl', ['--user', 'daemon-reload']);
    } else {
      const target = `${record.domain!}/${record.name}`;
      try {
        await execute('/bin/launchctl', ['bootout', target]);
      } catch (error) {
        if (!(await absent())) throw error;
      }
    }
    if (!(await absent())) throw new Error('Runtime service removal is unconfirmed');
    atomicPrivateJson(file, { ...record, state: 'removed' });
    return 'removed';
  } finally {
    claim.release();
    dispatchClaim.release();
    launchClaim.release();
  }
}

import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { HostUpdateWorker } from '@puddle/shared';
import { digest, privatePath } from '@puddle/shared/node';
import type { CompilationCommandRunner } from '../../../../compilation/process.js';
import { independentServiceDefinition, supervisorCommand } from '../../../services.js';
import { serviceIsRemoved } from '../../../supervision/removed.js';
import { serviceHasNoProcess, unloadIdleLaunchdService } from '../../../supervision/stopped.js';
import { inspectSystemdProperties } from '../../../supervision/systemd.js';
import { readOwnedServiceDefinition } from '../../../supervision/definition.js';

type Service = Pick<HostUpdateWorker, 'kind' | 'name' | 'domain' | 'node_path' | 'entry_path'>;
export interface RetiringUpdateService {
  service: Service;
  definition: string;
  expected: string;
}

export function updateRetirementService(
  home: string,
  operation: string,
  service: Service,
  recovery?: string,
): RetiringUpdateService {
  const key = digest(realpathSync(home)).slice(0, 8);
  const id = recovery ?? operation;
  const family = recovery ? 'recovery' : 'update';
  const name =
    service.kind === 'systemd'
      ? `puddle-${family}-${key}-${id}.service`
      : `dev.puddle.${family}.${key}.${id}`;
  if (
    service.name !== name ||
    service.domain !== (service.kind === 'launchd' ? `gui/${process.getuid?.()}` : null)
  )
    throw new Error('Update retirement service identity changed');
  const directory = recovery
    ? join(home, 'updates/jobs', operation, 'recovery', recovery)
    : join(home, 'updates/jobs', operation);
  return {
    service,
    definition: join(
      directory,
      service.kind === 'systemd' ? name : recovery ? 'recovery.plist' : 'update.plist',
    ),
    expected: independentServiceDefinition({
      home,
      kind: service.kind,
      name,
      description: `Puddle host ${recovery ? 'recovery' : 'update'} ${operation}`,
      args: [
        service.node_path,
        service.entry_path,
        '--home',
        home,
        '--operation',
        operation,
        ...(recovery ? ['--recovery', recovery] : []),
      ],
      timeoutSeconds: 180,
    }),
  };
}

/** Remove only an exactly named idle update registration, never stop or signal its processes. */
export async function unregisterUpdateService(
  home: string,
  target: RetiringUpdateService,
  requireCurrent: () => void,
  run: CompilationCommandRunner,
): Promise<void> {
  const { service, definition, expected } = target;
  const current = async () => {
    requireCurrent();
    privatePath(definition);
    if (
      Buffer.from(await readOwnedServiceDefinition(definition), 'base64').toString('utf8') !==
      expected
    )
      throw new Error('Update service definition changed');
    if (!(await serviceHasNoProcess(home, service, run)))
      throw new Error('Update service has a process');
    if (service.kind === 'systemd') {
      const fields = await inspectSystemdProperties(home, service, 'FragmentPath,DropInPaths', run);
      if (fields?.get('FragmentPath') !== definition || fields.get('DropInPaths') !== '')
        throw new Error('Loaded update definition changed');
    }
    requireCurrent();
  };
  if (await serviceIsRemoved(home, service, run)) return;
  await current();
  if (service.kind === 'launchd') await unloadIdleLaunchdService(home, service, current, run);
  else {
    const execute = supervisorCommand(home, run);
    await execute('systemctl', ['--user', 'disable', service.name]);
    requireCurrent();
    await execute('systemctl', ['--user', 'daemon-reload']);
    // A failed ended unit may retain its manager entry after its link is removed.
    if (!(await serviceIsRemoved(home, service, run))) {
      requireCurrent();
      await execute('systemctl', ['--user', 'reset-failed', service.name]);
    }
  }
  requireCurrent();
  if (!(await serviceIsRemoved(home, service, run)))
    throw new Error('Update service removal is unconfirmed');
}

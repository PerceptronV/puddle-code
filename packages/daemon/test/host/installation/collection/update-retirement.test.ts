import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { atomicPrivateJson, digest } from '@puddle/shared/node';
import { HOST_UPDATE_HISTORY_LIMIT } from '@puddle/shared';
import { HostUpdateOperations } from '../../../../src/updates/operations/store.js';
import { readRetainedUpdate } from '../../../../src/updates/operations/retained.js';
import { CollectionBudget } from '../../../../src/host/installation/collection/budget.js';
import {
  retireUpdateRelease,
  updateReleaseRetired,
} from '../../../../src/host/installation/collection/retirement/updates.js';
import { updateRetirementService } from '../../../../src/host/installation/collection/retirement/services.js';
import { inspectReleaseReferences } from '../../../../src/host/installation/collection/review.js';
import type { CompilationCommandRunner } from '../../../../src/compilation/process.js';
import { collectionRelease } from '../../../helpers/release-collection.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
});
function fixture(recovery = false) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'puddle-update-retire-')));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const old = collectionRelease(home, '0.3.9~abc123');
  const selected = collectionRelease(home, '0.4.0~abc123');
  symlinkSync(selected.path, join(home, 'bin/current'));
  const store = new HostUpdateOperations(home);
  let operation = store.begin([{ component: 'daemon', version: old.record.version }]).operation;
  operation = store.staged(operation, {
    record: old.record,
    digest: digest(`${JSON.stringify(old.record)}\n`),
  });
  operation = store.preflight(operation, 'c'.repeat(64));
  operation = store.approve(operation, operation.preflight!);
  const dispatched = store.dispatch(operation);
  const execution = store.claimExecution(dispatched, dispatched.dispatch_id!, dispatched.approved!);
  execution.verifying();
  operation = execution.complete('d'.repeat(64));
  execution.release();
  const key = digest(home).slice(0, 8);
  const worker = {
    format: 1 as const,
    operation_id: operation.id,
    dispatch_id: operation.dispatch_id!,
    dispatch_revision: dispatched.revision,
    preflight: operation.approved!,
    kind: 'systemd' as const,
    name: `puddle-update-${key}-${operation.id}.service`,
    domain: null,
    release_path: old.path,
    node_path: join(old.path, 'bin/node'),
    entry_path: join(old.path, 'daemon/host-update.mjs'),
    installer_path: join(old.path, 'daemon/install.sh'),
    state: 'dispatched' as const,
  };
  const directory = join(home, 'updates/jobs', operation.id);
  atomicPrivateJson(join(directory, 'worker.json'), worker);
  atomicPrivateJson(join(directory, 'lifetime.json'), {
    format: 1,
    operation_id: operation.id,
    dispatch_id: operation.dispatch_id,
    worker_id: operation.worker_id,
    preflight: operation.approved,
    process_group: 2_000_000_000,
  });
  const targets = [updateRetirementService(home, operation.id, worker)];
  if (recovery) {
    const id = randomUUID();
    const service = { ...worker, name: `puddle-recovery-${key}-${id}.service` };
    const { kind, name, domain, release_path, node_path, entry_path, installer_path } = service;
    const job = {
      format: 1,
      id,
      operation_id: operation.id,
      requested_revision: operation.revision - 2,
      revision: operation.revision - 1,
      original_dispatch_id: operation.dispatch_id,
      original_worker_id: operation.worker_id,
      preflight: operation.approved,
      original_worker_digest: digest(JSON.stringify(worker)),
      actions_digest: 'e'.repeat(64),
      service: { kind, name, domain, release_path, node_path, entry_path, installer_path },
    };
    atomicPrivateJson(join(directory, 'recovery/attempts.json'), {
      format: 1,
      attempts: [{ job, execution: { id: randomUUID(), process_group: 2_000_000_001 } }],
    });
    targets.push(updateRetirementService(home, operation.id, service, id));
  }
  for (const target of targets) {
    mkdirSync(dirname(target.definition), { recursive: true, mode: 0o700 });
    writeFileSync(target.definition, target.expected, { mode: 0o600 });
  }
  const registered = new Set(targets.map(({ service }) => service.name));
  const disabled = new Set<string>();
  const commands: string[] = [];
  const run: CompilationCommandRunner = async (command) => {
    const name = command.args.at(-1)!;
    const target = targets.find(({ service }) => service.name === name);
    const verb = command.args[1]!;
    commands.push(verb);
    if (verb === 'disable') disabled.add(name);
    if (verb === 'daemon-reload') for (const id of disabled) registered.delete(id);
    if (['stop', 'start', 'kill'].includes(verb))
      throw new Error('Retirement must never stop/start a process');
    const fields = command.args.find((arg) => arg.startsWith('--property='))?.slice(11);
    const values: Record<string, string> = {
      Id: name,
      LoadState: registered.has(name) ? 'loaded' : 'not-found',
      ActiveState: 'inactive',
      SubState: 'dead',
      MainPID: '0',
      NeedDaemonReload: 'no',
      FragmentPath: target?.definition ?? '',
      DropInPaths: '',
    };
    return {
      stdout: fields
        ? fields
            .split(',')
            .map((field) => `${field}=${values[field] ?? ''}`)
            .join('\n')
        : '',
      stderr: '',
      exitCode: 0,
      signal: null,
      durationMs: 1,
    };
  };
  const retire = (runner = run, write?: typeof atomicPrivateJson) =>
    retireUpdateRelease(home, operation, () => {}, runner, new CollectionBudget(), write);
  return {
    home,
    old,
    selected,
    store,
    operation,
    worker,
    targets,
    registered,
    commands,
    run,
    retire,
  };
}

it('retires original and recovery jobs only after ended groups and fresh exact service removal', async () => {
  const f = fixture(true);
  await f.retire();
  expect(f.registered.size).toBe(0);
  expect(f.commands.filter((verb) => verb === 'disable')).toHaveLength(2);
  expect(updateReleaseRetired(f.home, f.operation, new CollectionBudget())).toBe(true);
  expect(readRetainedUpdate(f.home, f.operation.id)).toEqual(f.operation);
  for (const target of f.targets)
    expect(readFileSync(target.definition, 'utf8')).toBe(target.expected);
  const commands = f.commands.length;
  await f.retire();
  expect(f.commands).toHaveLength(commands);
});

it('observes a lost unregister reply without issuing the consumed command again', async () => {
  const f = fixture();
  let lost = true;
  const run: CompilationCommandRunner = async (command) => {
    const result = await f.run(command);
    if (command.args[1] === 'daemon-reload' && lost) {
      lost = false;
      throw new Error('lost reply');
    }
    return result;
  };
  await expect(f.retire(run)).rejects.toThrow('lost reply');
  expect(updateReleaseRetired(f.home, f.operation, new CollectionBudget())).toBe(false);
  await f.retire(run);
  expect(updateReleaseRetired(f.home, f.operation, new CollectionBudget())).toBe(true);
  expect(f.commands.filter((verb) => verb === 'disable')).toHaveLength(1);
});

it('retains uncertain service removal, changed definitions and missing lifetime proof', async () => {
  const f = fixture();
  writeFileSync(f.targets[0]!.definition, 'unexpected definition', { mode: 0o600 });
  await expect(f.retire()).rejects.toThrow('definition changed');
  expect(f.commands).not.toContain('disable');
  expect(updateReleaseRetired(f.home, f.operation, new CollectionBudget())).toBe(false);
  rmSync(join(f.home, 'updates/jobs', f.operation.id, 'lifetime.json'));
  await expect(f.retire()).rejects.toThrow('Missing consumed update lifetime');
});

it('archives terminal history before eviction and preserves it after a lost archive reply', () => {
  const f = fixture();
  for (let i = 0; i < HOST_UPDATE_HISTORY_LIMIT; i++) {
    const { operation } = f.store.begin([{ component: 'runtime', version: '0.4.0' }]);
    f.store.stopBeforeDispatch(operation, 'cancelled', 'fixture');
  }
  const lost = new HostUpdateOperations(f.home, {
    write: (path, value, options) => {
      atomicPrivateJson(path, value, options);
      if (path.includes('/retained/')) throw new Error('lost archive reply');
    },
  });
  expect(() => lost.begin([{ component: 'runtime', version: '0.4.0' }])).toThrow('lost archive');
  expect(f.store.read(f.operation.id)).toEqual(f.operation);
  expect(readRetainedUpdate(f.home, f.operation.id)).toEqual(f.operation);
  const next = f.store.begin([{ component: 'runtime', version: '0.4.0' }]);
  f.store.stopBeforeDispatch(next.operation, 'cancelled', 'fixture');
  expect(f.store.read(f.operation.id)).toBeNull();
  expect(readRetainedUpdate(f.home, f.operation.id)).toEqual(f.operation);
});

it('releases evicted stage/job references only after the final validated retirement', async () => {
  const f = fixture(true);
  const ledgerPath = join(f.home, 'updates/operations.json');
  const later = [1, 2].map((offset) => ({
    ...f.operation,
    id: randomUUID(),
    created_at: f.operation.updated_at + offset,
    updated_at: f.operation.updated_at + offset,
    targets: [{ component: 'daemon', version: f.selected.record.version }],
    stages: [
      { record: f.selected.record, digest: digest(`${JSON.stringify(f.selected.record)}\n`) },
    ],
  }));
  atomicPrivateJson(ledgerPath, { format: 1, current: later[1], history: [f.operation, later[0]] });
  const runtimes = { releaseReferences: () => [], get: () => null };
  expect((await inspectReleaseReferences(f.home, runtimes, () => {})).candidates).not.toContain(
    f.old.path,
  );
  await f.retire();
  for (let i = 0; i <= HOST_UPDATE_HISTORY_LIMIT; i++) {
    const { operation } = f.store.begin([{ component: 'runtime', version: '0.4.0' }]);
    f.store.stopBeforeDispatch(operation, 'cancelled', 'fixture');
  }
  expect((await inspectReleaseReferences(f.home, runtimes, () => {})).candidates).toContain(
    f.old.path,
  );
  rmSync(f.old.path, { recursive: true });
  await expect(inspectReleaseReferences(f.home, runtimes, () => {})).resolves.toHaveProperty(
    'candidates',
  );
  expect(existsSync(join(f.home, 'updates/jobs', f.operation.id, 'worker.json'))).toBe(true);
});

import { connect } from 'node:net';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  PROTOCOL_VERSION,
  hostStageRecordSchema,
  runtimeStateSchema,
  type HostUpdateOperation,
} from '@puddle/shared';
import { atomicPrivateJson, digest, ipcPath } from '@puddle/shared/node';
import { HostControlClient } from '@puddle/shared/node/host-control';
import { startDaemon } from '../../../src/daemon.js';
import { HostUpdateOperations } from '../../../src/updates/operations/store.js';
import type { UpdateInspection } from '../../../src/updates/preflight/inspection.js';
import * as worker from '../../../src/updates/worker/supervisor.js';
import { readRuntimeController, readRuntimeJson } from '../../../src/runtime/ownership/storage.js';
import { runtimeDatabase } from '../../helpers/runtime-database.js';
import { launchOwner, terminal, waitForOwner } from '../../helpers/runtime-fixture.js';

it.each([false, true])(
  'composes daemon maintenance through host control, preserving owner execution (accepted=%s)',
  async (accepted) => {
    const f = runtimeDatabase();
    f.launch.main.args = [
      '-c',
      `value=0
while :; do
  value=$((value + 1))
  printf '%s\\n' "$value" > "$HOME/counter"
  if [ -f "$HOME/switch" ]; then printf '\\033]0;during-maintenance\\007'; fi
  sleep 0.1
done`,
    ];
    atomicPrivateJson(join(f.directory, 'launch.json'), f.launch);
    const owner = launchOwner(f.home, f.binding.runtime_id);
    await waitForOwner(owner, f.directory);
    const pid = terminal(
      runtimeStateSchema.parse(readRuntimeJson(join(f.directory, 'state.json'))),
    ).pid!;
    f.controller.release();
    const daemon = await startDaemon({ home: f.home, adapters: [], port: 0 });
    const client = new HostControlClient(async () => connect(ipcPath(f.home, 'host')), false);
    const store = new HostUpdateOperations(f.home);
    const inspection: UpdateInspection = {
      fingerprint: digest('reviewed fixture service and runtime'),
      blockers: [],
      connector: { state: 'absent', identity: null, blockers: [] },
      compatibility: { blockers: [], candidates: [], owners: [], inventory: null },
      capacity: { blockers: [], volumes: [] },
      impact: {
        fingerprint: digest('no adjacent work'),
        requiresInterruption: false,
        affected: { terminals: [], notebooks: [], compilation: [], programmes: [] },
      },
      supervision: {
        blockers: [],
        worker: { kind: 'systemd', domain: null },
        daemon: {
          kind: 'systemd',
          name: 'puddled.service',
          domain: null,
          pid: process.pid,
          invocation: 'a'.repeat(32),
          controlGroup: '/user.slice/puddled.service',
          definition_path: null,
          definition_digest: digest('fixture service'),
        },
      },
    };
    // Host service/filesystem inspection and supervisor dispatch are simulated;
    // the control channel, daemon components, database and independent PTY are real.
    const inspect = vi.spyOn(daemon.updateInspection, 'inspect').mockResolvedValue(inspection);
    const dispatch = vi
      .spyOn(worker, 'startUpdateWorker')
      .mockImplementation(async (home, operation, options) => {
        expect(options.authorised?.()).toBe(true);
        const controller = readRuntimeController(home);
        expect(options.daemon?.outgoing).toEqual({
          pid: process.pid,
          controller: { id: controller.id, epoch: controller.epoch },
        });
        if (accepted) store.dispatch(operation);
        throw new Error(accepted ? 'Dispatch reply lost' : 'Dispatch preparation failed');
      });
    let finish: (() => void) | undefined;
    try {
      await client.establish();
      let operation: HostUpdateOperation = store.begin([
        { component: 'daemon', version: '0.4.0' },
      ]).operation;
      const record = hostStageRecordSchema.parse({
        format: 1 as const,
        component: 'daemon' as const,
        generation: '0.4.0~ABC123',
        version: '0.4.0',
        protocol: PROTOCOL_VERSION,
        checksum_verified: true,
        archive_sha256: digest('archive'),
        tree_sha256: digest('tree'),
      });
      operation = store.staged(operation, {
        record,
        digest: digest(`${JSON.stringify(record)}\n`),
      });
      const reference = ({ id, revision }: HostUpdateOperation) => ({ id, revision });
      const review = await client.hostUpdate({
        action: 'inspect',
        reference: reference(operation),
        cockpit: PROTOCOL_VERSION,
      });
      if (!review.ok || !review.operation || !review.review?.fingerprint)
        throw new Error('No review');
      finish = daemon.admission.enter();
      const applying = client.hostUpdate({
        action: 'apply',
        reference: reference(review.operation),
        fingerprint: review.review.fingerprint,
        cockpit: PROTOCOL_VERSION,
      });
      await expect
        .poll(() => {
          try {
            daemon.admission.assertOpen();
            return false;
          } catch {
            return true;
          }
        })
        .toBe(true);
      expect(inspect).toHaveBeenCalledOnce();
      const headers = { authorization: `Bearer ${client.credential()}` };
      const blocked = await fetch(`http://127.0.0.1:${daemon.port}/api/profiles`, { headers });
      expect(blocked.status).toBe(503);
      await blocked.arrayBuffer();
      const version = await fetch(`http://127.0.0.1:${daemon.port}/api/version`, { headers });
      expect(version.ok).toBe(true);
      await version.arrayBuffer();
      finish();
      expect(await applying).toMatchObject({ ok: false, code: 'failed' });
      expect(inspect).toHaveBeenCalledTimes(2);
      expect(dispatch).toHaveBeenCalledOnce();
      const cursor = f.runtimes.get(f.binding.runtime_id)!.event_cursor;
      const counter = () => Number(readFileSync(join(f.home, 'counter'), 'utf8'));
      // Owner readiness precedes the new PTY's first scheduled shell instruction.
      await expect.poll(() => existsSync(join(f.home, 'counter'))).toBe(true);
      const before = counter();
      writeFileSync(join(f.home, 'switch'), '');
      await expect.poll(counter).toBeGreaterThan(before + 2);
      process.kill(pid, 0);
      if (accepted) {
        expect(() => daemon.admission.assertOpen()).toThrow('maintenance');
        expect(f.runtimes.get(f.binding.runtime_id)!.event_cursor).toBe(cursor);
        expect(f.sessions.get(f.session.id).osc_title).not.toBe('during-maintenance');
        store.requireRecovery(store.read()!, 'Unstarted worker fenced by recovery');
        await client.hostUpdate({ action: 'status', id: operation.id });
      }
      daemon.admission.assertOpen();
      await expect.poll(() => f.sessions.get(f.session.id).osc_title).toBe('during-maintenance');
      expect(
        terminal(runtimeStateSchema.parse(readRuntimeJson(join(f.directory, 'state.json')))).pid,
      ).toBe(pid);
      expect(dispatch).toHaveBeenCalledOnce();
    } finally {
      finish?.();
      client.close();
      await daemon.stop();
      await f.reconciler.close();
      f.db.close();
      vi.restoreAllMocks();
    }
  },
);

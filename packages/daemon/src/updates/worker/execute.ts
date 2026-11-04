import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  compatibleRuntimeProtocol,
  hostStageRecordSchema,
  type HostUpdateWorker,
} from '@puddle/shared';
import { digest, readPrivateJson } from '@puddle/shared/node';
import { runCompilationCommand, type CompilationCommandRunner } from '../../compilation/process.js';
import { resolveInstalledRuntimeRelease } from '../../runtime/lifecycle/release.js';
import { HostUpdateOperations } from '../operations/store.js';

/** Runtime-default installation only. Daemon replacement requires its own adoption proof. */
export async function executeHostUpdate(
  home: string,
  job: HostUpdateWorker,
  run: CompilationCommandRunner = runCompilationCommand,
): Promise<void> {
  const store = new HostUpdateOperations(home);
  const pending = store.read(job.operation_id);
  if (!pending || pending.targets.length !== 1 || pending.targets[0]?.component !== 'runtime')
    throw new Error('Daemon updates require quiescence and adoption verification');
  const stage = pending.stages[0];
  if (!stage || !compatibleRuntimeProtocol(stage.record.protocol))
    throw new Error('Unsupported runtime update stage');
  const worker = store.claimExecution(
    { id: job.operation_id, revision: job.dispatch_revision },
    job.dispatch_id,
    job.preflight,
  );
  try {
    const result = await run({
      file: '/bin/sh',
      args: [
        job.installer_path,
        '--version',
        stage.record.version,
        '--component',
        'runtime',
        '--activate-generation',
        stage.record.generation,
        '--stage-digest',
        stage.digest,
        '--select-only',
      ],
      cwd: home,
      env: {
        HOME: dirname(home),
        PUDDLE_HOME: home,
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: 'en_US.UTF-8',
      },
      detached: false,
      timeoutMs: 120_000,
      maxOutputBytes: 64 * 1024,
    });
    if (result.exitCode !== 0) throw new Error('Exact runtime activation failed');
    worker.verifying();
    // Verify the actual selected generation and pinned executable metadata, not stdout.
    const selected = resolveInstalledRuntimeRelease(home);
    const expected = realpathSync(join(home, 'bin', 'versions', stage.record.generation));
    const receipt = hostStageRecordSchema.parse(
      readPrivateJson(join(expected, '.puddle-stage.json'), 4096),
    );
    if (
      selected.releasePath !== expected ||
      selected.build !== stage.record.version ||
      selected.protocol.major !== stage.record.protocol.major ||
      selected.protocol.minor !== stage.record.protocol.minor ||
      digest(`${JSON.stringify(receipt)}\n`) !== stage.digest
    )
      throw new Error('Selected runtime does not match the approved stage');
    worker.complete(digest(JSON.stringify({ stage: stage.digest, selected })));
  } catch (error) {
    // Even a timeout can follow a successful selector rename. Never undo or repeat it.
    try {
      worker.failed('Runtime activation or verification requires inspection');
    } catch {
      /* Keep the earlier durable phase if storage is unavailable. */
    }
    throw error;
  } finally {
    worker.release();
  }
}

import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  hostStageRecordSchema,
  type HostStageReceipt,
  type HostUpdateWorker,
} from '@puddle/shared';
import { digest, readPrivateJson } from '@puddle/shared/node';
import type { CompilationCommandRunner } from '../../compilation/process.js';
import { resolveInstalledRuntimeRelease } from '../../runtime/lifecycle/release.js';

/** Every component uses the existing exact-stage installer, without service rewrites. */
export async function selectUpdateStage(
  home: string,
  job: HostUpdateWorker,
  stage: HostStageReceipt,
  run: CompilationCommandRunner,
): Promise<void> {
  const result = await run({
    file: '/bin/sh',
    args: [
      job.installer_path,
      '--version',
      stage.record.version,
      '--component',
      stage.record.component,
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
  if (result.exitCode !== 0) throw new Error('Exact component activation failed');
}

/** Successful installer output is not evidence that the selector changed. */
export function verifyUpdateSelection(home: string, stage: HostStageReceipt) {
  const versions = realpathSync(join(home, 'bin', 'versions'));
  const expected = realpathSync(join(versions, stage.record.generation));
  const selected = realpathSync(
    join(home, 'bin', stage.record.component === 'runtime' ? 'runtime-current' : 'current'),
  );
  const receipt = hostStageRecordSchema.parse(
    readPrivateJson(join(expected, '.puddle-stage.json'), 4096),
  );
  if (
    dirname(expected) !== versions ||
    expected !== join(versions, stage.record.generation) ||
    selected !== expected ||
    digest(`${JSON.stringify(receipt)}\n`) !== stage.digest
  )
    throw new Error('Selected component does not match the approved stage');
  if (stage.record.component === 'runtime') {
    const runtime = resolveInstalledRuntimeRelease(home);
    if (
      runtime.releasePath !== expected ||
      runtime.build !== stage.record.version ||
      runtime.protocol.major !== stage.record.protocol.major ||
      runtime.protocol.minor !== stage.record.protocol.minor
    )
      throw new Error('Selected runtime does not match the approved stage');
  }
  return { component: stage.record.component, release_path: selected, stage: stage.digest };
}

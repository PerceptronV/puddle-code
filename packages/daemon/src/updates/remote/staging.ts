import { homedir } from 'node:os';
import { releaseRepositorySchema, type HostUpdateTargets } from '@puddle/shared';
import { parseHostStageOutput, updateWorkerExecutables } from '@puddle/shared/node/host-control';
import { runCompilationCommand, type CompilationCommandRunner } from '../../compilation/process.js';

/** Host-owned source and pinned installer; no browser path, URL, environment or receipt is accepted. */
export async function stageRemoteHostUpdate(
  home: string,
  release: string,
  repository: string,
  target: HostUpdateTargets[number],
  authorised: () => boolean,
  run: CompilationCommandRunner = runCompilationCommand,
) {
  const source = releaseRepositorySchema.parse(repository);
  const executable = updateWorkerExecutables(home, release);
  if (!authorised()) throw new Error('Host maintenance authority expired');
  const result = await run({
    file: '/bin/sh',
    args: [
      executable.installer_path,
      '--repo',
      source,
      '--version',
      target.version,
      '--component',
      target.component,
      '--stage-only',
    ],
    cwd: home,
    env: {
      HOME: homedir(),
      PUDDLE_HOME: home,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      LANG: 'en_US.UTF-8',
    },
    timeoutMs: 120_000,
    maxOutputBytes: 256 * 1024,
  });
  if (!authorised()) throw new Error('Host maintenance authority expired');
  if (result.exitCode !== 0) throw new Error('Host release preparation failed');
  return parseHostStageOutput(result.stdout, target.component, target.version);
}

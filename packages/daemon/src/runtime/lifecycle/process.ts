import { spawn } from 'node:child_process';
import type { RuntimeSupervisor } from '@puddle/shared';
import { runCompilationCommand, type CompilationCommandRunner } from '../../compilation/process.js';

/** Dispatch only. Authenticated adoption establishes readiness, never the spawn event. */
export async function dispatchDetachedRuntime(
  home: string,
  record: RuntimeSupervisor,
  environment?: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      record.node_path,
      [record.entry_path, '--home', home, '--runtime', record.identity.runtime_id],
      {
        cwd: home,
        env: environment,
        detached: true,
        stdio: 'ignore',
      },
    );
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

/** Only proves separation from the launching group, not logout/cgroup survival. */
export async function requireIndependentProcessGroup(
  home: string,
  run: CompilationCommandRunner = runCompilationCommand,
): Promise<void> {
  const result = await run({
    file: '/bin/ps',
    args: ['-o', 'pgid=', '-p', String(process.pid)],
    cwd: home,
    timeoutMs: 3000,
    maxOutputBytes: 128,
  });
  if (
    result.exitCode !== 0 ||
    result.stderr ||
    !/^\s*[1-9][0-9]*\s*$/.test(result.stdout) ||
    Number(result.stdout.trim()) !== process.pid
  )
    throw new Error('Runtime is not in its own process group');
}

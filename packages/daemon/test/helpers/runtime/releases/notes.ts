import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { expect } from 'vitest';
import { releaseNotesSchema } from '@puddle/shared';
import { atomicPrivateJson, ipcPath } from '@puddle/shared/node';
import { HostControlClient } from '@puddle/shared/node/host-control';
import { resolvePaths } from '../../../../src/paths.js';
import { readRuntime } from '../../../../src/runtime-file.js';
import { resolveInstalledRuntimeRelease } from '../../../../src/runtime/lifecycle/release.js';
import { waitFor } from '../../daemon-fixtures.js';
import { retainRuntimeHome } from '../../runtime-fixture.js';

/** Actual packaged HTTP projection; no providers, installed jobs or caller-selected paths. */
export async function verifyPackagedNotes(
  release: string,
  home: string,
  env: NodeJS.ProcessEnv,
  version: string,
) {
  const runtime = resolveInstalledRuntimeRelease(home);
  // The continuity fixture has already selected a separate immutable repair tree.
  expect(runtime.releasePath).not.toBe(release);
  const notesFile = join(release, 'RELEASE_NOTES.md');
  const original = readFileSync(notesFile, 'utf8');
  const runtimeNotes = readFileSync(join(runtime.releasePath, 'RELEASE_NOTES.md'), 'utf8');
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('No isolated fixture port');
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  atomicPrivateJson(join(home, 'config.json'), {
    configVersion: 3,
    port: address.port,
    autoResume: false,
    agentPath: '',
  });
  // Only this copied fixture tree changes. Running notes must come from its bundle.
  writeFileSync(notesFile, '# Must not replace the running bundle notes\n');
  const daemon = spawn(join(release, 'puddled'), [], {
    env: { ...env, PUDDLE_HOME: home },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errors = '';
  daemon.stderr!.on('data', (chunk: Buffer) => {
    errors = (errors + chunk.toString()).slice(-8192);
  });
  const control = new HostControlClient(async () => connect(ipcPath(home, 'host')));
  try {
    await waitFor(() => {
      if (daemon.exitCode !== null || daemon.signalCode !== null)
        throw new Error(`Packaged notes daemon exited: ${errors}`);
      return readRuntime(resolvePaths(home))?.pid === daemon.pid;
    });
    await control.establish();
    expect(control.version?.version).toBe(version);
    const response = await fetch(`http://127.0.0.1:${control.port}/api/release-notes`, {
      headers: { authorization: `Bearer ${control.credential()}` },
      signal: AbortSignal.timeout(10_000),
    });
    expect(response.status, errors).toBe(200);
    expect(releaseNotesSchema.parse(await response.json())).toEqual({
      releases: [
        { component: 'daemon', version, markdown: original },
        { component: 'runtime', version: runtime.build, markdown: runtimeNotes },
      ],
    });
  } finally {
    control.close();
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill('SIGTERM');
    try {
      await waitFor(() => daemon.exitCode !== null || daemon.signalCode !== null);
      expect(daemon.exitCode, errors).toBe(0);
    } catch (error) {
      retainRuntimeHome(home);
      // eslint-disable-next-line no-unsafe-finally -- Preserve the fixture when daemon cleanup cannot be proved.
      throw new Error(`Packaged notes daemon cleanup unconfirmed; retained ${home}`, {
        cause: error,
      });
    }
    writeFileSync(notesFile, original);
  }
}

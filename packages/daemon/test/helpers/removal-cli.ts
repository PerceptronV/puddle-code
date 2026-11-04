import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { hostReleaseCapabilities } from '@puddle/shared';
import { atomicPrivateJson } from '@puddle/shared/node';
import { removalHostFixture } from './removal-host.js';
import { scriptedRemovalSupervisor } from './removal-supervisor.js';
import { buildHostConnectorEntry, buildHostUpdateEntry } from './host-update-entry.js';

/** Built CLI and real pinned connector/helper, with isolated homes and scripted supervision. */
export async function removalCliFixture(options: { nativeBootIdentity?: boolean } = {}) {
  const f = removalHostFixture();
  try {
    const { node } = await buildHostUpdateEntry(f.release, options);
    await buildHostConnectorEntry(f.release);
    // Test supervisor commands must survive a purge, like /usr/bin/systemctl.
    const commands = join(f.release, 'bin/fixture-commands');
    const env = scriptedRemovalSupervisor(f.home, node, true, commands);
    const commandLog = join(f.home, 'bin/fixture-command-log');
    writeFileSync(
      join(commands, 'sh'),
      '#!/bin/sh\nprintf \'%s\\n\' "$2" >> "$PUDDLE_HOME/bin/fixture-command-log"\nexec /bin/sh "$@"\n',
      { mode: 0o700 },
    );
    writeFileSync(
      join(f.release, 'HOST_CAPABILITIES.json'),
      JSON.stringify(hostReleaseCapabilities('0.4.0')),
    );
    writeFileSync(join(f.release, 'VERSION'), '0.4.0\n');
    const profiles = ['a'.repeat(10), 'b'.repeat(10)].map((id) =>
      join(f.home, 'remote/profiles', id, 'config.json'),
    );
    const config = {
      enabled: true,
      host: crypto.randomUUID(),
      account: 'fixture',
      credential: 'a'.repeat(64),
      service: 'https://relay.example.test',
      app: 'https://app.example.test',
    };
    for (const path of profiles) atomicPrivateJson(path, config);
    const cli = fileURLToPath(new URL('../../../cli/dist/index.js', import.meta.url));
    const invoke = (...args: string[]) =>
      promisify(execFile)(process.execPath, [cli, ...args], { env, timeout: 60_000 });
    return { ...f, profiles, config, env, invoke, commandLog };
  } catch (error) {
    f.close();
    throw error;
  }
}

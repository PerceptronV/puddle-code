import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { lifecycleVersionAtLeast } from '../../src/agents/lifecycle-version.js';

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it('uses the launch PATH and does not reuse a service-environment failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'puddle-version-env-'));
  directories.push(directory);
  writeFileSync(join(directory, 'fixture-agent'), '#!/bin/sh\nprintf "agent 1.2.3\\n"\n', {
    mode: 0o700,
  });
  vi.stubEnv('PATH', '/usr/bin:/bin');
  await expect(lifecycleVersionAtLeast('fixture-agent', ['--version'], [1, 2, 3])).resolves.toBe(
    false,
  );
  await expect(
    lifecycleVersionAtLeast('fixture-agent', ['--version'], [1, 2, 3], { PATH: directory }),
  ).resolves.toBe(true);
  expect(process.env.PATH).toBe('/usr/bin:/bin');
});

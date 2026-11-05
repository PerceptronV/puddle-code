import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { independentServiceDefinition } from '../../src/host/services.js';

const definition = (home: string) =>
  independentServiceDefinition({
    home,
    kind: 'systemd',
    name: 'puddle-definition-test.service',
    description: 'Puddle service definition test',
    args: ['/bin/true'],
  });

describe('systemd service paths', () => {
  it('keeps directory paths literal instead of applying command argument quoting', () => {
    expect(definition('/tmp/puddle %h $HOME "quoted" \\ space ')).toContain(
      'WorkingDirectory=/tmp/puddle %%h $HOME "quoted" \\ space /.\n',
    );
  });

  const nativeSystemd =
    process.platform === 'linux' &&
    spawnSync('systemd-analyze', ['--version'], { timeout: 5000 }).status === 0;
  it.runIf(nativeSystemd)('passes the native systemd unit parser', () => {
    const directory = mkdtempSync(join(tmpdir(), 'puddle-unit-verify-'));
    try {
      const file = join(directory, 'puddle-definition-test.service');
      for (const home of [directory, `${directory}/space %h $HOME "quote" \\ end `]) {
        writeFileSync(file, definition(home));
        const result = spawnSync('systemd-analyze', ['--man=no', 'verify', file], {
          encoding: 'utf8',
          timeout: 10000,
        });
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

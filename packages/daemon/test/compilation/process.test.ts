import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { runCompilationCommand } from '../../src/compilation/process.js';

it.each([true, false])(
  'keeps subprocess group ownership explicit (detached=%s)',
  async (detached) => {
    const parentGroup = Number(
      execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)], {
        encoding: 'utf8',
      }).trim(),
    );
    const result = await runCompilationCommand({
      file: process.execPath,
      args: [
        '--input-type=module',
        '-e',
        `import { execFileSync } from 'node:child_process';
      const group = Number(execFileSync('/bin/ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim());
      console.log(JSON.stringify({ pid: process.pid, group }));`,
      ],
      cwd: process.cwd(),
      env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' },
      detached,
      timeoutMs: 5000,
      maxOutputBytes: 1024,
    });
    const child = JSON.parse(result.stdout) as { pid: number; group: number };
    expect(child.group).toBe(detached ? child.pid : parentGroup);
  },
);

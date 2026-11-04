// Independent service fixtures need process inspection and an orphan reaper.
// Exercise both before packaging so a container problem has a direct diagnostic.
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);
await execute('/bin/ps', ['-o', 'pid=,ppid=,pgid=,stat=', '-p', String(process.pid)]);
const directory = mkdtempSync(join(tmpdir(), 'puddle-reaping-check-'));
const gate = join(directory, 'exit');
let pid;
let ended = false;
try {
  // The grandchild waits for our gate: its parent must have exited before we
  // allow it to exit, so a fast child cannot accidentally bypass orphan reaping.
  const child = `
    const { existsSync } = require('node:fs');
    const deadline = Date.now() + 10000;
    const timer = setInterval(() => {
      if (existsSync(process.argv[1]) || Date.now() > deadline) clearInterval(timer);
    }, 20);
  `;
  const parent = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(child)}, process.argv[1]], {
      detached: true, stdio: 'ignore'
    });
    child.once('error', error => { console.error(error); process.exitCode = 1; });
    child.once('spawn', () => { console.log(child.pid); child.unref(); });
  `;
  const result = await execute(process.execPath, ['-e', parent, gate], {
    timeout: 5000,
    env: { PATH: '/usr/bin:/bin', HOME: directory },
  });
  pid = Number(result.stdout.trim());
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Missing orphan probe PID');
  writeFileSync(gate, 'exit');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      ended = true;
      break;
    }
    await delay(20);
  }
  if (!ended) {
    const state = await execute('/bin/ps', ['-o', 'pid=,ppid=,pgid=,stat=', '-p', String(pid)]);
    throw new Error(
      `Runtime fixture orphan was not reaped; run the container with --init.\n${state.stdout}`,
    );
  }
  console.log('Runtime test host process inspection and orphan reaping passed');
} finally {
  // The probe exits itself within ten seconds even if the gate cannot be written.
  // Never signal a recorded group after an inspection failure or PID reuse.
  rmSync(directory, { recursive: true, force: true });
}

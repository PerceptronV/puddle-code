import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';

const require = createRequire(import.meta.url);

export async function packageDesktop(args, run = runBuilder, wait = setTimeout) {
  // Packaging is repeatable; publishing must remain in the separate release job.
  if (args.some((arg) => /^(-p|--publish)(=|$)/.test(arg)))
    throw new Error('Publishing is not permitted by the packaging retry wrapper');
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await run([...args, '--publish', 'never']);
    if (result.code === 0) return 0;
    if (
      result.signal ||
      attempt === 3 ||
      !/Response code (?:408|429|50[0234])\b|\b(?:ECONNRESET|ETIMEDOUT|EAI_AGAIN)\b/.test(
        result.output,
      )
    )
      return result.code || 1;
    console.warn(`Transient packaging download failure; retrying (${attempt + 1}/3)`);
    await wait(attempt * 10_000);
  }
}

function runBuilder(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        require.resolve('electron-builder/cli.js'),
        '--config',
        fileURLToPath(new URL('../electron-builder.cjs', import.meta.url)),
        ...args,
      ],
      {
        cwd: fileURLToPath(new URL('../', import.meta.url)),
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    for (const [stream, destination] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ])
      stream.on('data', (data) => {
        destination.write(data);
        output = (output + data.toString()).slice(-64 * 1024);
      });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, output }));
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url))
  process.exitCode = await packageDesktop(process.argv.slice(2));

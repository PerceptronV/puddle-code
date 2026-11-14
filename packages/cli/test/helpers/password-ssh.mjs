/** Password-only master for reconnect tests; all commands/forwards use fake-ssh. */
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const master = process.env.FAKE_SSH_PASSWORD_MASTER;
const control = args.indexOf('-O');
if (control !== -1) {
  if (args[control + 1] === 'check') process.exit(existsSync(master) ? 0 : 255);
  process.exit(0);
}

if (!existsSync(master)) {
  if (args.includes('BatchMode=yes')) process.exit(255);
  const helper = spawn(process.env.SSH_ASKPASS, ['Password:'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let answer = '';
  helper.stdout.on('data', (chunk) => (answer += chunk));
  const code = await new Promise((resolve) => helper.once('close', resolve));
  if (code !== 0 || answer.trim() !== 'fixture-password') process.exit(255);
  writeFileSync(master, 'authenticated');
}

await import('./fake-ssh.mjs');

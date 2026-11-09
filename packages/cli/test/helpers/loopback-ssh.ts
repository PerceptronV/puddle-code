import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { findFreePort, waitForTcp } from '../../src/lib/transport/net.js';
import { shellQuote, SshTransport } from '../../src/lib/transport/ssh.js';

/** Real OpenSSH, private throwaway keys and one loopback listener; no user SSH configuration. */
export async function loopbackSsh(hostHome: string) {
  // Leave room for OpenSSH's temporary suffix within macOS's ControlPath limit.
  const temporary = mkdtempSync(
    join(process.platform === 'darwin' ? '/private/tmp' : tmpdir(), 'puddle-ssh-'),
  );
  const clientHome = join(temporary, 'client');
  const binary = join(temporary, 'ssh');
  let sshd: ChildProcess | undefined;
  let output = '';
  const disconnect = () => {
    try {
      execFileSync(binary, ['-o', `ControlPath=${clientHome}/cm-%C`, '-O', 'exit', 'fixture'], {
        timeout: 5000,
        stdio: 'ignore',
      });
      return true;
    } catch {
      // A dedicated-channel run or failed setup may never have opened a master.
      return false;
    }
  };
  const close = async () => {
    disconnect();
    if (sshd && sshd.exitCode === null && sshd.signalCode === null) {
      const exited = new Promise<void>((resolve) => sshd!.once('exit', () => resolve()));
      sshd.kill('SIGTERM');
      await exited;
    }
    rmSync(temporary, { recursive: true, force: true });
  };
  try {
    mkdirSync(clientHome, { mode: 0o700 });
    const key = join(temporary, 'client-key');
    const hostKey = join(temporary, 'host-key');
    for (const file of [key, hostKey])
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', file]);
    const port = await findFreePort();
    const serverConfig = join(temporary, 'sshd_config');
    writeFileSync(
      serverConfig,
      `Port ${port}\nListenAddress 127.0.0.1\nHostKey ${hostKey}\nPidFile ${temporary}/sshd.pid\nAuthorizedKeysFile ${key}.pub\nStrictModes no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nAcceptEnv PUDDLE_HOME\nAllowUsers ${userInfo().username}\nLogLevel ERROR\n`,
      { mode: 0o600 },
    );
    writeFileSync(
      join(temporary, 'known_hosts'),
      `[127.0.0.1]:${port} ${readFileSync(hostKey + '.pub', 'utf8')}`,
      { mode: 0o600 },
    );
    const config = join(temporary, 'ssh_config');
    writeFileSync(
      config,
      `Host fixture\n HostName 127.0.0.1\n Port ${port}\n User ${userInfo().username}\n IdentityFile ${key}\n IdentitiesOnly yes\n BatchMode yes\n StrictHostKeyChecking yes\n UserKnownHostsFile ${temporary}/known_hosts\n SetEnv PUDDLE_HOME=${JSON.stringify(hostHome)}\n`,
      { mode: 0o600 },
    );
    writeFileSync(binary, `#!/bin/sh\nexec /usr/bin/ssh -F ${shellQuote(config)} "$@"\n`, {
      mode: 0o700,
    });
    sshd = spawn('/usr/sbin/sshd', ['-D', '-e', '-f', serverConfig], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    sshd.stderr!.on('data', (chunk) => {
      output = (output + String(chunk)).slice(-8192);
    });
    if (!(await waitForTcp(port, 5000))) throw new Error('Loopback sshd failed: ' + output);
    return {
      binary,
      output: () => output,
      disconnect,
      close,
      transport(platform: NodeJS.Platform = process.platform) {
        // Only construction reads this value; restore it before any asynchronous work.
        const previous = process.env.PUDDLE_HOME;
        process.env.PUDDLE_HOME = clientHome;
        try {
          return new SshTransport('fixture', { sshBinary: binary, platform });
        } finally {
          if (previous === undefined) delete process.env.PUDDLE_HOME;
          else process.env.PUDDLE_HOME = previous;
        }
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { clientHome } from '../paths.js';
import { CliError } from '../types.js';
import type { ExecOptions, ExecResult, Transport } from './transport.js';

export interface SshOptions {
  /** The ssh binary to spawn — the test seam (a fake shim in tests). */
  sshBinary?: string;
  /** The scp binary for copyTo; defaults alongside sshBinary. */
  scpBinary?: string;
  /** Injected platform; win32 disables ControlMaster (unsupported there). */
  platform?: NodeJS.Platform;
}

/**
 * SSH transport over the system ssh binary (never a JS SSH library — the
 * user's ~/.ssh/config, agents, jump hosts, and 2FA prompting come free,
 * SPEC §10). A multiplexed master connection is opened once, interactively,
 * inheriting the TTY so password/2FA prompts are typed at most once; every
 * exec, the tunnel, and scp then reuse it. ControlPersist keeps the master
 * for a quick next connect; we never -O exit it.
 */
export class SshTransport implements Transport {
  readonly kind = 'ssh' as const;
  readonly label: string;
  private readonly ssh: string;
  private readonly scp: string;
  private readonly controlArgs: string[];

  constructor(
    readonly host: string,
    opts: SshOptions = {},
  ) {
    this.label = host;
    this.ssh = opts.sshBinary ?? 'ssh';
    this.scp = opts.scpBinary ?? 'scp';
    const platform = opts.platform ?? process.platform;
    if (platform === 'win32') {
      // Windows OpenSSH has no multiplexing: every spawn may prompt again.
      this.controlArgs = [];
    } else {
      const home = clientHome();
      mkdirSync(home, { recursive: true });
      this.controlArgs = [
        '-o',
        'ControlMaster=auto',
        '-o',
        // %C (a hash of the connection) keeps the socket path under the Unix
        // ~104-byte cap however long user@host is.
        `ControlPath=${home}/cm-%C`,
        '-o',
        'ControlPersist=10m',
      ];
    }
  }

  get hasControlMaster(): boolean {
    return this.controlArgs.length > 0;
  }

  /** Argv prefix every ssh/scp spawn shares. */
  args(...rest: string[]): string[] {
    return [...this.controlArgs, ...rest];
  }

  /**
   * Open the master interactively — ssh's own prompts go straight to the
   * user's TTY. Exit 0 leaves a live control socket behind.
   */
  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.ssh, this.args(this.host, 'true'), { stdio: 'inherit' });
      child.on('error', (err) =>
        reject(new CliError('ssh_unreachable', `could not run ${this.ssh}: ${err.message}`)),
      );
      child.on('close', (code) => {
        if (code === 0) resolve();
        else {
          reject(
            new CliError(
              'ssh_unreachable',
              `could not open an SSH connection to ${this.host}`,
              `check that '${this.ssh} ${this.host}' works on its own`,
            ),
          );
        }
      });
    });
  }

  /** Whether the master connection is still alive (-O check). */
  isAlive(): Promise<boolean> {
    if (!this.hasControlMaster) return Promise.resolve(true);
    return new Promise((resolve) => {
      const child = spawn(this.ssh, this.args('-O', 'check', this.host), { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    });
  }

  exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    return new Promise((resolve) => {
      const child = spawn(this.ssh, this.args(this.host, '--', `sh -c ${shellQuote(command)}`), {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timer: NodeJS.Timeout | undefined;
      if (opts.timeoutMs !== undefined) {
        timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
        timer.unref();
      }
      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        opts.onStdout?.(text);
      });
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', (err) => {
        if (timer) clearTimeout(timer);
        resolve({ code: -1, stdout, stderr: stderr + String(err) });
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        resolve({ code: code ?? -1, stdout, stderr });
      });
      if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
      else child.stdin.end();
    });
  }

  async readFile(path: string): Promise<string | null> {
    const result = await this.exec(`cat ${path}`, { timeoutMs: 15_000 });
    return result.code === 0 ? result.stdout : null;
  }

  async copyTo(localPath: string, destPath: string): Promise<void> {
    await this.exec(`mkdir -p $(dirname ${destPath})`, { timeoutMs: 15_000 });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.scp, [...this.controlArgs, localPath, `${this.host}:${destPath}`], {
        stdio: ['ignore', 'ignore', 'inherit'],
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new CliError('ssh_unreachable', `scp to ${this.host} failed (exit ${code})`));
      });
    });
  }

  dispose(): void {
    // Deliberately nothing: ControlPersist keeps the master warm for the
    // next connect; the tunnel and exec children die with their own spawns.
  }
}

/** POSIX single-quote escaping for embedding in a remote sh -c. */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { clientHome } from '../paths.js';
import type { ExecOptions, ExecResult, Transport } from './transport.js';

/** Local mode: commands run on this machine, files read from this disk. */
export class LocalTransport implements Transport {
  readonly kind = 'local' as const;
  readonly label = 'this machine';

  exec(command: string, opts: ExecOptions = {}): Promise<ExecResult> {
    return new Promise((resolve) => {
      const child = spawn('sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
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

  readFile(path: string): Promise<string | null> {
    try {
      return Promise.resolve(readFileSync(expandHome(path), 'utf8'));
    } catch {
      return Promise.resolve(null);
    }
  }

  copyTo(localPath: string, destPath: string): Promise<void> {
    const dest = expandHome(destPath);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(localPath, dest);
    return Promise.resolve();
  }

  dispose(): void {}
}

/**
 * Host-path constants are shell expressions (`"${PUDDLE_HOME:-$HOME/.puddle}"`)
 * for exec'd commands; direct fs access resolves them the same way the
 * daemon's paths.ts does.
 */
function expandHome(path: string): string {
  return path.startsWith('"${PUDDLE_HOME:-$HOME/.puddle}"')
    ? clientHome() + path.slice('"${PUDDLE_HOME:-$HOME/.puddle}"'.length)
    : path;
}

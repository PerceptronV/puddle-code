import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { ExecOptions, ExecResult } from './transport.js';

// UTF-16 code units, bounding retained diagnostics to at most 128 KiB.
const STDERR_TAIL_LENGTH = 64 * 1024;

/** Collect a command's result without retaining an unbounded streamed log. */
export function collectExecOutput(
  child: ChildProcessWithoutNullStreams,
  opts: ExecOptions,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const appendStderr = (text: string) => {
      stderr += text;
      if (opts.capture === 'stream') stderr = stderr.slice(-STDERR_TAIL_LENGTH);
    };
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs !== undefined) {
      timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
      timer.unref();
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text: string) => {
      if (opts.capture !== 'stream') stdout += text;
      opts.onStdout?.(text);
    });
    child.stderr.on('data', appendStderr);
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      appendStderr(String(err));
      resolve({ code: -1, stdout, stderr });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    child.stdin.on('error', () => {}); // A command may exit before consuming input.
    child.stdin.end(opts.stdin);
  });
}

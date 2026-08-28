import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface LatexCommand {
  file: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface LatexCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type LatexCommandRunner = (command: LatexCommand) => Promise<LatexCommandResult>;

export class LatexCommandError extends Error {
  constructor(
    message: string,
    public readonly command: LatexCommand,
    public readonly result?: LatexCommandResult,
  ) {
    super(message);
    this.name = 'LatexCommandError';
  }
}

const liveCommands = new Set<ReturnType<typeof spawn>>();

/** Terminate compiler process groups when their owning daemon shuts down. */
export function disposeLatexCommands(): void {
  const commands = [...liveCommands];
  for (const child of commands) terminateGroup(child, 'SIGTERM');
  setTimeout(() => {
    for (const child of commands) {
      if (liveCommands.has(child)) terminateGroup(child, 'SIGKILL');
    }
  }, 1_000).unref();
}

/**
 * Run one compiler command without a shell, with bounded time/output and an
 * isolated process group so cancellation also reaches child bibliography
 * processes started by latexmk.
 */
export const runLatexCommand: LatexCommandRunner = (command) =>
  new Promise((resolve, reject) => {
    const timeoutMs = command.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = command.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
    const child = spawn(command.file, command.args, {
      cwd: command.cwd,
      env: command.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    liveCommands.add(child);
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let settled = false;
    let exited = false;
    let forced = false;

    const terminate = (): void => {
      terminateGroup(child, 'SIGTERM');
      setTimeout(() => {
        if (exited || child.pid === undefined) return;
        forced = true;
        terminateGroup(child, 'SIGKILL');
      }, 1_000).unref();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      terminate();
      rejectOnce(`LaTeX command exceeded ${timeoutMs} ms`);
    }, timeoutMs);
    timer.unref();

    const rejectOnce = (message: string, result?: LatexCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new LatexCommandError(message, command, result));
    };

    const collect = (which: 'stdout' | 'stderr', chunk: Buffer): void => {
      if (settled) return;
      if (stdout.byteLength + stderr.byteLength + chunk.byteLength > maxOutputBytes) {
        terminate();
        rejectOnce(`LaTeX command output exceeded ${maxOutputBytes} bytes`);
        return;
      }
      if (which === 'stdout') stdout = Buffer.concat([stdout, chunk]);
      else stderr = Buffer.concat([stderr, chunk]);
    };

    child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));
    child.once('error', (error) => rejectOnce(`Could not start LaTeX command: ${error.message}`));
    child.once('close', (code, signal) => {
      liveCommands.delete(child);
      exited = true;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = {
        exitCode: code ?? (forced || signal === 'SIGKILL' ? 137 : 1),
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
      };
      if (code === 0) resolve(result);
      else {
        reject(
          new LatexCommandError(
            `LaTeX command exited with ${result.exitCode}${signal ? ` (${signal})` : ''}`,
            command,
            result,
          ),
        );
      }
    });
  });

function terminateGroup(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

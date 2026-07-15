/**
 * A place commands run and files are read: this machine (local mode) or an
 * SSH host (remote mode). Bootstrap, discovery, and `logs` are written
 * against this interface so they behave identically in both modes.
 */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** Piped to the command's stdin (how the embedded install.sh travels). */
  stdin?: string;
  /** Kill the command after this long; the result carries code -1. */
  timeoutMs?: number;
  /** Stream stdout as it arrives (for `logs -f` and installer progress). */
  onStdout?: (chunk: string) => void;
}

export interface Transport {
  readonly kind: 'local' | 'ssh';
  /** Human-readable target for messages: 'this machine' or user@host. */
  readonly label: string;
  /** Run `sh -c <command>`; resolves with the exit code, never rejects on non-zero. */
  exec(command: string, opts?: ExecOptions): Promise<ExecResult>;
  /** File content, or null when it does not exist / cannot be read. */
  readFile(path: string): Promise<string | null>;
  /** Deliver a local file to the target (scp over the master when remote). */
  copyTo(localPath: string, destPath: string): Promise<void>;
  dispose(): void;
}

import { execFile } from 'node:child_process';

export class GitError extends Error {
  constructor(
    public readonly args: string[],
    public readonly exitCode: number | null,
    public readonly stderr: string,
  ) {
    super(`git ${args.join(' ')} failed (${exitCode}): ${stderr.trim()}`);
    this.name = 'GitError';
  }
}

/** All puddle git operations go through here: uniform errors, no shell quoting. */
export function git(args: string[], opts: { cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof err.code === 'number' ? err.code : null;
          reject(new GitError(args, code, stderr || err.message));
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

/**
 * Same choke point as `git()`, for callers that need raw bytes: blob reads
 * (`git show <ref>:<path>`) must not go through `git()`'s `.trim()`, which
 * would silently corrupt a file's trailing newline or binary content.
 */
export function gitBuffer(args: string[], opts: { cwd: string }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd: opts.cwd, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer' },
      (err, stdout, stderr) => {
        if (err) {
          const code = typeof err.code === 'number' ? err.code : null;
          const message = Buffer.isBuffer(stderr) ? stderr.toString('utf8') : err.message;
          reject(new GitError(args, code, message || err.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

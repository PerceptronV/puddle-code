import { execFile } from 'node:child_process';

/**
 * Parses `ps -axo pid=,ppid=` output (identical flags/columns on macOS and
 * Linux — one code path) into a ppid → children map. Malformed lines are
 * skipped rather than throwing: a stray header or truncated line shouldn't
 * take down port detection.
 */
export function parsePsOutput(stdout: string): Map<number, number[]> {
  const children = new Map<number, number[]>();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^(\d+)\s+(\d+)$/.exec(trimmed);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const siblings = children.get(ppid);
    if (siblings) siblings.push(pid);
    else children.set(ppid, [pid]);
  }
  return children;
}

/**
 * Every pid reachable from `roots` (inclusive) by following child links, via
 * a single host-wide `ps` snapshot and a BFS. Empty roots short-circuits
 * without exec'ing anything — exited/interrupted sessions cost nothing.
 *
 * Pid reuse between the `ps` snapshot and the caller's use of the result is
 * an accepted race (SPEC §9): the window is milliseconds and the worst case
 * is a stale/missing port entry, not a security issue.
 */
export function descendantsOf(roots: number[]): Promise<Set<number>> {
  if (roots.length === 0) return Promise.resolve(new Set());
  return new Promise((resolve, reject) => {
    execFile('ps', ['-axo', 'pid=,ppid='], { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        reject(err);
        return;
      }
      const childrenOf = parsePsOutput(stdout);
      const seen = new Set<number>(roots);
      const queue = [...roots];
      while (queue.length > 0) {
        const pid = queue.shift()!;
        for (const child of childrenOf.get(pid) ?? []) {
          if (seen.has(child)) continue;
          seen.add(child);
          queue.push(child);
        }
      }
      resolve(seen);
    });
  });
}

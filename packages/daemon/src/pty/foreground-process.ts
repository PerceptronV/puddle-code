import { execFile } from 'node:child_process';

export interface ProcessEntry {
  pid: number;
  parent: number;
  group: number;
  foregroundGroup: number;
  tty: string;
  state: string;
  command: string;
}

/** Shared macOS/Linux ps columns; malformed/incomplete records are ignored. */
export function parseProcessSnapshot(stdout: string): Map<number, ProcessEntry> {
  const entries = new Map<number, ProcessEntry>();
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const entry: ProcessEntry = {
      pid: Number(match[1]),
      parent: Number(match[2]),
      group: Number(match[3]),
      foregroundGroup: Number(match[4]),
      tty: match[5]!,
      state: match[6]!,
      command: match[7]!,
    };
    entries.set(entry.pid, entry);
  }
  return entries;
}

/** One bounded asynchronous snapshot for all terminal sessions, never sent to clients. */
export function readProcessSnapshot(): Promise<Map<number, ProcessEntry>> {
  return processSnapshot(['-axo', PROCESS_COLUMNS], 16 * 1024 * 1024);
}

const PROCESS_COLUMNS = 'pid=,ppid=,pgid=,tpgid=,tty=,stat=,args=';

/** An independent owner inspects only its main PTY, never every process on the host. */
export async function readTerminalProcessSnapshot(
  rootPid: number,
): Promise<Map<number, ProcessEntry>> {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0) throw new Error('Invalid terminal root PID');
  const root = (
    await processSnapshot(['-p', String(rootPid), '-o', PROCESS_COLUMNS], 64 * 1024)
  ).get(rootPid);
  if (!root || !/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,127}$/.test(root.tty)) return new Map();
  const entries = await processSnapshot(['-t', root.tty, '-o', PROCESS_COLUMNS], 512 * 1024);
  if (entries.get(rootPid)?.tty !== root.tty) return new Map();
  return new Map([...entries].filter(([, entry]) => entry.tty === root.tty));
}

function processSnapshot(args: string[], maxBuffer: number): Promise<Map<number, ProcessEntry>> {
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-ww', ...args],
      { encoding: 'utf8', timeout: 2000, maxBuffer },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(parseProcessSnapshot(stdout));
      },
    );
  });
}

/**
 * Foreground jobs and their ancestors, restricted to this PTY's descendants.
 * Keeping ancestors preserves the agent icon while it runs a foreground tool;
 * a background/suspended job or another terminal's agent cannot claim it.
 */
export function foregroundProcesses(
  rootPid: number,
  entries: ReadonlyMap<number, ProcessEntry>,
): ProcessEntry[][] {
  const root = entries.get(rootPid);
  if (!root || /^\?+$/.test(root.tty) || root.foregroundGroup <= 0) return [];
  const paths: ProcessEntry[][] = [];
  for (const entry of entries.values()) {
    if (entry.tty !== root.tty || entry.group !== root.foregroundGroup) continue;
    const path: ProcessEntry[] = [];
    const seen = new Set<number>();
    let current: ProcessEntry | undefined = entry;
    while (current && !seen.has(current.pid)) {
      if (current.tty !== root.tty || /[TtZ]/.test(current.state)) break;
      seen.add(current.pid);
      path.push(current);
      if (current.pid === rootPid) {
        paths.push(path.reverse());
        break;
      }
      current = entries.get(current.parent);
    }
  }
  return paths;
}

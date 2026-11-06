import { execFile } from 'node:child_process';
import { constants, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { connect } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { privatePath } from '@puddle/shared/node';
import { AgentLaunchError } from '../../launch-error.js';

const exec = promisify(execFile);
export interface ClaudeDaemon {
  socket: string;
  auth: string;
}

/** Private, bounded control; a lost mutation reply must never be retried. */
export function claudeJobRequest(
  daemon: Pick<ClaudeDaemon, 'socket'>,
  request: {
    op: 'ping' | 'list' | 'has' | 'kill' | 'resize';
    short?: string;
    cols?: number;
    rows?: number;
    attachId?: string;
  },
): Promise<Record<string, unknown>> {
  privatePath(daemon.socket);
  return new Promise((resolve, reject) => {
    const socket = connect(daemon.socket);
    let buffer = Buffer.alloc(0),
      settled = false;
    const finish = (error?: Error, result?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error('Claude native control timed out')), 2000);
    socket.on('connect', () => socket.end(JSON.stringify({ proto: 1, ...request }) + '\n'));
    socket.on('error', () => finish(new Error('Claude native control is unavailable')));
    socket.on('close', () => finish(new Error('Claude native control reply was lost')));
    socket.on('data', (data) => {
      if (buffer.length + data.length > 1024 * 1024)
        return finish(new Error('Claude native control reply exceeds its limit'));
      buffer = Buffer.concat([buffer, data]);
      const end = buffer.indexOf(10);
      if (end < 0) return;
      try {
        const result = JSON.parse(buffer.subarray(0, end).toString('utf8')) as Record<
          string,
          unknown
        >;
        if (result?.['ok'] !== true || result['op'] !== request.op)
          throw new Error('Native request refused');
        finish(undefined, result);
      } catch {
        finish(new Error('Claude native control did not acknowledge the exact request'));
      }
    });
  });
}

/** Inspect only the account's existing supervisor; never start one as discovery fallback. */
export async function inspectClaudeDaemon(
  configDir: string,
  env?: Record<string, string>,
): Promise<ClaudeDaemon> {
  try {
    const { stdout } = await exec('claude', ['daemon', 'status'], {
      env: { ...process.env, ...env, CLAUDE_CONFIG_DIR: configDir },
      timeout: 5000,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
    });
    const directory = /^\s*sock dir:\s*([^\r\n]+)$/m.exec(stdout)?.[1]?.trim();
    if (!directory || !isAbsolute(directory)) throw new Error('Native socket was not observed');
    privatePath(directory, true);
    const socket = join(directory, 'control.sock');
    privatePath(socket);
    const key = join(configDir, 'daemon', 'control.key');
    privatePath(key);
    const fd = openSync(key, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let auth: string;
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size !== 32) throw new Error('Native control key is unavailable');
      const bytes = Buffer.alloc(33);
      const length = readSync(fd, bytes, 0, bytes.length, 0);
      auth = bytes.subarray(0, length).toString('utf8');
      if (!/^[0-9a-f]{32}$/.test(auth)) throw new Error('Native control key changed');
    } finally {
      closeSync(fd);
    }
    const reply = await claudeJobRequest({ socket }, { op: 'ping' });
    // This private transport is verified against this native release only.
    // A changed supervisor must not be treated as permission for a CLI fallback.
    if (reply['proto'] !== 1 || reply['version'] !== '2.1.318')
      throw new Error('Unverified native supervisor protocol');
    return { socket, auth };
  } catch {
    throw new AgentLaunchError(
      'Cannot verify the Claude background supervisor; leaving its worker untouched',
    );
  }
}

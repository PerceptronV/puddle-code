import {
  hostInfoSchema,
  sessionSchema,
  versionResponseSchema,
  type HostInfo,
  type Session,
  type VersionResponse,
} from '@puddle/shared';
import { sleep } from './net.js';
import { hostPaths } from './paths.js';
import type { Transport } from './transport/transport.js';
import { CliError } from './types.js';

/** Statuses that count as "live" for upgrade-interruption warnings. */
const LIVE = new Set(['starting', 'running', 'waiting_input']);

/**
 * Authenticated client for the daemon API, pointed at 127.0.0.1:<port> —
 * the daemon directly in local mode, the tunnel's local end in SSH mode.
 */
export class DaemonClient {
  constructor(
    private port: number,
    private token: string,
  ) {}

  setPort(port: number): void {
    this.port = port;
  }

  private async get(path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`http://127.0.0.1:${this.port}${path}`, {
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new CliError('daemon_unreachable', 'the puddle daemon is not reachable');
    }
    if (res.status === 401) {
      throw new CliError(
        'token_rejected',
        'the stored token was rejected by the daemon',
        'inspect ~/.puddle/token on the host — it may have been regenerated',
      );
    }
    if (!res.ok) {
      throw new CliError('daemon_unreachable', `the daemon answered ${res.status} for ${path}`);
    }
    return res.json();
  }

  version(): Promise<VersionResponse> {
    return this.get('/api/version').then((body) => versionResponseSchema.parse(body));
  }

  host(): Promise<HostInfo> {
    return this.get('/api/host').then((body) => hostInfoSchema.parse(body));
  }

  sessions(): Promise<Session[]> {
    return this.get('/api/sessions').then((body) => sessionSchema.array().parse(body));
  }

  async liveSessionCount(): Promise<number> {
    return (await this.sessions()).filter((s) => LIVE.has(s.status)).length;
  }

  /** Whether anything daemon-shaped answers /api/version (401 counts as alive). */
  async responds(): Promise<boolean> {
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/api/version`, {
        headers: { authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(2000),
      });
      return res.status < 500;
    } catch {
      return false;
    }
  }
}

/**
 * Where to find the daemon on a host: the live port from runtime.json if the
 * daemon recorded one (it may have fallen back off a busy config port), else
 * config.json's preferred port, else the 7434 default. The caller must still
 * revalidate by token — a runtime.json can be stale after a crash.
 */
export async function readDaemonPort(transport: Transport): Promise<number> {
  const runtime = await transport.readFile(hostPaths.runtime);
  if (runtime !== null) {
    try {
      const parsed = JSON.parse(runtime) as { port?: unknown };
      if (typeof parsed.port === 'number') return parsed.port;
    } catch {
      // malformed runtime file falls through to the configured port
    }
  }
  const raw = await transport.readFile(hostPaths.config);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as { port?: unknown };
      if (typeof parsed.port === 'number') return parsed.port;
    } catch {
      // unreadable config falls through to the default
    }
  }
  return 7434;
}

/** The daemon's browser token, or null before its first start. */
export async function readToken(transport: Transport): Promise<string | null> {
  const raw = await transport.readFile(hostPaths.token);
  const token = raw?.trim() ?? '';
  return /^[0-9a-f]{32,}$/.test(token) ? token : null;
}

/** Poll for the token file a freshly installed daemon writes on first start. */
export async function waitForToken(transport: Transport, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const token = await readToken(transport);
    if (token !== null) return token;
    await sleep(500);
  }
  throw new CliError(
    'daemon_start_timeout',
    `puddled did not come up on ${transport.label}`,
    transport.kind === 'ssh'
      ? `inspect it with: puddle logs ${transport.label}`
      : 'inspect it with: puddle logs',
  );
}

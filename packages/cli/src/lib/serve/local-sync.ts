import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isLocalHostHeader, isLocalOrigin } from './guard.js';

/**
 * The cockpit-local settings-sync store (SPEC §10/§11): one JSON file under
 * the CLIENT machine's ~/.puddle, shared by every cockpit on the box — that is
 * what lets "Sync locally" reach every puddle window regardless of its port
 * (localStorage cannot: localhost:7433 and :7435 are separate origins) or of
 * which daemon it drives. The CLI treats each profile's entry as an opaque
 * JSON object; the web owns its shape and semantics (settings-sync-manifest).
 *
 *   GET /cockpit/local-sync            → the whole file { version, profiles }
 *   PUT /cockpit/local-sync            ← { profile, entry } merges one profile key
 *
 * Same discipline as /cockpit/refresh: localhost Host/Origin plus the daemon
 * bearer token this cockpit proxies for. Writes are read-merge-rename so
 * concurrent cockpits never tear the file (last write per profile key wins).
 */
export interface LocalSyncOptions {
  token: string;
  file: string;
}

interface LocalSyncFile {
  version: 1;
  profiles: Record<string, unknown>;
}

/** An entry may not grow the request beyond this — the file is settings, not storage. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;

function readStore(file: string): LocalSyncFile {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<LocalSyncFile>;
    if (raw && typeof raw === 'object' && raw.profiles && typeof raw.profiles === 'object') {
      return { version: 1, profiles: raw.profiles };
    }
  } catch {
    // Absent or corrupt → empty store; the next write recreates it.
  }
  return { version: 1, profiles: {} };
}

function writeStore(file: string, store: LocalSyncFile): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n');
  renameSync(tmp, file);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function handleLocalSync(
  req: IncomingMessage,
  res: ServerResponse,
  opts: LocalSyncOptions | undefined,
): void {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const fail = (status: number, code: string, message: string) =>
    send(status, { error: { code, message } });

  if (!isLocalHostHeader(req.headers.host) || !isLocalOrigin(req.headers.origin)) {
    return fail(403, 'forbidden_host', 'requests must address localhost');
  }
  if (opts === undefined) {
    return fail(404, 'local_sync_unavailable', 'this cockpit has no local sync store');
  }
  if (req.headers.authorization !== `Bearer ${opts.token}`) {
    return fail(401, 'unauthorised', 'missing or invalid token');
  }

  if (req.method === 'GET') return send(200, readStore(opts.file));

  if (req.method === 'PUT') {
    void readBody(req)
      .then((text) => {
        const body = JSON.parse(text) as { profile?: unknown; entry?: unknown };
        if (typeof body.profile !== 'string' || body.profile === '' || body.entry === undefined) {
          return fail(400, 'bad_request', 'expected { profile: string, entry: object }');
        }
        const store = readStore(opts.file);
        store.profiles[body.profile] = body.entry;
        writeStore(opts.file, store);
        return send(200, store);
      })
      .catch((e: unknown) =>
        e instanceof Error && e.message === 'body_too_large'
          ? fail(413, 'body_too_large', 'sync entry exceeds the size cap')
          : fail(400, 'bad_request', 'body must be JSON'),
      );
    return;
  }

  return fail(405, 'method_not_allowed', 'use GET or PUT');
}

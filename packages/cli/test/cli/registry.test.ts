import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkFrontend,
  frontendLogPath,
  frontendRecordPath,
  listFrontendRecords,
  readFrontendRecord,
  removeFrontendRecord,
  writeFrontendRecord,
  type FrontendRecord,
} from '../../src/lib/registry.js';

const record = (over: Partial<FrontendRecord>): FrontendRecord => ({
  target: 'local',
  pid: process.pid,
  status: 'ready',
  startedAt: new Date().toISOString(),
  cliVersion: 'test',
  ...over,
});

describe('frontend registry', () => {
  let nonceServer: Server;
  let origin: string;

  beforeAll(async () => {
    process.env.PUDDLE_HOME = mkdtempSync(join(tmpdir(), 'puddle-registry-'));
    // A stand-in UI server that echoes the frontend nonce header.
    nonceServer = createServer((req, res) => {
      res.setHeader(req.url === '/legacy/' ? 'x-puddle-cockpit' : 'x-puddle-frontend', 'the-nonce');
      if (req.url === '/conflict/') res.setHeader('x-puddle-cockpit', 'old-nonce');
      res.end();
    });
    await new Promise<void>((r) => nonceServer.listen(0, '127.0.0.1', r));
    const address = nonceServer.address();
    origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    await new Promise((r) => nonceServer.close(r));
    delete process.env.PUDDLE_HOME;
  });

  it('round-trips records and lists them sorted by target', () => {
    writeFrontendRecord(record({ target: 'local' }));
    writeFrontendRecord(record({ target: 'bob@devbox', status: 'starting' }));
    expect(readFrontendRecord('local')?.status).toBe('ready');
    expect(listFrontendRecords().map((r) => r.target)).toEqual(['bob@devbox', 'local']);
    removeFrontendRecord('bob@devbox');
    expect(readFrontendRecord('bob@devbox')).toBeNull();
    removeFrontendRecord('local');
  });

  it('keeps registry filenames filesystem-safe however hostile the target', () => {
    const path = frontendRecordPath('user@host:22/../../evil');
    // The whole target collapses into ONE filename inside the shared registry —
    // no separator survives, so no traversal is possible.
    expect(dirname(path)).toBe(join(process.env.PUDDLE_HOME ?? '', 'cockpits'));
    expect(path.endsWith('.json')).toBe(true);
    expect(basename(frontendLogPath('a b/c'))).not.toContain(' ');
  });

  it('reads existing launcher records without losing identity or exposing old invitations', () => {
    const old = {
      ...record({ launcherPath: '/private/launcher.sock' }),
      daemonLifetime: 'cockpit',
      browserUrl: 'http://localhost/#invite=secret',
    };
    writeFileSync(frontendRecordPath('local'), JSON.stringify(old));
    expect(readFrontendRecord('local')).toMatchObject({
      pid: process.pid,
      launcherPath: old.launcherPath,
      daemonLifetime: 'frontend',
    });
    expect(readFileSync(frontendRecordPath('local'), 'utf8')).not.toContain('secret');
    expect(listFrontendRecords()[0]?.daemonLifetime).toBe('frontend');
    removeFrontendRecord('local');
  });

  it('verifies legacy nonce headers but gives canonical identity precedence', async () => {
    expect(await checkFrontend(record({ origin: origin + '/legacy', nonce: 'the-nonce' }))).toBe(
      'running',
    );
    expect(await checkFrontend(record({ origin: origin + '/conflict', nonce: 'old-nonce' }))).toBe(
      'unverified',
    );
  });

  it('verifies liveness by pid AND nonce, never reachability alone', async () => {
    // Dead pid → dead (the only prunable state), whatever the record claims.
    expect(await checkFrontend(record({ pid: 2 ** 30, origin, nonce: 'the-nonce' }))).toBe('dead');
    // Live pid but the origin answers with a different identity → unverified,
    // never dead: the record is the only handle to a live process.
    expect(await checkFrontend(record({ origin, nonce: 'someone-else' }))).toBe('unverified');
    // Live pid, no listener at all → unverified.
    expect(await checkFrontend(record({ origin: 'http://127.0.0.1:1', nonce: 'x' }))).toBe(
      'unverified',
    );
    // Live pid + matching nonce → running.
    expect(await checkFrontend(record({ origin, nonce: 'the-nonce' }))).toBe('running');
    // Still bootstrapping → starting (no origin to verify yet).
    expect(await checkFrontend(record({ status: 'starting' }))).toBe('starting');
  });
});

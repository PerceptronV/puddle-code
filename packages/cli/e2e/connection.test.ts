import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { requestInvitation } from '../src/lib/auth/launcher.js';
import {
  createSession,
  fixture,
  repository,
  sleep,
  startFixtureDaemon,
  stop,
  until,
  websocket,
} from './helpers.js';

let running: Awaited<ReturnType<typeof fixture>> | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});
const setup = async () => (running = await fixture());

describe('built cockpit and real isolated daemon processes', () => {
  it('exchanges single-use invitations, persists independent browser login and isolates origins', async () => {
    const f = await setup();
    expect((await f.exchange(f.invitation)).status).toBe(401);
    expect((await f.req('/api/version')).status).toBe(200);
    const invitationUrl = await requestInvitation(f.home, f.registry().launcherPath);
    const second = (await (
      await f.exchange(new URLSearchParams(new URL(invitationUrl).hash.slice(1)).get('invite')!)
    ).json()) as { credential: string };
    expect(second.credential).not.toBe(f.credential);
    expect((await f.req('/api/version', {}, second.credential)).status).toBe(200);
    const rejected = await f.req('/cockpit/bootstrap', {
      method: 'POST',
      headers: { origin: 'null' },
      body: JSON.stringify({ invitation: f.invitation }),
    });
    expect(rejected.status).toBe(403);
    expect(
      (await f.req('/cockpit/status', { headers: { origin: 'http://localhost:1' } })).status,
    ).toBe(403);
    expect(
      (
        await fetch(`http://127.0.0.1:${f.uiPort}/api/version`, {
          headers: { authorization: `Bearer ${f.credential}` },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`http://127.0.0.1:${f.port}/api/version`, {
          headers: { authorization: `Bearer ${f.credential}` },
        })
      ).status,
    ).toBe(401);
    const socket = await websocket(f.origin, second.credential);
    const other = await websocket(f.origin, f.credential);
    try {
      const closed = new Promise((resolve) => socket.ws.once('close', resolve));
      expect((await f.req('/cockpit/logout', { method: 'POST' }, second.credential)).status).toBe(
        200,
      );
      await closed;
      expect(other.ws.readyState).toBe(1);
      expect((await f.req('/cockpit/status', {}, second.credential)).status).toBe(401);
      expect((await f.req('/cockpit/status')).status).toBe(200);
    } finally {
      socket.close();
      other.close();
    }
    const disk = readdirSync(join(f.home, 'browser-authority'))
      .map((name) => readFileSync(join(f.home, 'browser-authority', name), 'utf8'))
      .join('');
    const registry = readFileSync(join(f.home, 'cockpits/local.json'), 'utf8');
    for (const value of [f.credential, second.credential, f.invitation]) {
      expect(disk).not.toContain(value);
      expect(registry).not.toContain(value);
    }
    expect(f.cockpit.output()).not.toMatch(/cn_[a-f0-9]{64}/);
    expect(f.cockpit.output()).not.toContain(
      JSON.parse(readFileSync(join(f.home, 'token'), 'utf8')).master,
    );
  });

  it('retains login across a crash and reinitialised browser client', async () => {
    const f = await setup();
    await stop(f.cockpit.child, 'SIGKILL');
    const replacement = f.launch();
    try {
      await until(
        () => replacement.output(),
        (value) => value.includes('Puddle cockpit at'),
      );
      expect((await f.req('/api/version')).status).toBe(200);
      expect(
        (
          await f.req('/cockpit/local-sync', {
            method: 'PUT',
            body: JSON.stringify({ profile: 'test', entry: { theme: 'light' } }),
          })
        ).status,
      ).toBe(200);
      expect(await (await f.req('/cockpit/local-sync')).json()).toMatchObject({
        profiles: { test: { theme: 'light' } },
      });
    } finally {
      await stop(replacement.child);
    }
  });

  it('replaces the actual cockpit, validates correlated readiness and restores canonical terminal replay', async () => {
    const f = await setup();
    const post = async (path: string, body: object) => {
      const response = await f.req(path, { method: 'POST', body: JSON.stringify(body) });
      if (!response.ok) throw new Error(await response.text());
      return response.json() as Promise<Record<string, string | number>>;
    };
    const profile = await post('/api/profiles', { name: 'test' });
    const repo = await post('/api/repos', { path: repository(f.home) });
    const project = await post('/api/projects', {
      name: 'fixture',
      profile_id: profile.id,
      repo_id: repo.id,
    });
    const account = await post('/api/accounts', {
      profile_id: profile.id,
      agent_type: 'fake',
      label: 'test',
    });
    const session = await post('/api/sessions', {
      project_id: project.id,
      account_id: account.id,
      separate_branch: false,
      separate_directory: false,
    });
    const terminal = await websocket(f.origin, f.credential);
    terminal.send({ t: 'attach', session: session.id, term: 'agent', cols: 80, rows: 24 });
    await until(
      () =>
        terminal.messages.some(
          (m) => (m.t === 'replay' || m.t === 'output') && m.data.includes('READY'),
        ),
      Boolean,
    );
    terminal.send({ t: 'stdin', session: session.id, term: 'agent', data: 'once-only\n' });
    await until(
      () => terminal.messages.some((m) => m.t === 'output' && m.data.includes('INPUT:once-only')),
      Boolean,
    );
    const refreshId = crypto.randomUUID();
    const refresh = () =>
      f.req('/cockpit/refresh', { method: 'POST', body: JSON.stringify({ refreshId }) });
    const [a, b] = await Promise.all([refresh(), refresh()]);
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    const accepted = (await a.json()) as { instance: string; refreshId: string };
    expect(await b.json()).toEqual({ status: 'refreshing', ...accepted });
    terminal.close();
    const state = await until(
      async () => {
        try {
          const response = await f.req('/cockpit/status');
          return response.ok
            ? ((await response.json()) as { instance: string; refreshId: string; upstream: string })
            : null;
        } catch {
          return null;
        }
      },
      (state) =>
        !!state &&
        state.instance !== accepted.instance &&
        state.refreshId === refreshId &&
        state.upstream === 'ready',
    );
    expect(state!.instance).not.toBe(accepted.instance);
    expect((await f.req('/api/version')).status).toBe(200);
    const restored = await websocket(f.origin, f.credential);
    try {
      restored.send({ t: 'attach', session: session.id, term: 'agent', cols: 80, rows: 24 });
      const replay = await until(() => restored.messages.find((m) => m.t === 'replay'), Boolean);
      expect(replay && 'data' in replay && replay.data).toContain('INPUT:once-only');
      expect(replay && 'data' in replay && replay.data.match(/INPUT:once-only/g)).toHaveLength(1);
      await sleep(100);
      expect(
        restored.messages.filter((m) => m.t === 'output' && m.data.includes('INPUT:once-only')),
      ).toHaveLength(0);
    } finally {
      restored.close();
    }
    const log = readFileSync(join(f.home, 'logs/cockpit-local.log'), 'utf8');
    expect(log).not.toMatch(/(?:cn_|br_|iv_)[a-f0-9]{64}/);
  });

  it('keeps local controls and browser authority through an outage and a changed daemon port', async () => {
    const f = await setup();
    await stop(f.daemon);
    await until(
      async () => (await f.req('/cockpit/status')).json() as Promise<{ upstream: string }>,
      (state) => state.upstream !== 'ready',
    );
    const response = await f.req('/api/version');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'upstream_unavailable' } });
    expect((await f.req('/cockpit/local-sync')).status).toBe(200);
    expect((await f.req('/cockpit/status')).status).toBe(200);
    const replacement = await startFixtureDaemon(f.home);
    try {
      expect(replacement.port).not.toBe(f.port);
      await until(f.state, (state) => state.upstream === 'ready');
      expect((await f.req('/api/version')).status).toBe(200);
      const reattached = await websocket(f.origin, f.credential);
      reattached.close();
    } finally {
      await stop(replacement.daemon);
    }
  });
  it('streams multipart uploads and byte-exact downloads through the authenticated gateway', async () => {
    const f = await setup();
    const session = await createSession(f);
    const data = Uint8Array.from({ length: 256 * 1024 }, (_, i) => i % 251);
    const form = new FormData();
    form.set('file', new File([data], 'transfer.bin'));
    const uploaded = await fetch(`${f.origin}/api/worktrees/${session.id}/upload?dir=.`, {
      method: 'POST',
      headers: { origin: f.origin, authorization: `Bearer ${f.credential}` },
      body: form,
    });
    expect(uploaded.status).toBe(201);
    const downloaded = await f.req(`/api/worktrees/${session.id}/download?path=transfer.bin`);
    expect(downloaded.status).toBe(200);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(data);
  });
});

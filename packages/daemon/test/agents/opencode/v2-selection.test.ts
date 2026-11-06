import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { OPENCODE_V2_PLUGIN_SOURCE } from '../../../src/agents/opencode/v2-plugin.js';
import { OPENCODE_V2_TURNS_SOURCE } from '../../../src/agents/opencode/v2-turns.js';
import { agentSignalRequestSchema } from '@puddle/shared';

const homes: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
async function fixture(
  initial: { type: string; sessionID?: string } = { type: 'session', sessionID: 'original' },
) {
  const home = mkdtempSync(join(tmpdir(), 'puddle-opencode-selection-'));
  homes.push(home);
  writeFileSync(join(home, 'puddle-sync-v2.mjs'), OPENCODE_V2_PLUGIN_SOURCE);
  writeFileSync(join(home, 'puddle-sync-v2-turns.mjs'), OPENCODE_V2_TURNS_SOURCE);
  vi.stubEnv('PUDDLE_AGENT_SIGNAL_URL', 'http://fixture.invalid');
  vi.stubEnv('PUDDLE_AGENT_SIGNAL_NONCE', 'fixture-nonce-0123456789');
  const signals: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      const signal = JSON.parse(options.body);
      agentSignalRequestSchema.parse(signal);
      signals.push(signal);
      return new Response(null, { status: 204 });
    }),
  );
  let route = initial,
    render!: () => void,
    listen!: (event: unknown) => void;
  const infos = new Map<string, Record<string, unknown>>();
  const info = (id: string, extra: object = {}) => ({
    id,
    location: { directory: '/fixture' },
    time: { created: 1000, updated: 1000 },
    ...extra,
  });
  infos.set('original', info('original'));
  const get = vi.fn(async ({ sessionID }: { sessionID: string }) => info(sessionID));
  const create = vi.fn(async () => info('fresh'));
  const navigate = vi.fn((next: typeof route) => {
    route = next;
    render();
  });
  const context = {
    app: { version: '2.2.5' },
    location: { directory: '/fixture' },
    client: { session: { get, create } },
    ui: { router: { current: () => ({ ...route }), navigate } },
    data: {
      listen: (fn: typeof listen) => {
        listen = fn;
        return () => {};
      },
      session: { get: (id: string) => infos.get(id) },
      location: { default: () => ({ directory: '/fixture' }) },
    },
  };
  const { PuddleSyncV2 } = await import(pathToFileURL(join(home, 'puddle-sync-v2.mjs')).href);
  const close = PuddleSyncV2(context, {
    createRoot: (fn: (dispose: () => void) => unknown) => fn(() => {}),
    createEffect: (fn: () => void) => {
      render = fn;
      render();
    },
  });
  const settle = () => vi.waitFor(() => expect(signals.length).toBeGreaterThan(0));
  await settle();
  return {
    signals,
    create,
    get,
    navigate,
    info,
    infos,
    render: () => render(),
    close,
    event: (type: string, data: object) => listen({ details: { type, data } }),
    go: (next: typeof route) => {
      route = next;
      render();
    },
  };
}

it('creates one native identity for a managed home route and a separate one after /new', async () => {
  const f = await fixture({ type: 'home' });
  expect(f.create).toHaveBeenCalledOnce();
  expect(f.signals[0]).toMatchObject({
    event: 'session_start',
    agent_session_ref: 'fresh',
    source: 'startup',
  });
  f.render();
  f.render();
  expect(f.create).toHaveBeenCalledOnce();
  f.create.mockResolvedValueOnce(f.info('second'));
  f.go({ type: 'home' });
  await vi.waitFor(() =>
    expect(f.signals.some((s) => s.agent_session_ref === 'second')).toBe(true),
  );
  expect(f.create).toHaveBeenCalledTimes(2);
  expect(f.signals.at(-1)).toMatchObject({ source: 'clear' });
  f.close();
});
it('ignores read watermarks, child sessions and unrelated metadata; recognises a selected native fork', async () => {
  const f = await fixture();
  f.event('session.created', { sessionID: 'unrelated' });
  f.event('session.viewed', { sessionID: 'unrelated' });
  f.event('session.created', { sessionID: 'child', parentID: 'original' });
  expect(f.signals).toHaveLength(1);
  f.infos.set('fork', f.info('fork', { fork: { sessionID: 'original' } }));
  f.go({ type: 'session', sessionID: 'fork' });
  await vi.waitFor(() => expect(f.signals).toHaveLength(2));
  expect(f.signals[1]).toMatchObject({
    source: 'fork',
    parent_agent_session_ref: 'original',
    agent_session_ref: 'fork',
  });
  f.go({ type: 'session', sessionID: 'original' });
  await vi.waitFor(() => expect(f.signals).toHaveLength(3));
  expect(f.signals[2]).toMatchObject({ source: 'resume' });
  f.close();
});
it('does not publish a delayed selection after another route overtakes it', async () => {
  const f = await fixture();
  let finish!: (value: unknown) => void;
  f.get.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.go({ type: 'session', sessionID: 'late' });
  f.infos.set('new', f.info('new'));
  f.go({ type: 'session', sessionID: 'new' });
  finish(f.info('late'));
  await vi.waitFor(() => expect(f.signals).toHaveLength(2));
  expect(f.signals.at(-1)).toMatchObject({ agent_session_ref: 'new' });
  f.close();
});
it('does not navigate after a pending home creation is overtaken or disposed', async () => {
  const f = await fixture();
  let finish!: (value: unknown) => void;
  f.create.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.go({ type: 'home' });
  f.go({ type: 'session', sessionID: 'original' });
  f.close();
  finish(f.info('orphan'));
  await new Promise((resolve) => setImmediate(resolve));
  expect(f.navigate).not.toHaveBeenCalled();
});

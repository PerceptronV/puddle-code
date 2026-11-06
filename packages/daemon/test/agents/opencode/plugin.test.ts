import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { OPENCODE_PLUGIN_SOURCE } from '../../../src/agents/opencode/plugin.js';
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it('does not admit old input after a new selection overtakes its lifecycle acknowledgement', async () => {
  vi.stubEnv('PUDDLE_AGENT_SIGNAL_URL', 'http://fixture.invalid');
  vi.stubEnv('PUDDLE_AGENT_SIGNAL_NONCE', randomUUID());
  const signals: Array<Record<string, unknown>> = [];
  let release!: () => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      signals.push(body);
      if (body.agent_session_ref === 'original')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return new Response(null, { status: 204 });
    }),
  );
  const plugin = await import(
    `data:text/javascript;base64,${Buffer.from(OPENCODE_PLUGIN_SOURCE).toString('base64')}`
  );
  const hooks = await plugin.PuddleSync({
    directory: '/fixture',
    client: {
      session: {
        get: async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }),
      },
    },
  });
  const pending = hooks['chat.message'](
    { sessionID: 'original' },
    { message: { id: 'input' }, parts: [] },
  );
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  await hooks.event({ event: { type: 'session.created', properties: { info: { id: 'new' } } } });
  release();
  await pending;
  expect(signals.map((body) => [body.event, body.agent_session_ref])).toEqual([
    ['session_start', 'original'],
    ['session_start', 'new'],
  ]);
});
it.each(['resolved', 'rejected'] as const)(
  'fences %s late replies and unrelated session metadata',
  async (outcome) => {
    vi.stubEnv('PUDDLE_AGENT_SIGNAL_URL', 'http://fixture.invalid');
    vi.stubEnv('PUDDLE_AGENT_SIGNAL_NONCE', randomUUID());
    const signals: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, options) => {
        signals.push(JSON.parse(options.body));
        return new Response(null, { status: 204 });
      }),
    );
    let complete!: (value: unknown) => void;
    let fail!: (error: Error) => void;
    const message = vi.fn(
      () =>
        new Promise((resolve, reject) => {
          complete = resolve;
          fail = reject;
        }),
    );
    const get = vi.fn(async ({ path }: { path: { id: string } }) => ({ data: { id: path.id } }));
    const plugin = await import(
      `data:text/javascript;base64,${Buffer.from(OPENCODE_PLUGIN_SOURCE).toString('base64')}`
    );
    const hooks = await plugin.PuddleSync({
      directory: '/fixture',
      client: { session: { message, get } },
    });
    const event = (type: string, properties: unknown) =>
      hooks.event({ event: { type, properties } });
    const chat = (sessionID: string) =>
      hooks['chat.message'](
        { sessionID },
        {
          message: { id: 'input' },
          parts: [{ type: 'text', text: 'synthetic prompt' }],
        },
      );
    await event('session.created', { info: { id: 'original' } });
    await chat('original');
    await event('message.updated', {
      info: {
        id: 'answer',
        role: 'assistant',
        sessionID: 'original',
        parentID: 'input',
        finish: 'stop',
        time: { completed: 1 },
      },
    });
    const finishing = event('session.status', { sessionID: 'original', status: { type: 'idle' } });
    await vi.waitFor(() => expect(message).toHaveBeenCalledOnce());
    await chat('resumed'); // resumed conversation was not created in this process
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ path: { id: 'resumed' } }));
    const count = signals.length;
    await event('session.updated', { info: { id: 'original', title: 'old title changed' } });
    await event('session.status', { sessionID: 'original', status: { type: 'idle' } });
    await event('session.created', { info: { id: 'child', parentID: 'resumed' } });
    expect(signals).toHaveLength(count);
    if (outcome === 'rejected') fail(new Error('late native read failure'));
    else
      complete({
        data: {
          info: { parentID: 'input', finish: 'stop' },
          parts: [{ type: 'text', text: 'late answer' }],
        },
      });
    await finishing;
    expect(signals).toHaveLength(count);
    await event('session.deleted', { info: { id: 'original' } });
    expect(signals).toHaveLength(count);
    await event('session.deleted', { info: { id: 'resumed' } });
    expect(signals.at(-1)).toMatchObject({ event: 'session_end', agent_session_ref: 'resumed' });
  },
);

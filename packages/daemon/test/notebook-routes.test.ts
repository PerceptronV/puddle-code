import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { notebookRoutes } from '../src/http/routes/notebooks.js';
import { ApiError } from '../src/http/errors.js';

it('validates notebook targets and lifecycle actions before dispatch', async () => {
  const source = {
    session: '00000000-0000-0000-0000-000000000000',
    root: '/source',
    path: 'analysis.ipynb',
  };
  const catalogue = vi.fn(async () => ({ available: true, kernels: [] }));
  const status = vi.fn(async () => ({ state: 'stopped' as const, kernel: null }));
  const action = vi.fn(async () => ({ state: 'idle' as const, kernel: 'python3' }));
  const app = new Hono();
  app.onError((error, c) =>
    c.json({ error: String(error) }, error instanceof ApiError ? (error.status as 400) : 500),
  );
  app.route('/api/notebooks', notebookRoutes({ catalogue, status, action }));
  const post = (path: string, body: unknown) =>
    app.request(`/api/notebooks/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  expect((await app.request('/api/notebooks/kernels')).status).toBe(200);
  expect((await post('status', { source })).status).toBe(200);
  expect((await post('kernel', { source, action: 'select', kernel: 'python3' })).status).toBe(200);
  expect(action).toHaveBeenLastCalledWith({ source, action: 'select', kernel: 'python3' });
  for (const body of [
    { source, action: 'execute' },
    { source, action: 'select' },
    { action: 'interrupt' },
    { source: { ...source, session: 'invalid' }, action: 'shutdown' },
  ])
    expect((await post('kernel', body)).status).toBe(400);
  expect(action).toHaveBeenCalledTimes(1);
});

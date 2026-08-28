import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  compilationCapabilitiesResponseSchema,
  compilationRunResponseSchema,
  compilationStatusResponseSchema,
} from '@puddle/shared';
import type { CompilationProvider } from '../src/compilation/provider.js';
import { CompilationService } from '../src/compilation/service.js';
import { ApiError } from '../src/http/errors.js';
import { compilationRoutes } from '../src/http/routes/compilation.js';

const source = {
  session: '00000000-0000-0000-0000-000000000000',
  path: 'paper.tex',
  root: '/source',
};

function fixture() {
  const provider: CompilationProvider = {
    id: 'latex',
    displayName: 'LaTeX',
    extensions: ['tex'],
    inputExtensions: ['tex', 'bib', 'sty', 'cls', 'bst'],
    eager: true,
    capability: () => ({ available: true, executor: 'latexmk' }),
    watchInputs: () => [],
    run: async (target) => ({
      executor: 'latexmk',
      source: target,
      artifacts: [
        {
          role: 'preview',
          media_type: 'application/pdf',
          file: { session: target.session, path: 'paper.pdf', root: '/state/latex/build' },
        },
      ],
      navigation: { kind: 'synctex' },
      dependencies: [],
    }),
  };
  const compilation = new CompilationService([provider]);
  const app = new Hono();
  app.onError((error, c) =>
    error instanceof ApiError
      ? c.json({ error: { code: error.code, message: error.message } }, error.status as 400)
      : c.json({ error: { code: 'internal', message: String(error) } }, 500),
  );
  app.route('/api/compilation', compilationRoutes({ compilation }));
  return { app, compilation };
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  };
}

describe('compilation routes', () => {
  it('reports provider availability and performs an on-demand run', async () => {
    const { app, compilation } = fixture();
    const capabilities = compilationCapabilitiesResponseSchema.parse(
      await (await app.request('/api/compilation/capabilities')).json(),
    );
    expect(capabilities.providers).toEqual([
      {
        id: 'latex',
        display_name: 'LaTeX',
        extensions: ['tex'],
        input_extensions: ['tex', 'bib', 'sty', 'cls', 'bst'],
        available: true,
        executor: 'latexmk',
        eager: true,
      },
    ]);

    const response = await app.request('/api/compilation/run', jsonRequest('POST', { source }));
    expect(response.status).toBe(200);
    expect(compilationRunResponseSchema.parse(await response.json())).toMatchObject({
      provider: 'latex',
      executor: 'latexmk',
      revision: 1,
      navigation: { kind: 'synctex' },
      artifacts: [{ role: 'preview', media_type: 'application/pdf' }],
    });
    compilation.dispose();
  });

  it('registers eager mode, exposes pollable status, and retires the watcher', async () => {
    const { app, compilation } = fixture();
    const eager = await app.request(
      '/api/compilation/mode',
      jsonRequest('PUT', { source, mode: 'eager' }),
    );
    expect(compilationStatusResponseSchema.parse(await eager.json())).toMatchObject({
      provider: 'latex',
      mode: 'eager',
      state: 'succeeded',
      revision: 1,
    });
    const status = await app.request('/api/compilation/status', jsonRequest('POST', { source }));
    expect(compilationStatusResponseSchema.parse(await status.json()).mode).toBe('eager');
    const retired = await app.request(
      '/api/compilation/mode',
      jsonRequest('PUT', { source, mode: 'on_demand' }),
    );
    expect(compilationStatusResponseSchema.parse(await retired.json()).mode).toBe('on_demand');
    compilation.dispose();
  });

  it('validates requests at the route boundary', async () => {
    const { app, compilation } = fixture();
    const response = await app.request(
      '/api/compilation/run',
      jsonRequest('POST', { source: { session: 'not-a-session', path: '' } }),
    );
    expect(response.status).toBe(400);
    compilation.dispose();
  });
});

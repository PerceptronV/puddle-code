import { expect, it } from 'vitest';
import { permittedRequest } from '../../src/policy.js';

it('permits only the exact read-only public release-notes route without maintenance authority', () => {
  const request = {
    t: 'request' as const,
    id: crypto.randomUUID(),
    method: 'GET' as const,
    path: '/api/release-notes',
  };
  expect(permittedRequest(request)).toMatchObject({ method: 'GET', path: request.path });
  for (const path of [
    '/api/release-notes/file',
    '/api/release-notes?path=/private',
    '/api/release-notes?version=0.4.0',
    '/api/%72elease-notes',
  ])
    expect(() => permittedRequest({ ...request, path })).toThrow();
  expect(() => permittedRequest({ ...request, method: 'POST' })).toThrow();
  expect(() => permittedRequest({ ...request, body: { path: '/private' } })).toThrow();
});

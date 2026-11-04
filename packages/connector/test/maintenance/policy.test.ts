import { expect, it } from 'vitest';
import { permittedRequest } from '../../src/policy.js';

const reference = { id: crypto.randomUUID(), revision: 3 };
const fingerprint = 'a'.repeat(64);
const request = (body: unknown, path = '/api/host/updates', allowed = true) =>
  permittedRequest({ t: 'request', id: crypto.randomUUID(), method: 'POST', path, body }, allowed);

it('accepts only bounded online maintenance actions, including exact interruption and recovery approval', () => {
  for (const body of [
    { action: 'prepare', targets: [{ component: 'daemon', version: '0.4.1' }] },
    { action: 'inspect', reference },
    { action: 'apply', reference, fingerprint, interruption_approval: fingerprint },
    { action: 'cancel', reference },
    { action: 'recover', reference, strategy: 'verify-completion' },
    { action: 'recover', reference, strategy: 'continue' },
  ])
    expect(request(body).maintenance).toEqual(body);
  expect(
    permittedRequest(
      {
        t: 'request',
        id: crypto.randomUUID(),
        method: 'GET',
        path: `/api/host/updates?id=${reference.id}`,
      },
      true,
    ).maintenance,
  ).toEqual({ action: 'status', id: reference.id });
});

it('denies ordinary pairing, offline execution, identity substitution and neighbouring HTTP routes', () => {
  const inspect = { action: 'inspect', reference };
  expect(() => request(inspect, undefined, false)).toThrow('host-approved');
  for (const body of [
    { action: 'continue-offline', reference },
    { action: 'stage', reference, receipt: {} },
    { action: 'begin', targets: [] },
    { action: 'status' },
    { ...inspect, profile: '0123456789' },
    { ...inspect, device: crypto.randomUUID() },
    { ...inspect, command: 'anything' },
    { ...inspect, receipt: {} },
    { ...inspect, repository: 'other/repository' },
  ])
    expect(() => request(body)).toThrow();
  for (const path of [
    '/cockpit/updates',
    '/api/host/updates/apply',
    '/api/host/updates?profile=0123456789',
    '/api/host/updates?path=/tmp',
    '/api/host/%75pdates',
    '/api/host/updates#fragment',
    '/api/host/updates?id=' + reference.id,
  ])
    expect(() => request(inspect, path)).toThrow();
  expect(() =>
    permittedRequest(
      {
        t: 'request',
        id: crypto.randomUUID(),
        method: 'GET',
        path: '/api/host/updates?adoption_nonce=' + reference.id,
      },
      true,
    ),
  ).toThrow();
});

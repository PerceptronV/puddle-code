import { expect, it } from 'vitest';
import {
  remoteOriginSchema,
  cockpitRemoteRequestSchema,
  remoteServiceInfoSchema,
} from '../src/index.js';

it('rejects the previous email-login service contract', () => {
  expect(
    remoteServiceInfoSchema.safeParse({ providers: ['google'], email: true, protocol: 1 }).success,
  ).toBe(false);
});

it.each([
  '',
  'https://',
  'relay.example.test',
  '/relative',
  'http://relay.example.test',
  'https://relay.example.test/path',
])('validates an incomplete or invalid origin without throwing: %s', (value) => {
  expect(remoteOriginSchema.safeParse(value).success).toBe(false);
});

it('requires all registration fields together and keeps host selection out of browser commands', () => {
  expect(cockpitRemoteRequestSchema.safeParse({ t: 'enable' }).success).toBe(true);
  expect(
    cockpitRemoteRequestSchema.safeParse({ t: 'enable', registration: { code: 'a'.repeat(64) } })
      .success,
  ).toBe(false);
  expect(cockpitRemoteRequestSchema.safeParse({ t: 'disable', host: 'someone-else' }).success).toBe(
    false,
  );
});

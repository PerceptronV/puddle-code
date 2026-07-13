import { describe, expect, it } from 'vitest';
import {
  createSessionRequestSchema,
  errorResponseSchema,
  profileSettingsSchema,
  sessionStatusSchema,
  wsClientMessageSchema,
} from '../src/index.js';

describe('shared API schemas', () => {
  it('accepts a well-formed error envelope and rejects a malformed one', () => {
    const parsed = errorResponseSchema.parse({
      error: { code: 'not_found', message: 'no such profile' },
    });
    expect(parsed.error.code).toBe('not_found');
    expect(errorResponseSchema.safeParse({ error: { message: 'x' } }).success).toBe(false);
  });

  it('profile settings default the permissions gate to off and keep unknown keys', () => {
    const s = profileSettingsSchema.parse({ theme: 'dark' });
    expect(s.allowSkipPermissions).toBe(false);
    expect((s as Record<string, unknown>).theme).toBe('dark');
  });

  it('session status is a closed enum', () => {
    expect(sessionStatusSchema.safeParse('running').success).toBe(true);
    expect(sessionStatusSchema.safeParse('paused').success).toBe(false);
  });

  it('create-session accepts optional prompt and skip flag', () => {
    const r = createSessionRequestSchema.parse({ project_id: 1, account_id: 2, prompt: 'go' });
    expect(r.skip_permissions).toBeUndefined();
  });

  it('ws client messages discriminate on t and validate term ids', () => {
    expect(
      wsClientMessageSchema.parse({ t: 'attach', session: 'x', term: 'agent', cols: 80, rows: 24 })
        .t,
    ).toBe('attach');
    expect(wsClientMessageSchema.safeParse({ t: 'attach', term: 'agent' }).success).toBe(false);
    expect(
      wsClientMessageSchema.safeParse({ t: 'stdin', session: 'x', term: 'nope', data: 'y' })
        .success,
    ).toBe(false);
  });
});

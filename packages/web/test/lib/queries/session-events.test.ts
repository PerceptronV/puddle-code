import { QueryClient } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { applySessionStatus, applySessionRename } from '../../../src/lib/queries/session-events';

it('updates all cached lists from pushes without invalidation or network requests', () => {
  const client = new QueryClient();
  const session = {
    id: 'session',
    status: 'running',
    title: 'before',
    agent_title: 'native',
    osc_title: 'terminal',
  };
  client.setQueryData(['sessions', 'profile'], [session]);
  client.setQueryData(['project', 'project'], { sessions: [session] });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  applySessionStatus(client, {
    session: 'session',
    status: 'waiting_input',
    last_activity_at: null,
  });
  applySessionRename(client, { session: 'session', title: 'after' });
  const expected = { ...session, status: 'waiting_input', last_activity_at: null, title: 'after' };
  expect(client.getQueryData(['sessions', 'profile'])).toEqual([expected]);
  expect(client.getQueryData(['project', 'project'])).toEqual({ sessions: [expected] });
  expect(invalidate).not.toHaveBeenCalled();
  applySessionRename(client, {
    session: 'session',
    title: null,
    agent_title: null,
    osc_title: null,
  });
  expect(client.getQueryData(['sessions', 'profile'])).toEqual([
    { ...expected, title: null, agent_title: null, osc_title: null },
  ]);
  client.clear();
});

import { describe, expect, it } from 'vitest';
import type { AgentNotification } from '@puddle/shared';
import { ProfileAccess } from '../src/security/profile-access.js';
import { fixture, waitFor } from './helpers/daemon-fixtures.js';

describe('agent notification events', () => {
  it('reports waiting and a clean process exit, but keeps deliberate stops quiet', async () => {
    const f = fixture();
    const events: AgentNotification[] = [];
    f.service.on('agent-notification', (event: AgentNotification) => events.push(event));
    const session = await f.service.create({
      project_id: f.ids.project,
      account_id: f.ids.account,
    });
    await waitFor(() => events.some((event) => event.reason === 'waiting_input'));
    f.ptys.write(session.id, 'agent', '\x04');
    await waitFor(() => f.service.get(session.id).status === 'exited');
    expect(events.map((event) => event.reason)).toEqual(['waiting_input', 'exited']);
    expect(new Set(events.map((event) => event.id)).size).toBe(2);
    const access = new ProfileAccess(f.stores);
    expect(access.event(f.ids.profile, events[0]!)).toEqual(events[0]);
    expect(access.event('other-profile', events[0]!)).toBeNull();
    await f.service.resume(session.id);
    await waitFor(() => f.service.get(session.id).status === 'waiting_input');
    const before = events.length;
    await f.service.kill(session.id);
    await waitFor(() => f.service.get(session.id).status === 'exited');
    expect(events).toHaveLength(before);
  });
});
